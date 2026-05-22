import { basename, resolve, join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { BaseToolController } from './base/BaseToolController.js';
import { StateManager, Phase, ProcessStateWriter } from '@utaba/deep-memory-indexer';
import type { PipelinePhase, IndexSourceStatus, ProcessPhase, IndexProcessConfig } from '@utaba/deep-memory-indexer';
import { resolveStateDir } from './resolveProcess.js';

const VALID_PHASES: PipelinePhase[] = [
  Phase.PREPARE,
  Phase.EXTRACT,
  Phase.EXTRACTION_REVIEW,
  'full-validation' as PipelinePhase,
  Phase.CONSOLIDATE,
  'consolidation-review' as PipelinePhase,
  Phase.IMPORT,
  Phase.IMPORT_REVIEW,
  Phase.EMBEDDINGS,
  Phase.COMPLETE,
];

const VALID_STATUSES: IndexSourceStatus[] = ['pending', 'extracting', 'deduplicating', 'extracted', 'consolidated', 'imported', 'validated', 'excluded'];

/**
 * Control tool for navigating the indexing pipeline and updating source configuration.
 *
 * Primary use is **phase transitions** — moving the pipeline forward to the next phase,
 * or back to a previous phase when rework is needed. Phase movement is intentionally
 * separated from `indexing_execute` because advancing or rewinding the pipeline is a
 * deliberate human decision, not an automatic side effect of running a phase.
 */
export class UpdateTool extends BaseToolController {
  get name() { return 'indexing_update'; }
  get description() { return 'Move between pipeline phases and update source document configuration. Use this to advance to the next phase after reviewing diagnostics, move back to a previous phase for rework, exclude/reassign sources, or reset failed sources for retry.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory (contains config.json).' },
        stateDir: { type: 'string', description: 'Use only for standalone state directories not inside a processDir. When processDir is provided, stateDir is resolved automatically to processDir/state/.' },
        phase: {
          type: 'string',
          description: `Set the pipeline phase. Valid phases: ${VALID_PHASES.join(', ')}. Use to advance (e.g., "consolidate" after extraction review) or move back (e.g., "extraction-review" after discovering issues).`,
        },
        source: { type: 'string', description: 'Source document path or filename to update (required when updating source fields).' },
        sourceStatus: {
          type: 'string',
          description: `New status for source: ${VALID_STATUSES.join(', ')}. WARNING: "excluded" permanently removes the source from the pipeline. "pending" clears extraction artifacts and requires re-extraction.`,
        },
        sourceWorkers: { type: 'string', description: 'Comma-separated worker names to assign for extraction (e.g., "cloud-haiku,qwen35-35b").' },
        sourceSelectedExtraction: { type: 'string', description: 'Worker name whose extraction output to select for downstream phases. Sets selectedExtraction from extractionFiles.' },
        sourceStatusReason: { type: 'string', description: 'Reason for the status change (logged in source list).' },
        clearError: { type: 'boolean', description: 'Clear error state and reset attempts on the specified source.' },
        sourceOrder: { type: ['number', 'string'], description: 'Reorder source in the list: a number (0-based index), or "start", "end", "up", "down". Requires source parameter.' },
        qualityThresholds: {
          type: 'object',
          description: 'Update quality thresholds in config.json. Partial updates supported — only specified fields are changed. Example: { "extraction": { "orphanRate": { "good": 0, "acceptable": 1 } } }',
          properties: {
            extraction: {
              type: 'object',
              properties: {
                propertyCoverage: { type: 'object', properties: { good: { type: 'number' }, acceptable: { type: 'number' } } },
                orphanRate: { type: 'object', properties: { good: { type: 'number' }, acceptable: { type: 'number' } } },
                truncationRate: { type: 'object', properties: { good: { type: 'number' }, acceptable: { type: 'number' } } },
              },
            },
            consolidation: {
              type: 'object',
              properties: {
                mergeConfidence: { type: 'object', properties: { high: { type: 'number' }, medium: { type: 'number' } } },
                shortAliasLength: { type: 'number' },
                propertyOverlapMinimum: { type: 'number' },
                typeConsistencyMaxAcceptable: { type: 'number' },
              },
            },
          },
        },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const phase = params['phase'] as string | undefined;
    const source = params['source'] as string | undefined;
    const qualityThresholds = params['qualityThresholds'] as Record<string, unknown> | undefined;

    if (!phase && !source && !qualityThresholds) {
      throw new Error('Specify at least one of: phase (to change pipeline phase), source (to update a source document), or qualityThresholds (to update quality thresholds).');
    }

    const results: unknown[] = [];

    // Handle phase transition
    if (phase) {
      results.push(await this.setPhase(params, phase));
    }

    // Handle source update
    if (source) {
      results.push(await this.updateSource(params, source));
    }

    // Handle quality threshold update
    if (qualityThresholds) {
      results.push(await this.updateQualityThresholds(params, qualityThresholds));
    }

    if (results.length > 1) {
      return {
        actions: results,
        message: results.map(r => (r as { message?: string }).message).filter(Boolean).join('. '),
      };
    }

    return results[0];
  }

  private async setPhase(params: Record<string, unknown>, targetPhase: string) {
    if (!VALID_PHASES.includes(targetPhase as PipelinePhase)) {
      throw new Error(`Invalid phase "${targetPhase}". Valid phases: ${VALID_PHASES.join(', ')}`);
    }

    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const previousPhase = await state.getCurrentPhase();

    // Clear stale validation state when entering full-validation phase
    if (targetPhase === 'full-validation') {
      await state.clearFullValidationState();
    }

    await state.setPipelineState(targetPhase as PipelinePhase);

    // Update process-state.md if processDir is provided
    const processDir = params['processDir'] as string | undefined;
    if (processDir) {
      const processPhase = pipelineToProcessPhase(targetPhase as PipelinePhase);
      if (processPhase) {
        const stateWriter = new ProcessStateWriter(processDir);
        await stateWriter.updatePhase(processPhase);
      }
    }

    return {
      action: 'set-phase',
      previousPhase,
      currentPhase: targetPhase,
      message: `Pipeline phase changed from "${previousPhase}" to "${targetPhase}".`,
      guidance: `Run indexing_execute to proceed with ${targetPhase}, or indexing_analyze to review the current state.`,
    };
  }

  private async updateSource(params: Record<string, unknown>, sourceQuery: string) {
    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);

    const sourceList = await state.getSourceList();
    if (!sourceList) throw new Error('No source list found. Run indexing_execute to prepare sources first.');

    const source = findSource(sourceList.sources, sourceQuery);
    const changes: string[] = [];
    const fieldUpdates: Record<string, unknown> = {};

    const newStatus = params['sourceStatus'] as string | undefined;
    const newWorkers = params['sourceWorkers'] as string | undefined;
    const selectedExtraction = params['sourceSelectedExtraction'] as string | undefined;
    const statusReason = params['sourceStatusReason'] as string | undefined;
    const clearError = params['clearError'] as boolean | undefined;
    const sourceOrder = params['sourceOrder'] as number | string | undefined;

    if (newStatus) {
      if (!VALID_STATUSES.includes(newStatus as IndexSourceStatus)) {
        throw new Error(`Invalid status "${newStatus}". Valid: ${VALID_STATUSES.join(', ')}`);
      }
      fieldUpdates.status = newStatus;
      changes.push(`status → ${newStatus}`);
    }
    if (statusReason !== undefined) {
      fieldUpdates.statusReason = statusReason;
      changes.push(`statusReason → "${statusReason}"`);
    }
    if (newWorkers !== undefined) {
      const workerList = newWorkers.split(',').map(w => w.trim()).filter(Boolean);
      fieldUpdates.assignedWorkers = workerList;
      changes.push(`assignedWorkers → [${workerList.join(', ')}]`);
    }
    if (selectedExtraction !== undefined) {
      // Look up the extraction file path from extractionFiles
      const extractionFiles = source.extractionFiles ?? {};
      const extractionPath = extractionFiles[selectedExtraction];
      if (!extractionPath) {
        const available = Object.keys(extractionFiles);
        throw new Error(`No extraction output found for worker "${selectedExtraction}". Available: ${available.length > 0 ? available.join(', ') : 'none (run extraction first)'}`);
      }
      fieldUpdates.selectedExtraction = extractionPath;
      changes.push(`selectedExtraction → ${selectedExtraction} (${extractionPath})`);
    }
    if (clearError) {
      fieldUpdates.lastError = undefined;
      fieldUpdates.attempts = 0;
      changes.push('cleared error');
    }

    if (changes.length === 0 && sourceOrder === undefined) {
      throw new Error('No source updates specified. Provide at least one of: sourceStatus, sourceWorkers, sourceSelectedExtraction, sourceStatusReason, clearError, sourceOrder.');
    }

    if (changes.length > 0) {
      await state.updateSource(source.path, fieldUpdates as Parameters<StateManager['updateSource']>[1]);
    }

    // Clean up extraction artifacts when resetting to pending or excluding
    if (newStatus === 'pending' || newStatus === 'excluded') {
      const sourceFilename = basename(source.path);
      const workers = source.assignedWorkers ?? [];
      for (const w of workers) {
        await state.deleteExtractionCheckpoint(sourceFilename, w);
        await state.deleteExtractionProgress(sourceFilename, w);
      }
      // Also try without worker prefix for legacy cleanup
      await state.deleteExtractionCheckpoint(sourceFilename);
      await state.deleteExtractionProgress(sourceFilename);
    }

    // Apply reorder after other updates so the source list is up-to-date
    if (sourceOrder !== undefined) {
      const validOrders = ['start', 'end', 'up', 'down'];
      const parsedOrder = typeof sourceOrder === 'number' ? sourceOrder
        : validOrders.includes(sourceOrder) ? sourceOrder as 'start' | 'end' | 'up' | 'down'
        : (() => { throw new Error(`Invalid sourceOrder "${sourceOrder}". Use a number (0-based index), or "start", "end", "up", "down".`); })();
      const { newIndex, total } = await state.reorderSource(source.path, parsedOrder);
      changes.push(`moved to position ${newIndex} of ${total}`);
    }

    return {
      action: 'update-source',
      source: source.path,
      message: `Updated ${basename(source.path)}: ${changes.join(', ')}`,
      updates: changes,
    };
  }

  private async updateQualityThresholds(params: Record<string, unknown>, thresholdUpdates: Record<string, unknown>) {
    const processDir = params['processDir'] as string;
    if (!processDir) {
      throw new Error('processDir is required to update quality thresholds.');
    }

    const absProcessDir = resolve(processDir);
    const configPath = join(absProcessDir, 'config.json');
    const configContent = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent) as IndexProcessConfig;

    // Deep-merge the threshold updates into existing config
    const existing = config.qualityThresholds ?? {};
    const extraction = thresholdUpdates['extraction'] as Record<string, unknown> | undefined;
    const consolidation = thresholdUpdates['consolidation'] as Record<string, unknown> | undefined;

    if (extraction) {
      const existingExtraction = (existing as Record<string, unknown>)['extraction'] as Record<string, unknown> ?? {};
      (existing as Record<string, unknown>)['extraction'] = {
        ...existingExtraction,
        ...extraction,
        ...(extraction['propertyCoverage'] ? {
          propertyCoverage: { ...(existingExtraction['propertyCoverage'] as Record<string, unknown> ?? {}), ...(extraction['propertyCoverage'] as Record<string, unknown>) },
        } : {}),
        ...(extraction['orphanRate'] ? {
          orphanRate: { ...(existingExtraction['orphanRate'] as Record<string, unknown> ?? {}), ...(extraction['orphanRate'] as Record<string, unknown>) },
        } : {}),
        ...(extraction['truncationRate'] ? {
          truncationRate: { ...(existingExtraction['truncationRate'] as Record<string, unknown> ?? {}), ...(extraction['truncationRate'] as Record<string, unknown>) },
        } : {}),
      };
    }
    if (consolidation) {
      const existingConsolidation = (existing as Record<string, unknown>)['consolidation'] as Record<string, unknown> ?? {};
      (existing as Record<string, unknown>)['consolidation'] = {
        ...existingConsolidation,
        ...consolidation,
        ...(consolidation['mergeConfidence'] ? {
          mergeConfidence: { ...(existingConsolidation['mergeConfidence'] as Record<string, unknown> ?? {}), ...(consolidation['mergeConfidence'] as Record<string, unknown>) },
        } : {}),
      };
    }

    config.qualityThresholds = existing;
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

    return {
      action: 'update-quality-thresholds',
      message: `Updated quality thresholds in config.json`,
      qualityThresholds: config.qualityThresholds,
    };
  }
}

function findSource(sources: Array<{ path: string; extractionFiles?: Record<string, string>; assignedWorkers?: string[] }>, query: string): { path: string; extractionFiles?: Record<string, string>; assignedWorkers?: string[] } {
  const exact = sources.find(s => s.path === query);
  if (exact) return exact;

  const matches = sources.filter(s => basename(s.path).includes(query) || s.path.includes(query));
  if (matches.length === 0) {
    throw new Error(`No source found matching "${query}". Available: ${sources.map(s => basename(s.path)).join(', ')}`);
  }
  if (matches.length > 1) {
    throw new Error(`Ambiguous source "${query}" matches ${matches.length}: ${matches.map(s => basename(s.path)).join(', ')}`);
  }
  return matches[0]!;
}

/** Map PipelinePhase to ProcessPhase for process-state.md updates */
function pipelineToProcessPhase(phase: PipelinePhase): ProcessPhase | null {
  const mapping: Partial<Record<string, ProcessPhase>> = {
    [Phase.EXTRACT]: 'sample-extraction',
    [Phase.EXTRACTION_REVIEW]: 'validation-review',
    [Phase.CONSOLIDATE]: 'consolidation-review',
    [Phase.IMPORT]: 'import',
    [Phase.EMBEDDINGS]: 'complete',
    [Phase.COMPLETE]: 'complete',
  };
  return (mapping[phase] as ProcessPhase | undefined) ?? null;
}
