import { basename } from 'node:path';
import { BaseToolController } from './base/BaseToolController.js';
import {
  StateManager, Phase, IndexingOrchestrator, ProcessStateWriter,
  EmbeddingsOrchestrator, CheckpointManager, matchesSourceFilter,
} from '@utaba/deep-memory-indexer';
import type {
  PipelinePhase, ApplyCorrectionsResult,
  EmbeddingsDependencies, EmbeddingsConfig,
} from '@utaba/deep-memory-indexer';
import { DeepMemory, InMemoryStorageProvider, type StorageProvider } from '@utaba/deep-memory';
import { SqlServerStorageProvider } from '@utaba/deep-memory-storage-sqlserver';
import { CosmosDbProvider } from '@utaba/deep-memory-storage-cosmosdb';
import { resolveStateDir, resolveConfig } from './resolveProcess.js';
import { registerLLMProviders } from './LLMProviderResolver.js';
import { registerValidationProviders } from './ValidationProviderResolver.js';

export class ExecuteTool extends BaseToolController {
  get name() { return 'indexing_execute'; }
  get description() { return 'Phase-aware action tool: "Do the next thing." Executes the primary action for the current pipeline phase — extraction, consolidation, import, embeddings, etc. For review phases, returns structured guidance. IMPORTANT: This tool never advances phases — use indexing_update to move between phases.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory (contains config.json).' },
        action: {
          type: 'string',
          description: 'Override the default action for the current phase. Supported actions: prepare, analyze, convert, extract, validate-full, apply-corrections, consolidate, reconsolidate, import, resume, embed.',
          enum: ['prepare', 'analyze', 'convert', 'extract', 'validate-full', 'apply-corrections', 'consolidate', 'reconsolidate', 'import', 'resume', 'embed'],
        },
        maxItems: { type: 'number', description: 'Limit documents processed (extraction).' },
        sourceFilter: { type: 'array', items: { type: 'string' }, description: 'Filter to specific source(s) by filename or path substring.' },
        corrections: {
          type: 'object',
          description: 'Correction resolutions for action "apply-corrections". approveAll: applies all corrections above minConfidence (default 0.8). approvedIndices: array of specific correction indices from indexing_diagnose output. Provide one of approveAll or approvedIndices.',
          properties: {
            approveAll: { type: 'boolean', description: 'Apply all corrections above minConfidence threshold.' },
            approvedIndices: { type: 'array', items: { type: 'number' }, description: 'Array of specific correction indices to apply (from indexing_diagnose output).' },
            minConfidence: { type: 'number', description: 'Minimum confidence threshold for approveAll (default: 0.8).' },
          },
        },
        confirm: { type: 'boolean', description: 'Confirm to proceed (used for embed phase to start after seeing estimate).' },
        dryRun: { type: 'boolean', description: 'Preview what would be executed without running it. Supported for: extract (shows sources and workers), validate-full (shows item counts), consolidate (shows entity counts), import (shows archive summary), and apply-corrections (shows which corrections would be applied). For apply-corrections, this defaults to TRUE — you must pass dryRun: false to actually mutate extraction files.' },
        resolutions: {
          type: 'object',
          description: 'Import checkpoint resolutions: map of flagged item index to "accept", "reject", or "correct".',
        },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const action = params['action'] as string | undefined;

    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const phase = await state.getCurrentPhase();

    // Check for active process lock on phases that run in the background
    const backgroundPhases: Set<string> = new Set([Phase.EXTRACT, 'full-validation', Phase.EMBEDDINGS]);
    const isBackgroundAction = backgroundPhases.has(phase) && action !== 'apply-corrections';
    if (isBackgroundAction) {
      const lock = await state.getProcessLock();
      if (lock) {
        return {
          error: 'busy',
          message: `A ${lock.operation} operation is already running (started ${lock.acquiredAt}). Only one background operation can run at a time.`,
          runningOperation: lock.operation,
          startedAt: lock.acquiredAt,
          guidance: 'Use indexing_status to monitor progress, or indexing_stop to cancel the running operation.',
        };
      }
    }

    // Handle explicit actions that override phase routing
    if (action === 'apply-corrections') {
      return this.applyCorrections(params);
    }
    if (action === 'reconsolidate') {
      return this.executeConsolidate(params);
    }

    // Phase-based default routing
    switch (phase) {
      case Phase.PREPARE:
        if (action === 'analyze') return this.executeAnalyze(params);
        if (action === 'convert') return this.executeConvert(params);
        return this.executePrepare(params);
      case Phase.EXTRACT:
        return this.executeExtract(params);
      case Phase.EXTRACTION_REVIEW:
        return this.executeReviewGuidance(state, phase);
      case 'full-validation' as PipelinePhase:
        return action === 'validate-full' || !action
          ? this.executeFullValidation(params)
          : this.executeReviewGuidance(state, phase);
      case Phase.CONSOLIDATE:
        return this.executeConsolidate(params);
      case 'consolidation-review' as PipelinePhase:
        return this.executeReviewGuidance(state, phase);
      case Phase.IMPORT:
        return action === 'resume' ? this.executeResume(params) : this.executeImport(params);
      case Phase.IMPORT_REVIEW:
        return this.executeReviewGuidance(state, phase);
      case Phase.EMBEDDINGS:
        return this.executeEmbed(params);
      case Phase.COMPLETE:
        return {
          currentPhase: Phase.COMPLETE,
          message: 'Pipeline is complete. Nothing to execute.',
          guidance: 'Use the deep-memory MCP server to query the knowledge graph.',
        };
      default:
        throw new Error(`Unknown phase: ${phase}. Run indexing_analyze to check pipeline state.`);
    }
  }

  private async executePrepare(params: Record<string, unknown>) {
    const { config, sourceDir } = await resolveConfig(params);
    const orchestrator = new IndexingOrchestrator(config);
    const sourceList = await orchestrator.prepare(sourceDir);

    const needsConversion = sourceList.sources.filter(s => s.status === 'needs-conversion').length;
    const guidance = needsConversion > 0
      ? `${needsConversion} source(s) are rich formats needing conversion. Start the docling-worker docker profile, then run indexing_execute action: "convert" before extraction. Run indexing_analyze to review cost estimates for the text sources.`
      : 'Run indexing_analyze to review cost estimates, then indexing_execute to start extraction.';

    return {
      currentPhase: Phase.PREPARE,
      action: 'prepare',
      message: `Prepared ${sourceList.sources.length} source documents for indexing`,
      sourcesNeedingConversion: needsConversion,
      sources: sourceList.sources.map(s => ({
        path: s.path,
        type: s.type,
        status: s.status,
        notes: s.notes,
      })),
      guidance,
    };
  }

  private async executeAnalyze(params: Record<string, unknown>) {
    const { config } = await resolveConfig(params);
    const orchestrator = new IndexingOrchestrator(config);
    const report = await orchestrator.analyze();

    const stateManager = orchestrator.getStateManager();
    const analyzeSourceList = await stateManager.getSourceList();
    const needsConversion = analyzeSourceList
      ? analyzeSourceList.sources.filter(s => s.status === 'needs-conversion').length
      : 0;
    const guidance = needsConversion > 0
      ? `${needsConversion} source(s) still need conversion (excluded from these estimates). Run indexing_execute action: "convert" first. Then review estimates and run indexing_execute to start extraction.`
      : 'Review the estimates. Run indexing_execute to start extraction.';

    return {
      currentPhase: Phase.PREPARE,
      action: 'analyze',
      message: `Analysis complete: ${report.summary.totalDocuments} documents analyzed`,
      sourcesNeedingConversion: needsConversion,
      summary: report.summary,
      byWorker: Object.fromEntries(
        Object.entries(report.byWorker).map(([name, ws]) => [name, {
          ...ws,
          cost: `$${ws.cost.toFixed(2)}`,
        }]),
      ),
      documents: report.documents.map(d => ({
        source: d.source,
        type: d.type,
        sizeKB: d.sizeKB,
        assignedWorkers: d.assignedWorkers,
        chunks: d.estimatedTokens.chunks,
        estimatedCost: `$${d.estimatedCost.toFixed(2)}`,
      })),
      guidance,
    };
  }

  private async executeConvert(params: Record<string, unknown>) {
    const dryRun = params['dryRun'] as boolean | undefined;
    const { config, sourceDir } = await resolveConfig(params);

    // Wire the tool's sourceFilter param into the run — convert previously read
    // it only from the config file and silently ignored the tool param, unlike
    // extract. Params take precedence over the config-file filter.
    const sourceFilter = (params['sourceFilter'] as string[] | undefined) ?? config.extraction.sourceFilter;
    if (sourceFilter && sourceFilter.length > 0) {
      config.extraction.sourceFilter = sourceFilter;
    }

    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const sourceList = await state.getSourceList();
    const allNeedingConversion = sourceList
      ? sourceList.sources.filter(s => s.status === 'needs-conversion' || s.status === 'converting')
      : [];
    // Report the filtered set so the count matches what convert() will process.
    const needsConversion = sourceFilter && sourceFilter.length > 0
      ? allNeedingConversion.filter(s => matchesSourceFilter(s.path, sourceFilter))
      : allNeedingConversion;

    const mode = config.services?.docling?.mode ?? 'async';

    if (needsConversion.length === 0) {
      const filteredOut = sourceFilter && sourceFilter.length > 0 && allNeedingConversion.length > 0;
      return {
        currentPhase: Phase.PREPARE,
        action: 'convert',
        message: filteredOut
          ? `No sources match the sourceFilter (${allNeedingConversion.length} source(s) need conversion, none matched).`
          : 'No sources need conversion.',
        guidance: filteredOut
          ? 'Adjust sourceFilter, or drop it to convert all pending sources.'
          : 'Run indexing_analyze to review estimates, then indexing_execute to start extraction.',
      };
    }

    if (!config.services?.docling) {
      return {
        currentPhase: Phase.PREPARE,
        action: 'convert',
        error: `${needsConversion.length} source(s) need conversion but no document-conversion service is configured.`,
        guidance: 'Add a "services.docling" section to config.json (endpoint defaults to http://localhost:5001) and start the docling-worker docker profile, then retry.',
      };
    }

    if (dryRun) {
      return {
        currentPhase: Phase.PREPARE,
        action: 'convert',
        dryRun: true,
        mode,
        message: `Dry run: would convert ${needsConversion.length} source(s) to Markdown. No conversion started.`,
        pendingConversion: needsConversion.map(s => ({ source: basename(s.path), originalFormat: s.originalFormat })),
        guidance: 'Remove dryRun to start conversion. Ensure the docling-worker docker profile is running.',
      };
    }

    // Report busy only when a live process still holds the lock. A lock left
    // behind by a crashed operation (dead PID) is stale and must not wedge the
    // pipeline — it falls through to acquireProcessLock, which reclaims it.
    const existingLock = await state.getProcessLock();
    if (existingLock && StateManager.isProcessAlive(existingLock.pid)) {
      return {
        error: 'busy',
        message: `A ${existingLock.operation} operation is already running (started ${existingLock.acquiredAt}). Only one background operation can run at a time.`,
        runningOperation: existingLock.operation,
        startedAt: existingLock.acquiredAt,
        guidance: 'Use indexing_status to monitor progress, or indexing_stop to cancel the running operation.',
      };
    }

    const orchestrator = new IndexingOrchestrator(config);
    // Acquire the lock atomically. If a concurrent operation won the lock in the
    // window since the check above, do not dispatch — report busy instead.
    const acquired = await state.acquireProcessLock('conversion');
    if (!acquired) {
      const lock = await state.getProcessLock();
      return {
        error: 'busy',
        message: lock
          ? `A ${lock.operation} operation is already running (started ${lock.acquiredAt}). Only one background operation can run at a time.`
          : 'Another operation acquired the process lock. Only one background operation can run at a time.',
        ...(lock ? { runningOperation: lock.operation, startedAt: lock.acquiredAt } : {}),
        guidance: 'Use indexing_status to monitor progress, or indexing_stop to cancel the running operation.',
      };
    }

    // Fire and forget — conversion runs in the background against a possibly
    // slow container, mirroring how extraction is dispatched.
    orchestrator.convert(sourceDir).catch(err => {
      this.logger.error('ExecuteTool', `Background conversion failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(async () => {
      await state.releaseProcessLock();
    });

    return {
      currentPhase: Phase.PREPARE,
      action: 'convert',
      mode,
      message: `Conversion started for ${needsConversion.length} source(s) in ${mode} mode. Run indexing_status to monitor progress.`,
      pendingConversion: needsConversion.map(s => ({ source: basename(s.path), originalFormat: s.originalFormat })),
      guidance: mode === 'async'
        ? 'Conversion runs asynchronously — poll indexing_status for live queue position and elapsed time. When it completes, run indexing_analyze then indexing_execute to extract.'
        : 'Monitor progress with indexing_status. When conversion completes, run indexing_analyze then indexing_execute to extract.',
    };
  }

  private async executeExtract(params: Record<string, unknown>) {
    const dryRun = params['dryRun'] as boolean | undefined;
    const { config } = await resolveConfig(params);
    const orchestrator = new IndexingOrchestrator(config);
    await registerLLMProviders(orchestrator, config.extraction.workers);

    // Resolve the effective filter up front (params take precedence over the
    // config-file filter) so the reported pending set matches what the
    // orchestrator will actually extract.
    const maxItems = (params['maxItems'] as number | undefined) ?? config.extraction.maxItems;
    const sourceFilter = (params['sourceFilter'] as string[] | undefined) ?? config.extraction.sourceFilter;

    const stateManager = orchestrator.getStateManager();
    const sourceList = await stateManager.getSourceList();
    const allPending = sourceList
      ? sourceList.sources.filter(s => s.status === 'pending')
      : [];
    const pendingSources = sourceFilter && sourceFilter.length > 0
      ? allPending.filter(s => matchesSourceFilter(s.path, sourceFilter))
      : allPending;
    const needsConversion = sourceList
      ? sourceList.sources.filter(s => s.status === 'needs-conversion' || s.status === 'converting').length
      : 0;

    if (needsConversion > 0) {
      return {
        currentPhase: Phase.EXTRACT,
        action: 'extract',
        message: `${needsConversion} source(s) need conversion before extraction — run action: convert.`,
        guidance: 'Start the docling-worker docker profile, then run indexing_execute action: "convert". Extraction will not read unconverted binary sources.',
      };
    }

    if (pendingSources.length === 0) {
      return {
        currentPhase: Phase.EXTRACT,
        action: 'extract',
        message: 'No pending sources to extract.',
        guidance: 'Run indexing_diagnose for quality checks, then indexing_update to advance to the next phase.',
      };
    }

    if (dryRun) {
      return {
        currentPhase: Phase.EXTRACT,
        action: 'extract',
        dryRun: true,
        message: `Dry run: would extract ${pendingSources.length} pending source(s). No extraction started.`,
        pendingSources: pendingSources.map(s => ({
          source: basename(s.path),
          assignedWorkers: s.assignedWorkers,
        })),
        guidance: 'Remove dryRun to start extraction.',
      };
    }

    // Fire and forget — extraction runs in the background
    const processDir = params['processDir'] as string | undefined;

    // Pass the resolved sourceFilter and maxItems into the extraction config
    if (sourceFilter && sourceFilter.length > 0) {
      config.extraction.sourceFilter = sourceFilter;
    }
    if (maxItems !== undefined) {
      config.extraction.maxItems = maxItems;
    }

    const extractionState = new StateManager(resolveStateDir(params));
    await extractionState.acquireProcessLock('extraction');

    orchestrator.extract().then(async (outputs) => {
      let totalEntities = 0;
      let totalRelationships = 0;
      for (const o of outputs) {
        totalEntities += o.entities.length;
        totalRelationships += o.relationships.length;
      }

      if (processDir) {
        const stateWriter = new ProcessStateWriter(processDir);
        const phase = maxItems && maxItems < 10 ? 'sample-extraction' : 'full-extraction';
        await stateWriter.updatePhase(phase);
        await stateWriter.appendIteration({
          date: new Date().toISOString().split('T')[0]!,
          goal: 'Extract entities and relationships',
          result: `${totalEntities} entities, ${totalRelationships} relationships across ${outputs.length} documents`,
        });
      }
    }).catch(err => {
      this.logger.error('ExecuteTool', `Background extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(async () => {
      await extractionState.releaseProcessLock();
    });

    return {
      currentPhase: Phase.EXTRACT,
      action: 'extract',
      message: `Extraction started for ${pendingSources.length} pending source(s). Run indexing_status to monitor progress.`,
      pendingSources: pendingSources.map(s => ({
        source: basename(s.path),
        assignedWorkers: s.assignedWorkers,
      })),
      guidance: 'Monitor progress with indexing_status. Stop with indexing_stop.',
    };
  }

  private async executeConsolidate(params: Record<string, unknown>) {
    const dryRun = params['dryRun'] as boolean | undefined;
    const { config } = await resolveConfig(params);

    if (dryRun) {
      const stateDir = resolveStateDir(params);
      const state = new StateManager(stateDir);
      const extractions = await state.getExtractionOutputs();
      let totalEntities = 0;
      let totalRelationships = 0;
      for (const ext of extractions) {
        totalEntities += ext.entities.length;
        totalRelationships += ext.relationships.length;
      }
      return {
        currentPhase: Phase.CONSOLIDATE,
        action: 'consolidate',
        dryRun: true,
        message: `Dry run: would consolidate ${totalEntities} entities and ${totalRelationships} relationships from ${extractions.length} documents. No consolidation started.`,
        preConsolidation: {
          documentsExtracted: extractions.length,
          totalEntities,
          totalRelationships,
        },
        guidance: 'Remove dryRun to start consolidation.',
      };
    }

    const orchestrator = new IndexingOrchestrator(config);
    const { registry, report } = await orchestrator.consolidate();

    return {
      currentPhase: Phase.CONSOLIDATE,
      action: 'consolidate',
      message: `Consolidation complete: ${registry.entities.length} entities in registry`,
      registry: {
        totalEntities: registry.entities.length,
        byType: registry.entities.reduce((acc, e) => {
          acc[e.entityType] = (acc[e.entityType] ?? 0) + 1;
          return acc;
        }, {} as Record<string, number>),
      },
      report,
      guidance: 'Run indexing_diagnose to check merge quality, then indexing_update with phase "import" to proceed.',
    };
  }

  private async executeImport(params: Record<string, unknown>) {
    const dryRun = params['dryRun'] as boolean | undefined;
    const { config } = await resolveConfig(params);

    if (dryRun) {
      const stateDir = resolveStateDir(params);
      const state = new StateManager(stateDir);
      const archives = await state.getExportArchives();
      const registry = await state.getRegistry();
      return {
        currentPhase: Phase.IMPORT,
        action: 'import',
        dryRun: true,
        message: `Dry run: would import ${archives.length} archive(s) into repository "${registry?.repositoryId ?? 'unknown'}". No import started.`,
        archives: archives.length,
        repositoryId: registry?.repositoryId ?? null,
        storageType: config.import?.storage?.type ?? 'not configured',
        guidance: 'Remove dryRun to start import.',
      };
    }

    const importConfig = config.import;
    const storage = resolveStorage(importConfig);

    const deepMemory = new DeepMemory({
      storage,
      provenance: { actorId: 'indexer-mcp', actorType: 'agent' },
    });

    try {
      await deepMemory.ensureSchema();
      const orchestrator = new IndexingOrchestrator(config);
      const { archive, report: consolidationReport } = await orchestrator.consolidate();
      const importResult = await orchestrator.importArchive(archive, deepMemory);

      const processDir = params['processDir'] as string | undefined;
      if (processDir && importResult.success) {
        const stateWriter = new ProcessStateWriter(processDir);
        await stateWriter.updatePhase('complete');
        await stateWriter.appendIteration({
          date: new Date().toISOString().split('T')[0]!,
          goal: 'Import consolidated archive into repository',
          result: `${importResult.statistics.entitiesImported} entities, ${importResult.statistics.relationshipsImported} relationships imported`,
        });
      }

      return {
        currentPhase: Phase.IMPORT,
        action: 'import',
        message: importResult.success
          ? `Import complete: ${importResult.statistics.entitiesImported} entities, ${importResult.statistics.relationshipsImported} relationships`
          : 'Import failed',
        consolidation: consolidationReport,
        import: importResult,
        guidance: 'Run indexing_update with phase "embeddings" to proceed.',
      };
    } finally {
      await deepMemory.dispose();
    }
  }

  private async executeEmbed(params: Record<string, unknown>) {
    const { config } = await resolveConfig(params);
    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const confirm = params['confirm'] as boolean | undefined;

    if (!config.embeddings) {
      return {
        error: 'No "embeddings" section found in config.json. Add endpoint, model, and optionally costPerMillionTokens before running this phase.',
      };
    }

    const embeddingsConfig = config.embeddings;
    const repositoryId = config.repositoryId;

    const importConfig = config.import;
    const storage = resolveStorage(importConfig);

    const deepMemory = new DeepMemory({
      storage,
      provenance: { actorId: 'indexer-mcp', actorType: 'agent' },
    });
    await deepMemory.ensureSchema();

    // RepositoryStats is the authoritative count source. findEntities.total
    // could be used here for unfiltered queries, but PaginatedResult.total is
    // `number | undefined` (some provider/query combinations don't compute it)
    // and the embedding orchestrator needs a guaranteed number to split work
    // across workers.
    const stats = await storage.getRepositoryStats(repositoryId);
    const entityCount = stats.entityCount;

    const estimate = buildEmbedEstimate(embeddingsConfig, entityCount);

    if (!confirm) {
      await deepMemory.dispose();
      return {
        currentPhase: Phase.EMBEDDINGS,
        action: 'embed-estimate',
        message: `Embedding estimate for ${entityCount} entities. Set confirm: true to proceed.`,
        estimate,
      };
    }

    const deps: EmbeddingsDependencies = {
      totalEntities: entityCount,
      loadEntities: async (limit, offset) => {
        const page = await storage.findEntities(repositoryId, { limit, offset });
        return {
          items: page.items.map(e => ({
            id: e.id,
            label: e.label,
            summary: e.summary ?? '',
          })),
        };
      },
      saveVector: async (entityId, vector) => {
        const entities = await storage.getEntities(repositoryId, [entityId]);
        const entity = entities.get(entityId);
        if (!entity) throw new Error(`Entity not found: ${entityId}`);
        await storage.updateEntity(repositoryId, entityId, {
          provenance: entity.provenance,
          embedding: vector,
        });
      },
    };

    const orchestrator = new EmbeddingsOrchestrator(embeddingsConfig, state);
    await state.acquireProcessLock('embeddings');

    orchestrator.run(deps).then(() => deepMemory.dispose(), async (err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      await state.saveEmbeddingProgress({
        status: 'failed',
        totalEntities: entityCount,
        processed: 0,
        failed: 0,
        totalBatches: estimate.totalBatches,
        completedBatches: 0,
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        model: embeddingsConfig.model,
        endpoint: embeddingsConfig.endpoint,
        stoppedReason: `Unexpected error: ${errorMsg}`,
      });
      await deepMemory.dispose();
    }).finally(async () => {
      await state.releaseProcessLock();
    });

    return {
      currentPhase: Phase.EMBEDDINGS,
      action: 'embed',
      message: `Embedding started for ${entityCount} entities. Run indexing_analyze to monitor progress.`,
      estimate,
      guidance: 'Monitor progress with indexing_analyze. Stop with indexing_stop.',
    };
  }

  private async executeFullValidation(params: Record<string, unknown>) {
    const dryRun = params['dryRun'] as boolean | undefined;
    const { config } = await resolveConfig(params);

    const fullValidationConfig = config.fullValidation;
    if (!fullValidationConfig) {
      throw new Error(
        'No fullValidation configuration found. ' +
        'Add a "fullValidation" section to config.json with at least one worker.',
      );
    }

    const orchestrator = new IndexingOrchestrator(config);
    await registerValidationProviders(orchestrator, fullValidationConfig);

    const maxBatches = params['maxBatches'] as number | undefined;
    const maxCost = params['maxCost'] as number | undefined;
    const sourceFilter = params['sourceFilter'] as string[] | undefined;

    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const existingProgress = await state.getFullValidationProgress<{ validatedItemKeys?: string[]; totalEntities: number; totalRelationships: number }>();
    const validatedCount = existingProgress?.validatedItemKeys?.length ?? 0;

    const extractions = await state.getExtractionOutputs();
    let totalEntities = 0;
    let totalRelationships = 0;
    for (const ext of extractions) {
      // Apply sourceFilter to match what the orchestrator will actually validate
      if (sourceFilter && sourceFilter.length > 0) {
        const matches = sourceFilter.some(f =>
          ext.source.includes(f) || ext.sourcePath.includes(f),
        );
        if (!matches) continue;
      }
      totalEntities += ext.entities.length;
      totalRelationships += ext.relationships.length;
    }
    const totalItems = totalEntities + totalRelationships;
    const remainingItems = Math.max(0, totalItems - validatedCount);

    if (dryRun) {
      return {
        currentPhase: 'full-validation',
        action: 'validate-full',
        dryRun: true,
        message: `Dry run: would validate ${remainingItems} remaining items (${totalItems} total, ${validatedCount} already validated). No validation started.`,
        plan: {
          totalItems,
          alreadyValidated: validatedCount,
          remainingItems,
          maxBatches: maxBatches ?? 'unlimited',
          maxCost: maxCost ?? 'unlimited',
          sourceFilter: sourceFilter ?? 'all sources',
        },
        guidance: 'Remove dryRun to start validation.',
      };
    }

    // Fire and forget
    const processDir = params['processDir'] as string | undefined;
    const validationState = new StateManager(resolveStateDir(params));
    await validationState.acquireProcessLock('full-validation');

    orchestrator.validateFull(
      fullValidationConfig,
      { maxBatches, maxCost, sourceFilter },
      {},
      new AbortController().signal,
    ).then(async () => {
      if (processDir) {
        const stateWriter = new ProcessStateWriter(processDir);
        await stateWriter.appendIteration({
          date: new Date().toISOString().split('T')[0]!,
          goal: 'Full extraction validation',
          result: 'Validation completed',
        });
      }
    }).catch(err => {
      this.logger.error('ExecuteTool', `Background validation failed: ${err instanceof Error ? err.message : String(err)}`);
    }).finally(async () => {
      await validationState.releaseProcessLock();
    });

    return {
      currentPhase: 'full-validation',
      action: 'validate-full',
      message: 'Validation started in background. Run indexing_analyze to monitor progress.',
      plan: {
        totalItems,
        alreadyValidated: validatedCount,
        remainingItems,
        maxBatches: maxBatches ?? 'unlimited',
        maxCost: maxCost ?? 'unlimited',
      },
      guidance: 'Monitor with indexing_analyze. When complete, review results with indexing_diagnose.',
    };
  }

  private async executeReviewGuidance(state: StateManager, phase: PipelinePhase) {
    const extractions = await state.getExtractionOutputs();
    let totalEntities = 0;
    let totalRelationships = 0;
    for (const output of extractions) {
      totalEntities += output.entities.length;
      totalRelationships += output.relationships.length;
    }

    const reviewChecklist: string[] = [];
    let nextPhase = '';

    if (phase === Phase.EXTRACTION_REVIEW) {
      reviewChecklist.push(
        'Run indexing_diagnose to check extraction quality',
        'Review orphan relationships — remap labels or create stub entities',
        'Verify property accuracy on 5+ entities per document',
        'Check source references on 3+ entities per document',
      );
      nextPhase = 'consolidation';
    } else if (phase === ('full-validation' as PipelinePhase)) {
      reviewChecklist.push(
        'Run indexing_diagnose to view validation verdicts',
        'Review flagged items and proposed corrections — these may include structural remodels (create/retarget), applied as atomic groups where all steps in a group succeed or none do',
        'Apply corrections with indexing_execute action "apply-corrections" (dry run first)',
      );
      nextPhase = 'consolidation';
    } else if (phase === ('consolidation-review' as PipelinePhase)) {
      reviewChecklist.push(
        'Run indexing_diagnose to check merge quality',
        'Review low-confidence merges and alias specificity',
        'Verify cross-source merge accuracy',
      );
      nextPhase = 'import';
    } else if (phase === Phase.IMPORT_REVIEW) {
      reviewChecklist.push(
        'Check import warnings for overwritten entities',
        'Verify orphaned relationships',
        'Check vocabulary alignment',
      );
      nextPhase = 'embeddings';
    }

    return {
      currentPhase: phase,
      action: 'review-guidance',
      message: `${phase} phase. ${totalEntities} entities, ${totalRelationships} relationships.`,
      guidance: {
        summary: `Review phase: ${phase}`,
        reviewChecklist,
        nextSteps: [
          'Fix issues in extraction/consolidation files if needed',
          'Run indexing_diagnose to re-check after corrections',
          `Run indexing_update with phase "${nextPhase}" to proceed.`,
        ],
      },
    };
  }

  private async applyCorrections(params: Record<string, unknown>) {
    // Apply-corrections defaults to dryRun: true — the user must opt in to
    // mutation by passing dryRun: false. Stops accidental writes to extraction
    // files. Selection, grouping, endpoint resolution, apply-side conformance,
    // backups, and atomic writes all live in the engine's CorrectionApplier;
    // this method only parses params and shapes the MCP response.
    const dryRun = (params['dryRun'] as boolean | undefined) ?? true;
    const corrections = params['corrections'] as { approveAll?: boolean; approvedIndices?: number[]; minConfidence?: number } | undefined;

    const { config } = await resolveConfig(params);
    const orchestrator = new IndexingOrchestrator(config);
    const result = await orchestrator.applyCorrections({
      selection: {
        approveAll: corrections?.approveAll,
        minConfidence: corrections?.minConfidence,
        approvedIndices: corrections?.approvedIndices,
      },
      dryRun,
    });

    return this.shapeApplyCorrectionsResult(result);
  }

  private shapeApplyCorrectionsResult(result: ApplyCorrectionsResult) {
    switch (result.outcome) {
      case 'no-corrections':
        return { message: 'No corrections found. Run full validation first.', applied: 0 };
      case 'no-selection':
        return {
          message: 'Specify corrections.approvedIndices or corrections.approveAll to apply corrections.',
          totalCorrections: result.totalCorrections,
          byOperation: result.byOperation,
          corrections: result.listing,
        };
      case 'no-matches':
        return { message: 'No corrections matched the selection criteria.', applied: 0 };
      case 'dry-run':
        return {
          message: `Dry run: would apply ${result.plan?.length ?? 0} corrections. Pass dryRun: false to mutate extraction files.`,
          dryRun: true,
          plan: result.plan,
          warnings: result.warnings,
          groupExpansions: result.expansions,
        };
      case 'applied': {
        const applied = result.applied ?? [];
        const parts = [`Applied ${applied.length} corrections`];
        if (result.created) parts.push(`${result.created.length} entities created`);
        if (result.retargeted) parts.push(`${result.retargeted.length} relationships retargeted`);
        if (result.skipped) parts.push(`${result.skipped.length} skipped`);
        if (result.failed) parts.push(`${result.failed.length} failed`);
        if (result.cascaded) parts.push(`${result.cascaded.length} relationships cascaded`);
        if (result.skippedGroups) parts.push(`${result.skippedGroups.length} groups skipped`);
        return {
          currentPhase: 'full-validation',
          action: 'apply-corrections',
          message: parts.join(', '),
          applied,
          created: result.created,
          retargeted: result.retargeted,
          skipped: result.skipped,
          failed: result.failed,
          cascaded: result.cascaded,
          skippedGroups: result.skippedGroups,
          warnings: result.warnings,
          groupExpansions: result.expansions,
          backupLocation: result.backupLocation,
        };
      }
    }
  }

  private async executeResume(params: Record<string, unknown>) {
    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const rawResolutions = params['resolutions'] as Record<string, string> | undefined;

    const currentPhase = await state.getCurrentPhase();
    if (currentPhase !== 'import-review') {
      return {
        message: `Pipeline is not paused — current phase is "${currentPhase}". Nothing to resume.`,
      };
    }

    if (!rawResolutions) {
      return {
        message: 'Import is paused for review. Provide resolutions for each flagged item: { "0": "accept", "1": "reject" }',
      };
    }

    const resolutions: Record<number, 'accept' | 'reject' | 'correct'> = {};
    for (const [key, value] of Object.entries(rawResolutions)) {
      resolutions[parseInt(key, 10)] = value as 'accept' | 'reject' | 'correct';
    }

    const rules = { version: '1.0.0', domain: 'unknown', propertyRanges: {}, relationshipRanges: {}, structuralRules: {} };
    const checkpoint = new CheckpointManager(
      { rulesPath: '', tier2Scope: 'all', checkpointInterval: 50 },
      stateDir,
      rules,
      '',
    );

    const result = await checkpoint.resume(resolutions);

    if (result.canContinue) {
      await state.clearPipelineState();
      return {
        currentPhase: Phase.IMPORT,
        action: 'resume',
        message: 'All flagged items resolved. Pipeline resumed.',
        canContinue: true,
      };
    }

    return {
      currentPhase: Phase.IMPORT_REVIEW,
      action: 'resume',
      message: `${result.unresolvedCount} flagged items still unresolved.`,
      canContinue: false,
      unresolvedCount: result.unresolvedCount,
    };
  }

}

function buildEmbedEstimate(config: EmbeddingsConfig, entityCount: number) {
  const avgTokensPerEntity = config.averageTokensPerEntity ?? 25;
  const totalTokens = entityCount * avgTokensPerEntity;
  const batchSize = Math.min(config.batchSize ?? 50, 200);
  const totalBatches = Math.ceil(entityCount / batchSize);
  const costPerM = config.costPerMillionTokens ?? 0;
  const estimatedCost = (totalTokens / 1_000_000) * costPerM;

  return {
    entityCount,
    avgTokensPerEntity,
    totalTokens,
    batchSize,
    totalBatches,
    estimatedCostUsd: Math.round(estimatedCost * 1000) / 1000,
    model: config.model,
    endpoint: config.endpoint,
  };
}

/** Resolve a StorageProvider from import config */
function resolveStorage(
  importConfig: { storage?: { type: string; config?: unknown } } | undefined,
): StorageProvider {
  const storageType = importConfig?.storage?.type;
  if (!storageType) {
    throw new Error('Import storage configuration is missing. Set import.storage.type in config.json (sqlserver, cosmosdb, or in-memory).');
  }
  if (storageType === 'sqlserver') {
    return new SqlServerStorageProvider(importConfig.storage!.config as ConstructorParameters<typeof SqlServerStorageProvider>[0]);
  }
  if (storageType === 'cosmosdb') {
    return new CosmosDbProvider(importConfig.storage!.config as ConstructorParameters<typeof CosmosDbProvider>[0]);
  }
  if (storageType === 'in-memory') {
    return new InMemoryStorageProvider();
  }
  throw new Error(`Unknown storage provider type: "${storageType}". Supported types: sqlserver, cosmosdb, in-memory.`);
}
