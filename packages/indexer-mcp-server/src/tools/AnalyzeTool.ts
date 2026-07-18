import { basename } from 'node:path';
import { BaseToolController } from './base/BaseToolController.js';
import { StateManager, Phase, IndexingOrchestrator } from '@utaba/deep-memory-indexer';
import type { PipelinePhase, EmbeddingProgress, FullValidationProgress, FullValidationReport, ReviewReport, ConsolidationReviewReport, TableCorruptionRecommendation } from '@utaba/deep-memory-indexer';
import { resolveStateDir, resolveConfig, formatDuration } from './resolveProcess.js';

/** Ordered pipeline phases for navigation */
const PHASE_ORDER: string[] = [
  'prepare', 'extract', 'extraction-review', 'full-validation',
  'consolidate', 'consolidation-review', 'import', 'import-review',
  'embeddings', 'complete',
];

function getPhaseNavigation(currentPhase: string): { nextPhase: string | null; availablePhases: string[] } {
  const currentIndex = PHASE_ORDER.indexOf(currentPhase);
  const nextPhase = currentIndex >= 0 && currentIndex < PHASE_ORDER.length - 1
    ? PHASE_ORDER[currentIndex + 1]!
    : null;
  // Available phases: next phase, previous phase (for rework), and any optional phases
  const available: string[] = [];
  if (nextPhase) available.push(nextPhase);
  if (currentIndex > 0) available.push(PHASE_ORDER[currentIndex - 1]!);
  // Add optional skip targets
  if (currentPhase === 'extraction-review') {
    available.push('full-validation', 'consolidate');
  }
  if (currentPhase === 'full-validation') {
    available.push('consolidate', 'extract');
  }
  // Deduplicate
  return { nextPhase, availablePhases: [...new Set(available)] };
}

export class AnalyzeTool extends BaseToolController {
  get name() { return 'indexing_analyze'; }
  get description() { return 'Phase-aware orientation tool: "Where are we, what do we have, and what happens next?" Returns current phase, status summary, and guidance. Use this first in any conversation and whenever you need to understand pipeline state.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory (contains config.json).' },
        sourceFilter: { type: 'string', description: 'Filter to a specific source filename for detailed view.' },
        verbose: { type: 'boolean', description: 'Include per-source detail (default: summary only).' },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const stateDir = resolveStateDir(params);
    const sourceFilter = params['sourceFilter'] as string | undefined;
    const verbose = params['verbose'] as boolean | undefined;
    const state = new StateManager(stateDir);

    const phase = await state.getCurrentPhase();

    switch (phase) {
      case Phase.PREPARE:
        return this.analyzePrepare(state, params);
      case Phase.EXTRACT:
        return this.analyzeExtract(state, verbose, sourceFilter);
      case Phase.EXTRACTION_REVIEW:
        return this.analyzeExtractionReview(state);
      case 'full-validation' as PipelinePhase:
        return this.analyzeFullValidation(state);
      case Phase.CONSOLIDATE:
        return this.analyzeConsolidate(state);
      case 'consolidation-review' as PipelinePhase:
        return this.analyzeConsolidationReview(state);
      case Phase.IMPORT:
        return this.analyzeImport(state);
      case Phase.IMPORT_REVIEW:
        return this.analyzeImportReview(state);
      case Phase.EMBEDDINGS:
        return this.analyzeEmbeddings(state);
      case Phase.COMPLETE:
        return this.analyzeComplete(state);
      default:
        return {
          currentPhase: phase,
          message: `Pipeline is in phase: ${phase}`,
          guidance: 'Run indexing_execute to proceed.',
        };
    }
  }

  private async analyzePrepare(state: StateManager, params: Record<string, unknown>) {
    const sourceList = await state.getSourceList();

    // Table-structure detection runs on every PREPARE analyze, before extraction
    // is spent — regardless of whether a source list already exists (the branch
    // below short-circuits, so detection cannot live only in the analysis path).
    const detection = await this.tableCorruptionRecommendations(params);
    const conversionRecommendations = detection.recommendations;

    // If no source list yet, check if we can run analysis
    if (!sourceList) {
      // Try to run the cost/token analysis
      try {
        const { config } = await resolveConfig(params);
        const orchestrator = new IndexingOrchestrator(config);
        const report = await orchestrator.analyze();

        return {
          currentPhase: Phase.PREPARE,
          ...getPhaseNavigation(Phase.PREPARE),
          message: `Analysis complete: ${report.summary.totalDocuments} documents found`,
          summary: {
            totalDocuments: report.summary.totalDocuments,
            totalInputTokens: report.summary.totalInputTokens,
            totalOutputTokens: report.summary.totalOutputTokens,
            estimatedCost: report.summary.estimatedCost,
          },
          byWorker: Object.fromEntries(
            Object.entries(report.byWorker).map(([name, ws]) => [name, {
              documents: ws.documents,
              chunks: ws.chunks,
              inputTokens: ws.inputTokens,
              outputTokens: ws.outputTokens,
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
          ...(conversionRecommendations.length > 0 ? { conversionRecommendations } : {}),
          guidance: 'Review the cost estimates. Run indexing_execute to prepare sources and begin extraction.',
        };
      } catch {
        return {
          currentPhase: Phase.PREPARE,
          ...getPhaseNavigation(Phase.PREPARE),
          message: 'No source list found. The pipeline has not been prepared yet.',
          guidance: 'Run indexing_execute to scan the source directory and initialize the pipeline.',
        };
      }
    }

    // Source list exists — show summary
    const statusCounts = this.countByStatus(sourceList.sources);
    return {
      currentPhase: Phase.PREPARE,
      ...getPhaseNavigation(Phase.PREPARE),
      message: `Prepared: ${sourceList.sources.length} source documents inventoried.`,
      sources: {
        total: sourceList.sources.length,
        byStatus: statusCounts,
      },
      ...(conversionRecommendations.length > 0 ? { conversionRecommendations } : {}),
      // A detector/config failure at this primary surface must not masquerade as
      // a clean corpus — surface it as a note (non-blocking), mirroring how the
      // diagnose tool reports the same failure.
      ...(detection.error !== undefined ? { conversionDetectionNote: detection.error } : {}),
      guidance: conversionRecommendations.length > 0
        ? 'Sources are inventoried. Some converted documents show possible table-structure corruption — see conversionRecommendations and apply the per-file re-convert before extracting. Run indexing_execute to start extraction.'
        : 'Sources are inventoried. Run indexing_execute to start extraction.',
    };
  }

  /**
   * Run the static table-structure detector over converted sources and return
   * non-blocking, options-aware re-convert recommendations. Best-effort — it
   * never fails the analyze call — but a real detector/config failure is
   * reported as `error` rather than silently collapsing to an empty result that
   * looks like a clean corpus.
   */
  private async tableCorruptionRecommendations(
    params: Record<string, unknown>,
  ): Promise<{ recommendations: TableCorruptionRecommendation[]; error?: string }> {
    try {
      const { config } = await resolveConfig(params);
      const orchestrator = new IndexingOrchestrator(config);
      return { recommendations: await orchestrator.detectTableCorruption() };
    } catch (error) {
      return { recommendations: [], error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async analyzeExtract(state: StateManager, verbose?: boolean, sourceFilter?: string) {
    const [sourceList, extractions, activeProgress] = await Promise.all([
      state.getSourceList(),
      state.getAllExtractionOutputs(),
      state.getActiveExtractionProgress(),
    ]);

    const statusCounts = sourceList ? this.countByStatus(sourceList.sources) : {};
    const failedSources = sourceList?.sources.filter(s => s.lastError) ?? [];

    let totalEntities = 0;
    let totalRelationships = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTimeMs = 0;

    for (const output of extractions) {
      totalEntities += output.entities.length;
      totalRelationships += output.relationships.length;
    }

    if (sourceList) {
      for (const source of sourceList.sources) {
        const tokens = source.actualTokens as { inputTokens?: number; outputTokens?: number } | undefined;
        if (tokens) {
          totalInputTokens += tokens.inputTokens ?? 0;
          totalOutputTokens += tokens.outputTokens ?? 0;
        }
        if (source.processingTimeMs) {
          totalTimeMs += source.processingTimeMs;
        }
      }
    }

    const activeExtractions = activeProgress.map(p => ({
      source: p.source,
      worker: p.assignedWorker,
      progress: `${p.completedChunks} / ${p.totalChunks} chunks`,
      elapsed: formatDuration(p.elapsedMs),
      estimatedRemaining: p.estimatedRemainingMs ? formatDuration(p.estimatedRemainingMs) : undefined,
      entitiesSoFar: p.entitiesSoFar,
      relationshipsSoFar: p.relationshipsSoFar,
    }));

    const result: Record<string, unknown> = {
      currentPhase: Phase.EXTRACT,
      ...getPhaseNavigation(Phase.EXTRACT),
      message: `Extraction in progress: ${extractions.length} sources extracted, ${totalEntities} entities, ${totalRelationships} relationships.`,
      sources: {
        total: sourceList?.sources.length ?? 0,
        byStatus: statusCounts,
      },
      extractions: {
        filesOnDisk: extractions.length,
        totalEntities,
        totalRelationships,
      },
      tokenUsage: totalInputTokens > 0 ? {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
      } : undefined,
      processingTime: totalTimeMs > 0 ? formatDuration(totalTimeMs) : undefined,
    };

    if (activeExtractions.length > 0) {
      result['activeExtractions'] = activeExtractions;
    }

    if (failedSources.length > 0) {
      result['failedSources'] = failedSources.map(s => ({
        path: s.path,
        lastError: s.lastError,
        attempts: s.attempts,
        assignedWorkers: s.assignedWorkers,
      }));
    }

    if (verbose && sourceList) {
      result['sourceDetail'] = sourceList.sources
        .filter(s => !sourceFilter || basename(s.path) === sourceFilter || s.path === sourceFilter)
        .map(s => ({
          filename: basename(s.path),
          path: s.path,
          status: s.status,
          assignedWorkers: s.assignedWorkers,
          extractionFiles: s.extractionFiles,
          selectedExtraction: s.selectedExtraction,
          estimatedChunks: s.estimatedTokens?.chunks,
          lastError: s.lastError,
          attempts: s.attempts,
        }));
    }

    const pending = (statusCounts['pending'] ?? 0) + (statusCounts['extracting'] ?? 0);
    result['guidance'] = pending > 0
      ? 'Extraction is ongoing. Run indexing_execute to continue, or indexing_stop to pause.'
      : 'All sources extracted. Run indexing_diagnose for quality checks, then indexing_update to advance.';

    return result;
  }

  private async analyzeExtractionReview(state: StateManager) {
    const [extractions, reviewReport] = await Promise.all([
      state.getAllExtractionOutputs(),
      state.getReviewDiagnostics<ReviewReport>(),
    ]);

    let totalEntities = 0;
    let totalRelationships = 0;
    for (const output of extractions) {
      totalEntities += output.entities.length;
      totalRelationships += output.relationships.length;
    }

    const result: Record<string, unknown> = {
      currentPhase: Phase.EXTRACTION_REVIEW,
      ...getPhaseNavigation(Phase.EXTRACTION_REVIEW),
      message: `Extraction complete. ${totalEntities} entities, ${totalRelationships} relationships across ${extractions.length} documents. Ready for review.`,
      extractions: {
        documentsExtracted: extractions.length,
        totalEntities,
        totalRelationships,
      },
    };

    if (reviewReport) {
      const a = reviewReport.aggregate;
      result['diagnosticsSummary'] = {
        overallRating: a.overallRating,
        propertyCoverage: `${(100 - a.zeroPropertyPercent).toFixed(1)}% (${a.propertyCoverageRating})`,
        orphanRelationships: `${a.orphanCount} / ${a.totalRelationships} (${a.orphanPercent}%)`,
        duplicates: a.duplicateCount,
        badLabels: a.badLabelCount,
      };
    }

    result['guidance'] = reviewReport
      ? 'Diagnostics available. Review the summary above. Next step options: (1) indexing_update phase "full-validation" for LLM verification against source documents, or (2) indexing_update phase "consolidate" to skip validation and proceed to deduplication. Ask the user which path to take.'
      : 'Run indexing_diagnose to generate extraction quality diagnostics before proceeding.';

    return result;
  }

  private async analyzeFullValidation(state: StateManager) {
    const [progress, report, processLock] = await Promise.all([
      state.getFullValidationProgress<FullValidationProgress>(),
      state.getFullValidationReport<FullValidationReport>(),
      state.getProcessLock(),
    ]);

    if (!progress) {
      return {
        currentPhase: 'full-validation',
        ...getPhaseNavigation('full-validation'),
        message: 'Full validation has not been started.',
        guidance: 'Run indexing_execute to start full LLM validation, or indexing_update with phase "consolidate" to skip to consolidation.',
      };
    }

    const rawValidatedCount = progress.validatedItemKeys?.length ?? 0;
    const totalItems = progress.totalEntities + progress.totalRelationships;
    const validatedCount = Math.min(rawValidatedCount, totalItems);
    const remainingItems = Math.max(0, totalItems - validatedCount);
    const isRunning = processLock?.operation === 'full-validation'
      && StateManager.isProcessAlive(processLock.pid);
    const isComplete = remainingItems === 0;
    const isStopped = !isComplete && !isRunning;

    const verdicts = progress.verdicts;
    const totalVerdicts = verdicts.confirmed + verdicts.mismatch + verdicts.hallucinated + verdicts.unverifiable + verdicts.corrected;

    const result: Record<string, unknown> = {
      currentPhase: 'full-validation',
      ...getPhaseNavigation('full-validation'),
      message: isComplete
        ? `Validation complete: ${validatedCount}/${totalItems} items. Cost: $${progress.cost.estimatedCost.toFixed(2)}`
        : isStopped
          ? `Validation paused: ${validatedCount}/${totalItems} items validated (${remainingItems} remaining). Run indexing_execute to continue.`
          : `Validation in progress: ${validatedCount}/${totalItems} items (${remainingItems} remaining).`,
      progress: {
        totalItems,
        validatedItems: validatedCount,
        remainingItems,
        percentComplete: totalItems > 0 ? `${((validatedCount / totalItems) * 100).toFixed(1)}%` : '0%',
      },
      verdicts: {
        total: totalVerdicts,
        confirmed: verdicts.confirmed,
        mismatch: verdicts.mismatch,
        hallucinated: verdicts.hallucinated,
        unverifiable: verdicts.unverifiable,
        corrected: verdicts.corrected,
        accuracyRate: totalVerdicts > 0
          ? `${(((verdicts.confirmed + verdicts.corrected) / totalVerdicts) * 100).toFixed(1)}%`
          : 'N/A',
      },
      cost: {
        inputTokens: progress.cost.inputTokens,
        outputTokens: progress.cost.outputTokens,
        estimatedCost: `$${progress.cost.estimatedCost.toFixed(2)}`,
      },
    };

    if (report) {
      result['corrections'] = {
        flaggedItems: report.flaggedItems.length,
        proposedCorrections: report.corrections.length,
      };
    }

    result['guidance'] = isComplete
      ? 'Validation complete. Review verdicts. Run indexing_execute with action "apply-corrections" to apply fixes, then indexing_update with phase "consolidate" to proceed.'
      : isStopped
        ? `${validatedCount}/${totalItems} items validated. Run indexing_execute to validate remaining items, or indexing_update with phase "consolidate" to proceed with current results.`
        : 'Validation in progress. Run indexing_analyze again to check progress, or indexing_stop to pause.';

    return result;
  }

  private async analyzeConsolidate(state: StateManager) {
    const [extractions, archives] = await Promise.all([
      state.getExtractionOutputs(),
      state.getExportArchives(),
    ]);

    let totalEntities = 0;
    let totalRelationships = 0;
    for (const output of extractions) {
      totalEntities += output.entities.length;
      totalRelationships += output.relationships.length;
    }

    return {
      currentPhase: Phase.CONSOLIDATE,
      ...getPhaseNavigation(Phase.CONSOLIDATE),
      message: `Ready for consolidation. ${totalEntities} entities, ${totalRelationships} relationships from ${extractions.length} documents.`,
      preConsolidation: {
        documentsExtracted: extractions.length,
        totalEntities,
        totalRelationships,
      },
      existingArchives: archives.length,
      guidance: 'Run indexing_execute to deduplicate entities, resolve references, and build the export archive.',
    };
  }

  private async analyzeConsolidationReview(state: StateManager) {
    const reviewReport = await state.getConsolidationReviewDiagnostics<ConsolidationReviewReport>();

    const result: Record<string, unknown> = {
      currentPhase: 'consolidation-review',
      ...getPhaseNavigation('consolidation-review'),
      message: 'Consolidation complete. Review merge quality before importing.',
    };

    if (reviewReport) {
      result['diagnosticsSummary'] = {
        mergeConfidence: reviewReport.mergeConfidence,
        aliasSpecificity: reviewReport.aliasSpecificity,
        crossSourceMerges: reviewReport.crossSourceMerges,
        typeConsistency: reviewReport.typeConsistency,
      };
    }

    result['guidance'] = reviewReport
      ? 'Review the merge diagnostics. Run indexing_update with phase "import" to proceed, or indexing_execute with action "reconsolidate" to re-run after corrections.'
      : 'Run indexing_diagnose to generate consolidation quality diagnostics.';

    return result;
  }

  private async analyzeImport(state: StateManager) {
    const [sourceList, registry] = await Promise.all([
      state.getSourceList(),
      state.getRegistry(),
    ]);

    const statusCounts = sourceList ? this.countByStatus(sourceList.sources) : {};
    const entityCount = registry?.entities.length ?? 0;

    return {
      currentPhase: Phase.IMPORT,
      ...getPhaseNavigation(Phase.IMPORT),
      message: `Ready to import ${entityCount} consolidated entities into repository.`,
      registryEntities: entityCount,
      repositoryId: registry?.repositoryId ?? sourceList?.repositoryId ?? null,
      storageType: sourceList?.repositoryId ? undefined : 'Check config.json import.storage.type',
      sources: { byStatus: statusCounts },
      guidance: 'Run indexing_execute to import consolidated entities and relationships into the deep-memory repository.',
    };
  }

  private async analyzeImportReview(state: StateManager) {
    const sourceList = await state.getSourceList();
    const statusCounts = sourceList ? this.countByStatus(sourceList.sources) : {};

    return {
      currentPhase: Phase.IMPORT_REVIEW,
      ...getPhaseNavigation(Phase.IMPORT_REVIEW),
      message: 'Import complete. Review results before embedding.',
      sources: { byStatus: statusCounts },
      guidance: 'Check import results for warnings (overwritten entities, orphaned relationships). Run indexing_update with phase "embeddings" to proceed.',
    };
  }

  private async analyzeEmbeddings(state: StateManager) {
    const embeddingProgress = await state.getEmbeddingProgress<EmbeddingProgress>();

    if (!embeddingProgress) {
      return {
        currentPhase: Phase.EMBEDDINGS,
        ...getPhaseNavigation(Phase.EMBEDDINGS),
        message: 'Ready for embedding generation.',
        guidance: 'Run indexing_execute to generate embedding vectors for all entities.',
      };
    }

    return {
      currentPhase: Phase.EMBEDDINGS,
      ...getPhaseNavigation(Phase.EMBEDDINGS),
      message: `Embeddings: ${embeddingProgress.processed} / ${embeddingProgress.totalEntities} entities.`,
      embedding: {
        status: embeddingProgress.status,
        progress: `${embeddingProgress.processed} / ${embeddingProgress.totalEntities} entities`,
        batches: `${embeddingProgress.completedBatches} / ${embeddingProgress.totalBatches}`,
        elapsed: formatDuration(embeddingProgress.elapsedMs),
        estimatedRemaining: embeddingProgress.estimatedRemainingMs
          ? formatDuration(embeddingProgress.estimatedRemainingMs) : undefined,
        failed: embeddingProgress.failed,
        model: embeddingProgress.model,
      },
      guidance: embeddingProgress.status === 'complete'
        ? 'Embeddings complete. The knowledge graph is ready to query.'
        : 'Embedding in progress. Run indexing_analyze again to check progress.',
    };
  }

  private async analyzeComplete(state: StateManager) {
    const [sourceList, extractions, registry, embeddingProgress] = await Promise.all([
      state.getSourceList(),
      state.getExtractionOutputs(),
      state.getRegistry(),
      state.getEmbeddingProgress<EmbeddingProgress>(),
    ]);

    let totalEntities = 0;
    let totalRelationships = 0;
    for (const output of extractions) {
      totalEntities += output.entities.length;
      totalRelationships += output.relationships.length;
    }

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    if (sourceList) {
      for (const source of sourceList.sources) {
        const tokens = source.actualTokens as { inputTokens?: number; outputTokens?: number } | undefined;
        if (tokens) {
          totalInputTokens += tokens.inputTokens ?? 0;
          totalOutputTokens += tokens.outputTokens ?? 0;
        }
      }
    }

    return {
      currentPhase: Phase.COMPLETE,
      ...getPhaseNavigation(Phase.COMPLETE),
      message: 'Pipeline complete. The knowledge graph is ready to query.',
      summary: {
        documents: sourceList?.sources.length ?? 0,
        extractedEntities: totalEntities,
        extractedRelationships: totalRelationships,
        registryEntities: registry?.entities.length ?? 0,
        repositoryId: registry?.repositoryId ?? sourceList?.repositoryId ?? null,
        embeddingsComplete: embeddingProgress?.status === 'complete',
      },
      tokenUsage: totalInputTokens > 0 ? {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      } : undefined,
      guidance: 'All phases complete. Use the deep-memory MCP server to query the knowledge graph.',
    };
  }

  private countByStatus(sources: Array<{ status: string }>): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const s of sources) {
      counts[s.status] = (counts[s.status] ?? 0) + 1;
    }
    return counts;
  }
}
