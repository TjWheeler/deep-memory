import { basename } from 'node:path';
import { BaseToolController } from './base/BaseToolController.js';
import { StateManager, Phase } from '@utaba/deep-memory-indexer';
import type { PipelinePhase, EmbeddingProgress, FullValidationProgress, ConversionProgress, ConversionReport } from '@utaba/deep-memory-indexer';
import { resolveStateDir, formatDuration } from './resolveProcess.js';

/**
 * Lightweight progress-polling tool for checking the status of any running
 * or recently completed operation: extraction, validation, consolidation,
 * import, or embeddings.
 *
 * Designed to be called repeatedly while waiting for a long-running operation.
 */
export class StatusTool extends BaseToolController {
  get name() { return 'indexing_status'; }
  get description() { return 'Check progress of any running or recently completed indexing operation — extraction, validation, consolidation, import, or embeddings. Lightweight polling tool: call repeatedly while waiting for long-running operations.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory (contains config.json).' },
        stateDir: { type: 'string', description: 'Use only for standalone state directories not inside a processDir. When processDir is provided, stateDir is resolved automatically to processDir/state/.' },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);

    const [phase, sourceList, rawActiveProgress, activeConversionProgress, embeddingProgress, fullValidationProgress, stopRequested, extractionStartedAt, processLock] = await Promise.all([
      state.getCurrentPhase(),
      state.getSourceList(),
      state.getActiveExtractionProgress(),
      state.getActiveConversionProgress(),
      state.getEmbeddingProgress<EmbeddingProgress>(),
      state.getFullValidationProgress<FullValidationProgress>(),
      state.isStopRequested(),
      state.getExtractionStartedAt(),
      state.getProcessLock(),
    ]);

    // Normalize active progress (assignedWorker may be undefined)
    const activeProgress = rawActiveProgress.map(p => ({
      ...p,
      assignedWorker: p.assignedWorker ?? 'unknown',
    }));

    // Check for active or pending conversion (runs during the prepare phase)
    const sources = sourceList?.sources ?? [];
    const needsConversion = sources.filter(s => s.status === 'needs-conversion').length;
    const converting = sources.filter(s => s.status === 'converting').length;
    if (processLock?.operation === 'conversion' || converting > 0 || (phase === Phase.PREPARE && needsConversion > 0)) {
      return this.conversionStatus(phase, needsConversion, converting, sources.filter(s => s.status !== 'excluded').length, stopRequested, processLock, activeConversionProgress);
    }

    // Check for active extraction
    if (activeProgress.length > 0 || phase === Phase.EXTRACT) {
      return this.extractionStatus(phase, sourceList, activeProgress, stopRequested, extractionStartedAt, processLock);
    }

    // Check for active full validation
    if (phase === ('full-validation' as PipelinePhase)) {
      if (fullValidationProgress) {
        const lockAlive = processLock?.operation === 'full-validation'
          ? StateManager.isProcessAlive(processLock.pid)
          : false;
        return this.fullValidationStatus(fullValidationProgress, stopRequested, lockAlive);
      }
      // No progress file yet — check if the process lock indicates a running or failed operation
      if (processLock?.operation === 'full-validation') {
        const pidAlive = StateManager.isProcessAlive(processLock.pid);
        return {
          currentPhase: 'full-validation',
          operation: 'full-validation',
          running: pidAlive,
          stale: !pidAlive ? true : undefined,
          stopRequested,
          progress: pidAlive
            ? { completed: 0, total: 0, percentage: 0, eta: null, note: 'Validation starting — building batches...' }
            : null,
          details: !pidAlive
            ? { error: `Validation process (PID ${processLock.pid}) is no longer running. The operation may have failed silently. Check MCP server logs and clear the stale lock with indexing_stop.` }
            : null,
        };
      }
    }

    // Check for active embeddings
    if (embeddingProgress && (embeddingProgress.status === 'running' || phase === Phase.EMBEDDINGS)) {
      return this.embeddingStatus(embeddingProgress, stopRequested);
    }

    // Nothing actively running — report idle state
    return {
      currentPhase: phase,
      operation: null,
      running: false,
      progress: null,
      details: null,
      stopRequested,
      lastCompleted: await this.detectLastCompleted(state, phase, sourceList, embeddingProgress, fullValidationProgress),
    };
  }

  private conversionStatus(
    phase: PipelinePhase,
    needsConversion: number,
    converting: number,
    total: number,
    stopRequested: boolean,
    processLock: { operation: string; acquiredAt: string; pid: number } | null,
    activeProgress: ConversionProgress[],
  ) {
    const lockAlive = processLock?.operation === 'conversion'
      ? StateManager.isProcessAlive(processLock.pid)
      : false;
    const running = converting > 0 && lockAlive;
    const remaining = needsConversion + converting;
    const completed = Math.max(0, total - remaining);

    // Enrich from the active conversion-progress file(s): current document,
    // async task state + queue position, live elapsed, and whether OCR is
    // running. Live elapsed is computed from startedAt so the timer ticks even
    // between polls.
    const activeConversions = activeProgress.map(p => {
      const liveElapsedMs = p.startedAt
        ? Date.now() - new Date(p.startedAt).getTime()
        : p.elapsedMs;
      return {
        source: basename(p.source),
        taskStatus: p.taskStatus,
        queuePosition: p.taskPosition,
        elapsed: formatDuration(liveElapsedMs),
        ocrRunning: p.ocrApplied ?? false,
      };
    });

    return {
      currentPhase: phase,
      operation: 'conversion',
      running,
      stale: converting > 0 && !lockAlive ? true : undefined,
      stopRequested,
      progress: {
        completed,
        total,
        percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
        eta: null,
      },
      details: {
        byStatus: { needsConversion, converting },
        activeConversions: activeConversions.length > 0 ? activeConversions : undefined,
      },
      guidance: running
        ? 'Conversion in progress. Poll indexing_status until it completes.'
        : `${needsConversion} source(s) need conversion. Start the docling-worker docker profile, then run indexing_execute action: "convert".`,
    };
  }

  private extractionStatus(
    phase: PipelinePhase,
    sourceList: { sources: Array<{ status: string; path: string; lastError?: string; attempts?: number; assignedWorkers?: string[]; actualTokens?: unknown; processingTimeMs?: number }> } | null,
    activeProgress: Array<{ source: string; sourcePath?: string; assignedWorker: string; completedChunks: number; totalChunks: number; startedAt: string; elapsedMs: number; estimatedRemainingMs?: number; entitiesSoFar: number; relationshipsSoFar: number; throttle?: { totalRetries: number; totalBackoffMs: number; lastThrottledAt?: string } }>,
    stopRequested: boolean,
    extractionStartedAt: string | null,
    processLock: { operation: string; acquiredAt: string; pid: number } | null,
  ) {
    const sources = sourceList?.sources ?? [];

    // Bug 1 fix: Build a set of source paths that have active progress files.
    // A source with an active progress file is being extracted regardless of
    // its status in the source list (which may have been reset to 'pending'
    // by a concurrent worker finishing a different source).
    const activeSourcePaths = new Set<string>();
    for (const p of activeProgress) {
      if (p.sourcePath) activeSourcePaths.add(p.sourcePath);
    }

    const extracted = sources.filter(s => s.status === 'extracted').length;
    const extracting = sources.filter(s =>
      s.status === 'extracting' || activeSourcePaths.has(s.path),
    ).length;
    // Sources with lastError that aren't actively extracting are "failed", not "pending"
    const failed = sources.filter(s =>
      s.status === 'pending' && s.lastError && !activeSourcePaths.has(s.path),
    ).length;
    const pending = sources.filter(s =>
      s.status === 'pending' && !s.lastError && !activeSourcePaths.has(s.path),
    ).length;
    const total = sources.filter(s => s.status !== 'excluded').length;
    const completed = extracted;

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalProcessingTimeMs = 0;
    for (const source of sources) {
      const tokens = source.actualTokens as { inputTokens?: number; outputTokens?: number } | undefined;
      if (tokens) {
        totalInputTokens += tokens.inputTokens ?? 0;
        totalOutputTokens += tokens.outputTokens ?? 0;
      }
      if (source.processingTimeMs) {
        totalProcessingTimeMs += source.processingTimeMs;
      }
    }

    // Check whether the process that owns the lock is still alive.
    // If progress files exist but the process is dead, the extraction is stale.
    const lockPidAlive = processLock ? StateManager.isProcessAlive(processLock.pid) : false;
    const hasActiveWork = extracting > 0 || activeProgress.length > 0;
    const isRunning = hasActiveWork && lockPidAlive;

    // Only compute live wall-clock time when the process is actually running.
    // Otherwise the timer keeps ticking after the extraction has stopped.
    const currentProcessingTimeMs = isRunning && extractionStartedAt
      ? Date.now() - new Date(extractionStartedAt).getTime()
      : null;

    return {
      currentPhase: phase,
      operation: 'extraction',
      running: isRunning,
      stale: hasActiveWork && !lockPidAlive ? true : undefined,
      stopRequested,
      progress: {
        completed,
        total,
        percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
        eta: this.estimateExtractionEta(sources, activeProgress),
      },
      details: {
        byStatus: { extracted, extracting, pending, failed },
        activeWorkers: activeProgress.map(p => {
          // Compute live elapsed from startedAt so the timer ticks even
          // while waiting for the first chunk to complete
          const liveElapsedMs = p.startedAt
            ? Date.now() - new Date(p.startedAt).getTime()
            : p.elapsedMs;
          return {
            source: basename(p.source),
            worker: p.assignedWorker,
            chunks: `${p.completedChunks}/${p.totalChunks}`,
            elapsed: formatDuration(liveElapsedMs),
            eta: p.estimatedRemainingMs ? formatDuration(p.estimatedRemainingMs) : null,
            entities: p.entitiesSoFar,
            relationships: p.relationshipsSoFar,
          };
        }),
        tokenUsage: totalInputTokens > 0 ? {
          inputTokens: totalInputTokens,
          outputTokens: totalOutputTokens,
        } : undefined,
        currentProcessingTimeMs: currentProcessingTimeMs != null ? currentProcessingTimeMs : undefined,
        currentProcessingTime: currentProcessingTimeMs != null ? formatDuration(currentProcessingTimeMs) : undefined,
        totalProcessingTimeMs: totalProcessingTimeMs > 0 ? totalProcessingTimeMs : undefined,
        totalProcessingTime: totalProcessingTimeMs > 0 ? formatDuration(totalProcessingTimeMs) : undefined,
        failures: failed > 0 ? sources.filter(s => s.lastError).map(s => ({
          source: basename(s.path),
          error: s.lastError,
          attempts: s.attempts,
          worker: s.assignedWorkers?.[0],
        })) : undefined,
      },
    };
  }

  private fullValidationStatus(progress: FullValidationProgress, stopRequested: boolean, lockAlive: boolean) {
    const validatedCount = progress.validatedItemKeys?.length ?? 0;
    const totalItems = progress.totalEntities + progress.totalRelationships;
    const remainingItems = Math.max(0, totalItems - validatedCount);
    const isComplete = remainingItems === 0 || !lockAlive;

    const verdicts = progress.verdicts;
    const totalVerdicts = verdicts.confirmed + verdicts.mismatch + verdicts.hallucinated + verdicts.unverifiable + verdicts.corrected;

    return {
      currentPhase: 'full-validation',
      operation: 'full-validation',
      running: !isComplete,
      stopRequested,
      progress: {
        completed: Math.min(validatedCount, totalItems),
        total: totalItems,
        percentage: totalItems > 0 ? Math.min(100, Math.round((validatedCount / totalItems) * 100)) : 0,
        eta: null,
      },
      details: {
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
      },
    };
  }

  private embeddingStatus(progress: EmbeddingProgress, stopRequested: boolean) {
    return {
      currentPhase: Phase.EMBEDDINGS,
      operation: 'embeddings',
      running: progress.status === 'running',
      stopRequested,
      progress: {
        completed: progress.processed,
        total: progress.totalEntities,
        percentage: progress.totalEntities > 0 ? Math.round((progress.processed / progress.totalEntities) * 100) : 0,
        eta: progress.estimatedRemainingMs ? formatDuration(progress.estimatedRemainingMs) : null,
      },
      details: {
        status: progress.status,
        batches: `${progress.completedBatches}/${progress.totalBatches}`,
        elapsed: formatDuration(progress.elapsedMs),
        failed: progress.failed,
        model: progress.model,
        stoppedReason: progress.stoppedReason,
        workers: progress.workerStats?.map(ws => ({
          name: ws.name,
          model: ws.model,
          status: ws.status,
          processed: ws.processed,
          batches: `${ws.completedBatches}/${ws.totalBatches}`,
          failed: ws.failed,
          cost: ws.estimatedCostUsd ? `$${ws.estimatedCostUsd.toFixed(3)}` : undefined,
          lastError: ws.lastError,
        })),
      },
    };
  }

  private async detectLastCompleted(
    state: StateManager,
    phase: PipelinePhase,
    sourceList: { sources: Array<{ status: string }> } | null,
    embeddingProgress: EmbeddingProgress | null,
    fullValidationProgress: FullValidationProgress | null,
  ): Promise<{ operation: string; summary: string } | null> {
    // Detect what completed most recently based on phase
    if (phase === Phase.COMPLETE) {
      return { operation: 'pipeline', summary: 'All phases complete.' };
    }
    if (embeddingProgress?.status === 'complete') {
      return { operation: 'embeddings', summary: `${embeddingProgress.processed} entities embedded.` };
    }
    if (fullValidationProgress) {
      const validated = fullValidationProgress.validatedItemKeys?.length ?? 0;
      const total = fullValidationProgress.totalEntities + fullValidationProgress.totalRelationships;
      if (validated >= total) {
        return { operation: 'full-validation', summary: `${validated} items validated.` };
      }
    }
    if (sourceList) {
      const extracted = sourceList.sources.filter(s => s.status === 'extracted' || s.status === 'consolidated' || s.status === 'imported').length;
      const total = sourceList.sources.filter(s => s.status !== 'excluded').length;
      if (extracted > 0 && extracted === total) {
        return { operation: 'extraction', summary: `${extracted} sources extracted.` };
      }
    }
    // Conversion completes during the prepare phase; surface its report summary
    // so a finished convert run is visible while the pipeline sits idle before
    // extraction. skippedUnchanged (not the blunt skipped count) is the true
    // idempotency figure.
    if (phase === Phase.PREPARE) {
      const report = await state.getConversionReport<ConversionReport>();
      if (report && report.entries.length > 0) {
        const { converted, skippedUnchanged, failed, totalTables } = report.summary;
        const parts = [`${converted} converted`, `${totalTables} tables`];
        if (skippedUnchanged > 0) parts.push(`${skippedUnchanged} skipped unchanged`);
        if (failed > 0) parts.push(`${failed} failed`);
        return { operation: 'conversion', summary: parts.join(', ') + '.' };
      }
    }
    return null;
  }

  private estimateExtractionEta(
    sources: Array<{ status: string; processingTimeMs?: number }>,
    activeProgress: Array<{ estimatedRemainingMs?: number }>,
  ): string | null {
    // If we have active progress with ETAs, use the max
    const activeEtas = activeProgress
      .map(p => p.estimatedRemainingMs)
      .filter((ms): ms is number => ms != null && ms > 0);
    if (activeEtas.length > 0) {
      return formatDuration(Math.max(...activeEtas));
    }

    // Estimate from average processing time
    const completedSources = sources.filter(s => s.status === 'extracted' && s.processingTimeMs);
    const pendingSources = sources.filter(s => s.status === 'pending' || s.status === 'extracting');
    if (completedSources.length > 0 && pendingSources.length > 0) {
      const avgMs = completedSources.reduce((sum, s) => sum + (s.processingTimeMs ?? 0), 0) / completedSources.length;
      return formatDuration(avgMs * pendingSources.length);
    }

    return null;
  }
}
