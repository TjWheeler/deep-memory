import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, extname, basename } from 'node:path';
import type { DeepMemory, ExportArchive, ImportResult } from '@utaba/deep-memory';
import type { OrchestratorConfig, WorkerConfig } from '../types/config.js';
import type { ExtractionOutput } from '../types/extraction.js';
import type { IndexSourceList, IndexSource } from '../types/source-list.js';
import type { EntityRegistry } from '../types/registry.js';
import type { ValidationResult } from '../types/validation.js';
import { StateManager, Phase } from './StateManager.js';
import type { PipelinePhase } from './StateManager.js';
import { ExtractionWorker } from '../extraction/ExtractionWorker.js';
import type { LLMProvider } from '../providers/LLMProvider.js';
import { DocumentAnalyzer, reassignFailedSource, estimateValidationCost } from './DocumentAnalyzer.js';
import type { AnalysisReport } from './DocumentAnalyzer.js';
import { Consolidator, type ConsolidationReport } from '../consolidation/Consolidator.js';
import { BatchImporter } from '../import/BatchImporter.js';
import { Validator } from '../validation/Validator.js';
import { ValidationRulesLoader } from '../validation/ValidationRulesLoader.js';
import { VerificationWorker, readSourceContent } from '../validation/VerificationWorker.js';
import { ReviewDiagnostics } from '../review/ReviewDiagnostics.js';
import { ConsolidationReviewDiagnostics } from '../review/ConsolidationReviewDiagnostics.js';
import type { ConsolidationReviewReport } from '../review/consolidation-review-types.js';
import type { ReviewReport } from '../review/types.js';
import { FullValidationOrchestrator } from '../validation/FullValidationOrchestrator.js';
import { summarizeVocabularyForValidation } from '../validation/VocabularySummarizer.js';
import type { FullValidationRunOptions, FullValidationProgressCallbacks } from '../validation/FullValidationOrchestrator.js';
import type { FullValidationProgress, FullValidationReport, FullValidationConfig } from '../validation/full-validation-types.js';

/** Result from a full pipeline run */
export interface PipelineResult {
  phase: PipelinePhase;
  sourcesExtracted: number;
  entitiesFound: number;
  relationshipsFound: number;
  consolidationReport?: ConsolidationReport;
  importResult?: ImportResult;
  validationResults?: ValidationResult[];
}

/**
 * Top-level pipeline controller for the indexing workflow.
 *
 * Manages the full pipeline: prepare → extract → consolidate → import.
 * Designed to be resumable — inspects state on disk and picks up where
 * it left off if the process was interrupted.
 */
export class IndexingOrchestrator {
  private readonly state: StateManager;
  private readonly logDir: string;
  private readonly llmProviders = new Map<string, LLMProvider>();
  private vocabulary: string | null = null;
  private extractionRules: string | null = null;
  private domainGuidance: string | null = null;
  private abortController: AbortController | null = null;

  constructor(private readonly config: OrchestratorConfig) {
    this.state = new StateManager(config.stateDir);
    // Logs go in a sibling 'logs' directory next to state
    this.logDir = join(dirname(config.stateDir), 'logs');
  }

  /**
   * Register a named LLM provider for worker routing.
   * Workers with a matching `llmProvider` config value will use this provider.
   */
  registerLLMProvider(name: string, provider: LLMProvider): void {
    this.llmProviders.set(name, provider);
  }

  /** Get the StateManager for direct state inspection */
  getStateManager(): StateManager {
    return this.state;
  }

  /**
   * Prepare: scan source documents, initialize state directory.
   * Idempotent — safe to call multiple times. Skips sources already in the list.
   */
  async prepare(sourceDir: string): Promise<IndexSourceList> {
    await this.state.initialize();
    await this.state.setPipelineState(Phase.PREPARE);

    // Load existing source list or create new
    let sourceList = await this.state.getSourceList();
    if (!sourceList) {
      sourceList = {
        version: '1.0.0',
        repositoryId: this.config.repositoryId,
        sources: [],
      };
    }

    // Scan the source directory for documents
    const existingPaths = new Set(sourceList.sources.map(s => s.path));
    const newSources = await this.scanSourceDirectory(sourceDir);

    for (const source of newSources) {
      if (!existingPaths.has(source.path)) {
        sourceList.sources.push(source);
      }
    }

    await this.state.saveSourceList(sourceList);

    // Initialize empty registry if none exists
    const registry = await this.state.getRegistry();
    if (!registry) {
      await this.state.saveRegistry({
        version: '1.0.0',
        repositoryId: this.config.repositoryId,
        lastUpdated: new Date().toISOString(),
        entities: [],
      });
    }

    return sourceList;
  }

  /**
   * Pre-indexing analysis: estimate tokens, assign workers, calculate costs.
   * Pure calculation — no LLM calls. Uses actual token data from prior
   * extractions when available, falling back to estimates for new documents.
   * Writes the report to the state directory.
   */
  async analyze(): Promise<AnalysisReport> {
    const sourceList = await this.state.getSourceList();
    if (!sourceList || sourceList.sources.length === 0) {
      throw new Error('No source list found — run prepare() first');
    }

    const analyzer = DocumentAnalyzer.fromExtractionConfig(this.config.extraction);
    const report = await analyzer.analyze(sourceList.sources);

    // Persist worker assignments back to the source list
    for (const doc of report.documents) {
      if (doc.assignedWorkers.length > 0) {
        const source = sourceList.sources.find(s => s.path === doc.path);
        if (source && (!source.assignedWorkers || source.assignedWorkers.length === 0)) {
          source.assignedWorkers = doc.assignedWorkers;
          source.estimatedTokens = doc.estimatedTokens;
        }
      }
    }
    await this.state.saveSourceList(sourceList);

    // Add full extraction validation cost estimate if fullValidation is configured
    if (this.config.fullValidation) {
      const extractions = await this.state.getExtractionOutputs();
      if (extractions.length > 0) {
        const totalEntities = extractions.reduce((s, e) => s + e.entities.length, 0);
        const totalRelationships = extractions.reduce((s, e) => s + e.relationships.length, 0);
        report.validationEstimate = estimateValidationCost(
          totalEntities,
          totalRelationships,
          this.config.fullValidation,
        );
      }
    }

    await this.state.saveAnalysisReport(report);

    return report;
  }

  /**
   * Extract: Run extraction workers in parallel.
   * Resumes from where it left off — skips sources with status >= 'extracted'.
   * Checks for stop signals between documents and cancels in-flight HTTP
   * requests via AbortController when any worker fails.
   *
   * Multi-worker routing: when `config.extraction.workers` is set, the
   * orchestrator assigns each document to a worker based on its
   * `assignedWorker` field (set by analyze or manual override). Documents
   * without an assignment get auto-assigned via DocumentAnalyzer.
   *
   * Intelligent retry: when `config.extraction.autoReassignFailures` is true,
   * failed documents are reassigned to a more capable worker and retried
   * within the same extraction pass.
   */
  async extract(): Promise<ExtractionOutput[]> {
    await this.state.setPipelineState(Phase.EXTRACT);
    await this.loadVocabularyAndRules();

    // Clear any stale stop signal and reset stuck sources from prior runs
    await this.state.clearStopRequest();
    await this.state.resetExtractingSources();

    // Record wall-clock start time for the current extraction run
    await this.state.setExtractionStartedAt();

    let pendingSources = await this.state.getSourcesByStatus('pending');

    // Apply sourceFilter — only process matching sources
    const { sourceFilter, maxItems } = this.config.extraction;
    if (sourceFilter && sourceFilter.length > 0) {
      pendingSources = pendingSources.filter(s =>
        sourceFilter.some(filter =>
          s.path === filter || s.path.includes(filter),
        ),
      );
    }

    // Apply maxItems limit
    if (maxItems !== undefined && maxItems > 0) {
      pendingSources = pendingSources.slice(0, maxItems);
    }

    if (pendingSources.length === 0) {
      return this.state.getExtractionOutputs();
    }

    // Resolve worker pool
    const workerPool = this.config.extraction.workers;
    const hasWorkerPool = workerPool && workerPool.length > 0;

    // Auto-assign workers for any sources that don't have any yet
    if (hasWorkerPool) {
      const analyzer = new DocumentAnalyzer({ workers: workerPool });
      for (const source of pendingSources) {
        if (!source.assignedWorkers || source.assignedWorkers.length === 0) {
          const stats = await stat(source.path).catch(() => null);
          const sizeBytes = stats?.size ?? 0;
          const documentTokens = Math.ceil(sizeBytes / 4);
          const workerName = analyzer.assignWorker(source, documentTokens);
          if (workerName) {
            source.assignedWorkers = [workerName];
            await this.state.updateSource(source.path, { assignedWorkers: [workerName] });
          }
        }
      }
    }

    // Create a shared AbortController
    this.abortController = new AbortController();
    const { signal } = this.abortController;

    // Poll for stop requests and translate them into abort signals.
    // This ensures that long-running progressive extractions (many chunks
    // per document) are interrupted promptly, not just between documents.
    const stopPoller = setInterval(async () => {
      try {
        if (await this.state.isStopRequested()) {
          this.abortController?.abort();
        }
      } catch {
        // Polling should never break extraction
      }
    }, 2_000);

    const results: ExtractionOutput[] = [];
    const failedSources: IndexSource[] = [];

    // Call beforeRun on all registered providers
    for (const provider of this.llmProviders.values()) {
      await provider.beforeRun?.({
        vocabulary: this.vocabulary!,
        extractionRules: this.extractionRules ?? undefined,
        domainGuidance: this.domainGuidance ?? undefined,
        model: provider.name,
      });
    }

    try {
      // Execute extraction — group by worker for multi-worker, or run flat for single-worker
      if (hasWorkerPool) {
        await this.extractWithWorkerPool(workerPool, pendingSources, signal, results, failedSources);
      } else {
        await this.extractWithSingleWorker(pendingSources, signal, results, failedSources);
      }
    } finally {
      clearInterval(stopPoller);

      // Call afterRun on all registered providers
      for (const provider of this.llmProviders.values()) {
        await provider.afterRun?.().catch(() => {});
      }
    }

    // Intelligent retry: reassign failed docs to more capable workers
    if (
      hasWorkerPool &&
      this.config.extraction.autoReassignFailures &&
      failedSources.length > 0 &&
      !signal.aborted
    ) {
      // Build retry queue — each entry only runs the newly assigned worker
      const retryQueue: Array<{ source: IndexSource; retryWorker: string }> = [];
      for (const source of failedSources) {
        const currentWorkers = source.assignedWorkers ?? ['default'];
        const failedWorker = currentWorkers[currentWorkers.length - 1] ?? 'default';
        const newWorker = reassignFailedSource(source, workerPool, failedWorker);
        if (newWorker) {
          // Add the new worker to the list rather than replacing
          const updatedWorkers = [...currentWorkers, newWorker];
          source.assignedWorkers = updatedWorkers;
          source.status = 'pending';
          await this.state.updateSource(source.path, {
            assignedWorkers: updatedWorkers,
            status: 'pending',
            attempts: (source.attempts ?? 1),
          });
          retryQueue.push({ source, retryWorker: newWorker });
        }
      }

      if (retryQueue.length > 0 && !signal.aborted) {
        // Only run the newly assigned worker for each source — temporarily
        // set assignedWorkers to just the retry worker so extractWithWorkerPool
        // doesn't re-queue already-completed workers
        const retrySources = retryQueue.map(({ source, retryWorker }) => {
          const original = source.assignedWorkers;
          source.assignedWorkers = [retryWorker];
          return { source, original };
        });
        const retryFailed: IndexSource[] = [];
        await this.extractWithWorkerPool(workerPool, retrySources.map(r => r.source), signal, results, retryFailed);
        // Restore the full assignedWorkers list
        for (const { source, original } of retrySources) {
          source.assignedWorkers = original;
        }
      }
    }

    this.abortController = null;

    return this.state.getExtractionOutputs();
  }

  /**
   * Run extraction using the single default worker.
   */
  private async extractWithSingleWorker(
    sources: IndexSource[],
    signal: AbortSignal,
    results: ExtractionOutput[],
    failedSources: IndexSource[],
  ): Promise<void> {
    const worker = new ExtractionWorker(
      this.config.extraction,
      this.vocabulary!,
      this.extractionRules ?? undefined,
      undefined,
      this.logDir,
      undefined,
      this.domainGuidance ?? undefined,
    );

    const concurrency = this.config.extraction.concurrency;
    const queue = [...sources];

    const runWorker = async (): Promise<void> => {
      while (queue.length > 0) {
        if (signal.aborted || await this.state.isStopRequested()) {
          queue.length = 0;
          return;
        }

        const source = queue.shift()!;
        await this.extractOneDocument(source, worker, 'default', signal, results, failedSources);
      }
    };

    const workers = Array.from(
      { length: Math.min(concurrency, queue.length) },
      () => runWorker(),
    );
    await Promise.all(workers);
  }

  /**
   * Run extraction using a worker pool — each source is added to every
   * assigned worker's queue so multiple workers can extract the same file.
   */
  private async extractWithWorkerPool(
    workerPool: WorkerConfig[],
    sources: IndexSource[],
    signal: AbortSignal,
    results: ExtractionOutput[],
    failedSources: IndexSource[],
  ): Promise<void> {
    // Group sources by assigned worker — a source with multiple assignedWorkers
    // appears in multiple worker queues
    const byWorker = new Map<string, IndexSource[]>();
    for (const source of sources) {
      const workers = source.assignedWorkers ?? ['default'];
      for (const name of workers) {
        let list = byWorker.get(name);
        if (!list) {
          list = [];
          byWorker.set(name, list);
        }
        list.push(source);
      }
    }

    // Run all worker groups in parallel
    const workerPromises: Promise<void>[] = [];

    for (const [workerName, workerSources] of byWorker) {
      const workerConfig = workerPool.find(w => w.name === workerName);
      if (!workerConfig) {
        // Fallback: unassigned documents use the default extraction config
        const fallbackWorker = new ExtractionWorker(
          this.config.extraction,
          this.vocabulary!,
          this.extractionRules ?? undefined,
          undefined,
          this.logDir,
          undefined,
          this.domainGuidance ?? undefined,
        );
        const queue = [...workerSources];
        const concurrency = this.config.extraction.concurrency;
        const run = async (): Promise<void> => {
          while (queue.length > 0) {
            if (signal.aborted || await this.state.isStopRequested()) {
              queue.length = 0;
              return;
            }
            const source = queue.shift()!;
            await this.extractOneDocument(source, fallbackWorker, workerName, signal, results, failedSources);
          }
        };
        workerPromises.push(
          ...Array.from({ length: Math.min(concurrency, queue.length) }, () => run()),
        );
        continue;
      }

      // Resolve provider for this worker — look up by llmProvider name
      const providerName = workerConfig.llmProvider;
      const provider = providerName ? this.llmProviders.get(providerName) : undefined;

      const extractionWorker = new ExtractionWorker(
        this.config.extraction,
        this.vocabulary!,
        this.extractionRules ?? undefined,
        workerConfig,
        this.logDir,
        provider,
        this.domainGuidance ?? undefined,
      );
      const queue = [...workerSources];
      const concurrency = workerConfig.concurrency;

      const run = async (): Promise<void> => {
        while (queue.length > 0) {
          if (signal.aborted || await this.state.isStopRequested()) {
            queue.length = 0;
            return;
          }
          const source = queue.shift()!;
          await this.extractOneDocument(source, extractionWorker, workerName, signal, results, failedSources);
        }
      };

      workerPromises.push(
        ...Array.from({ length: Math.min(concurrency, Math.max(1, queue.length)) }, () => run()),
      );
    }

    await Promise.all(workerPromises);
  }

  /**
   * Extract a single document with a specific worker, handling status updates,
   * error tracking, and token usage. Stores output in extraction-notes/{workerName}/.
   * On failure, records lastError and attempts on the source and adds it to failedSources
   * instead of throwing — allowing the orchestrator to continue with other documents.
   */
  private async extractOneDocument(
    source: IndexSource,
    worker: ExtractionWorker,
    workerName: string,
    signal: AbortSignal,
    results: ExtractionOutput[],
    failedSources: IndexSource[],
  ): Promise<void> {
    const sourceFilename = basename(source.path);
    const startTime = Date.now();
    try {
      await this.state.updateSource(source.path, { status: 'extracting' });

      // Write an initial progress file so the status tool can see this worker
      // is active even before the first chunk completes
      const initialProgress: import('../extraction/ExtractionProgress.js').ExtractionProgress = {
        source: sourceFilename,
        sourcePath: source.path,
        assignedWorker: workerName,
        totalChunks: 0,
        completedChunks: 0,
        startedAt: new Date().toISOString(),
        elapsedMs: 0,
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        entitiesSoFar: 0,
        relationshipsSoFar: 0,
      };
      await this.state.writeExtractionProgress(sourceFilename, initialProgress, workerName);

      // Wire up progress reporting — writes progress file after each chunk
      const onProgress = async (progress: import('../extraction/ExtractionProgress.js').ExtractionProgress) => {
        await this.state.writeExtractionProgress(sourceFilename, progress, workerName);
      };

      // Wire up checkpoint writing — persists extraction state for resume capability
      const onCheckpoint = async (checkpoint: import('../extraction/ExtractionProgress.js').ExtractionCheckpoint) => {
        await this.state.writeExtractionCheckpoint(sourceFilename, checkpoint, workerName);
      };

      // Check for existing checkpoint to resume from
      const resumeCheckpoint = await this.state.getExtractionCheckpoint(sourceFilename, workerName) ?? undefined;

      const output = await worker.extract(source, signal, onProgress, onCheckpoint, resumeCheckpoint);

      // Update status to deduplicating while post-processing
      await this.state.updateSource(source.path, { status: 'deduplicating' });

      const processingTimeMs = Date.now() - startTime;

      // Save output to extraction-notes/{workerName}/
      const extractionFile = await this.state.saveExtractionOutput(output, workerName);

      // Atomically record this worker's completion — re-reads source list fresh
      // to avoid race conditions when multiple workers finish concurrently
      await this.state.recordExtractionComplete(source.path, workerName, extractionFile, {
        actualTokens: output.usage,
        processingTimeMs,
      });

      // Clean up progress and checkpoint files now that extraction is complete
      await this.state.deleteExtractionProgress(sourceFilename, workerName);
      await this.state.deleteExtractionCheckpoint(sourceFilename, workerName);

      results.push(output);
    } catch (error) {
      const processingTimeMs = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Atomically record error — re-reads source list fresh to avoid
      // stomping extractionFiles from workers that succeeded concurrently
      await this.state.recordExtractionError(source.path, workerName, errorMessage, processingTimeMs);

      // Clean up progress file on failure (but keep checkpoint for resume!)
      await this.state.deleteExtractionProgress(sourceFilename, workerName);

      // If this was a cancellation or stop request, don't add to failedSources
      if (signal.aborted || await this.state.isStopRequested()) {
        return;
      }

      failedSources.push(source);
    }
  }

  /**
   * Extraction review: Run review diagnostics on extraction outputs.
   * Pure computation — no LLM calls. Checks entity type distribution,
   * property coverage, orphan relationships, duplicates, and label quality.
   * Persists the report to state/review-diagnostics.json.
   */
  async reviewDiagnostics(sourceFilter?: string[], workerName?: string): Promise<ReviewReport> {
    const diagnostics = new ReviewDiagnostics(this.state, this.config.qualityThresholds.extraction);
    return diagnostics.run(sourceFilter, workerName);
  }

  /**
   * Consolidation review: Run consolidation review diagnostics.
   * Analyzes merge decisions for false merges, alias specificity issues,
   * cross-source anomalies, and type consistency problems.
   */
  async consolidationReviewDiagnostics(): Promise<ConsolidationReviewReport> {
    const diagnostics = new ConsolidationReviewDiagnostics(this.state, this.config.qualityThresholds.consolidation);
    return diagnostics.run();
  }

  /**
   * Full extraction validation.
   *
   * LLM-powered validation of every entity and relationship against source documents.
   * Workers use tool access to navigate source documents (read lines, search, cross-reference).
   *
   * Resumable — loads existing progress and skips completed batches.
   * The `config` parameter overrides the static config from disk.
   *
   * @param config - Validation worker configuration (from config.json validation section)
   * @param options - Run options (mode, worker override, filters, limits)
   * @param callbacks - Optional progress callbacks
   * @param signal - AbortSignal for cancellation
   */
  async validateFull(
    config: FullValidationConfig,
    options: FullValidationRunOptions = {},
    callbacks: FullValidationProgressCallbacks = {},
    signal?: AbortSignal,
  ): Promise<{ progress: FullValidationProgress; report: FullValidationReport }> {
    // Clear stale state from prior runs
    await this.state.clearStopRequest();
    await this.state.clearFullValidationState();

    const extractions = await this.state.getExtractionOutputs();
    if (extractions.length === 0) {
      throw new Error('No extraction outputs found — run extract() first');
    }

    // Load vocabulary and domain guidance for validation context
    await this.loadVocabularyAndRules();
    const vocabularySummary = this.vocabulary
      ? summarizeVocabularyForValidation(this.vocabulary)
      : undefined;

    const orchestrator = new FullValidationOrchestrator(config, this.llmProviders, this.logDir, vocabularySummary, this.domainGuidance ?? undefined);

    // Wrap callbacks to also persist progress after each batch
    const wrappedCallbacks: FullValidationProgressCallbacks = {
      ...callbacks,
      onProgress: async (progress) => {
        await this.state.saveFullValidationProgress(progress);
        callbacks.onProgress?.(progress);
      },
    };

    const { progress, report } = await orchestrator.run(
      extractions,
      null,
      options,
      wrappedCallbacks,
      signal,
      () => this.state.isStopRequested(),
    );

    // Persist final state and report
    await this.state.saveFullValidationProgress(progress);
    await this.state.saveFullValidationReport(report);

    // Persist corrections if in fix mode
    if (report.corrections.length > 0) {
      await this.state.saveFullValidationCorrections(report.corrections);
    }

    return { progress, report };
  }

  /**
   * Validate all extraction outputs.
   * Runs Tier 1 (schema + range + structural) and optionally Tier 2 (source-grounded LLM verification).
   * Returns validation results per extraction. Extractions that fail are not consolidated.
   */
  async validate(): Promise<ValidationResult[]> {
    const validationConfig = this.config.validation;
    if (!validationConfig) {
      // No validation configured — return empty results (all pass)
      return [];
    }

    await this.loadVocabularyAndRules();
    const extractions = await this.state.getExtractionOutputs();

    if (extractions.length === 0) {
      return [];
    }

    // Load validation rules
    const rules = await ValidationRulesLoader.load(validationConfig.rulesPath);
    const validator = new Validator(rules, this.vocabulary!);

    const results: ValidationResult[] = [];

    for (const extraction of extractions) {
      // Tier 1
      const result = validator.validate(extraction);

      // Tier 2 (if configured and scope applies)
      if (validationConfig.verificationEndpoint && validationConfig.verificationModel) {
        const shouldVerify =
          validationConfig.tier2Scope === 'all'
          || (validationConfig.tier2Scope === 'flagged-only' && result.errors.length > 0)
          || validationConfig.tier2Scope === 'sample';

        if (shouldVerify) {
          try {
            const sourceContent = await readSourceContent(extraction.sourcePath);
            const worker = new VerificationWorker({
              endpoint: validationConfig.verificationEndpoint,
              model: validationConfig.verificationModel,
            });

            // Build flagged property set from Tier 1 errors
            const flaggedProperties = new Set(
              result.errors
                .filter(e => e.entityLabel && e.property)
                .map(e => `${e.entityLabel}:${e.property}`),
            );

            const { tier2, issues } = await worker.verify(
              extraction,
              sourceContent,
              validationConfig.tier2Scope,
              validationConfig.tier2SamplePercent,
              flaggedProperties,
            );

            result.tier2 = tier2;
            for (const issue of issues) {
              if (issue.severity === 'error') {
                result.errors.push(issue);
              } else {
                result.warnings.push(issue);
              }
            }

            // Recalculate overall verdict
            if (result.errors.length > 0) {
              result.overallVerdict = 'fail';
            } else if (result.warnings.length > 0) {
              result.overallVerdict = 'warnings';
            }
          } catch {
            // Tier 2 failure is non-fatal — mark as warning
            result.warnings.push({
              tier: 2,
              severity: 'warning',
              message: `[verification] Tier 2 verification failed for "${extraction.source}" — skipping`,
            });
            if (result.overallVerdict === 'pass') {
              result.overallVerdict = 'warnings';
            }
          }
        }
      }

      results.push(result);
    }

    // Save validation report
    await this.state.saveValidationReport(results);

    return results;
  }

  /**
   * Consolidate all extractions into a deduplicated export archive.
   * Reads all extraction outputs, deduplicates, assigns GUIDs, produces ExportArchive.
   */
  async consolidate(): Promise<{ registry: EntityRegistry; archive: ExportArchive; report: ConsolidationReport }> {
    await this.state.setPipelineState(Phase.CONSOLIDATE);
    await this.loadVocabularyAndRules();
    const extractions = await this.state.getExtractionOutputs();

    if (extractions.length === 0) {
      throw new Error('No extraction outputs found — run extract() first');
    }

    const existingRegistry = await this.state.getRegistry();
    const consolidator = new Consolidator(this.config.consolidation, this.vocabulary!);

    const result = await consolidator.consolidate(
      extractions,
      existingRegistry ?? undefined,
      this.config.repositoryId,
    );

    // Save updated registry and merge log
    await this.state.saveRegistry(result.registry);
    await this.state.saveMergeLog(result.mergeLog);

    // Update source statuses to consolidated
    const sourceList = await this.state.getSourceList();
    if (sourceList) {
      for (const source of sourceList.sources) {
        if (source.status === 'extracted') {
          source.status = 'consolidated';
        }
      }
      await this.state.saveSourceList(sourceList);
    }

    return result;
  }

  /**
   * Import an ExportArchive into the repository via DeepMemory.
   */
  async importArchive(archive: ExportArchive, deepMemory: DeepMemory): Promise<ImportResult> {
    const importer = new BatchImporter(deepMemory);

    const result = await importer.import(archive, {
      mode: 'create',
      repositoryId: this.config.repositoryId,
    });

    if (result.success) {
      // Update registry entries to imported
      const registry = await this.state.getRegistry();
      if (registry) {
        for (const entry of registry.entities) {
          if (entry.status === 'consolidated') {
            entry.status = 'imported';
          }
        }
        await this.state.saveRegistry(registry);
      }

      // Update source statuses
      const sourceList = await this.state.getSourceList();
      if (sourceList) {
        for (const source of sourceList.sources) {
          if (source.status === 'consolidated') {
            source.status = 'imported';
          }
        }
        await this.state.saveSourceList(sourceList);
      }

    }

    return result;
  }

  /**
   * Run the full pipeline, resuming from the appropriate phase based on state.
   * Pass deepMemory to enable the import phase; omit to stop after consolidation.
   */
  async run(sourceDir: string, deepMemory?: DeepMemory): Promise<PipelineResult> {
    let currentPhase = await this.state.getCurrentPhase();

    let sourcesExtracted = 0;
    let entitiesFound = 0;
    let relationshipsFound = 0;
    let consolidationReport: ConsolidationReport | undefined;
    let importResult: ImportResult | undefined;
    let validationResults: ValidationResult[] | undefined;

    // Check for paused pipeline
    if (currentPhase === Phase.IMPORT_REVIEW) {
      return {
        phase: Phase.IMPORT_REVIEW,
        sourcesExtracted: 0,
        entitiesFound: 0,
        relationshipsFound: 0,
      };
    }

    // Extraction complete — pause for review before consolidation
    if (currentPhase === Phase.EXTRACTION_REVIEW) {
      return {
        phase: Phase.EXTRACTION_REVIEW,
        sourcesExtracted: 0,
        entitiesFound: 0,
        relationshipsFound: 0,
      };
    }

    // Prepare + Extract
    if (currentPhase === Phase.PREPARE || currentPhase === Phase.EXTRACT) {
      if (currentPhase === Phase.PREPARE) {
        await this.prepare(sourceDir);
      }

      const outputs = await this.extract();
      sourcesExtracted = outputs.length;
      for (const output of outputs) {
        entitiesFound += output.entities.length;
        relationshipsFound += output.relationships.length;
      }
      currentPhase = await this.state.getCurrentPhase();
    }

    // Validate extraction outputs
    if (currentPhase === Phase.CONSOLIDATE && this.config.validation) {
      validationResults = await this.validate();
      const failedCount = validationResults.filter(r => r.overallVerdict === 'fail').length;
      if (failedCount > 0) {
        // Some extractions failed validation — don't proceed to consolidation
        return {
          phase: Phase.EXTRACTION_REVIEW,
          sourcesExtracted,
          entitiesFound,
          relationshipsFound,
          validationResults,
        };
      }
    }

    // Consolidate
    if (currentPhase === Phase.CONSOLIDATE) {
      const result = await this.consolidate();
      consolidationReport = result.report;
      entitiesFound = result.archive.entities.length;
      relationshipsFound = result.archive.relationships.length;

      // Import
      if (deepMemory) {
        importResult = await this.importArchive(result.archive, deepMemory);
      }
    }

    // Import (resume — archive already exists)
    if (currentPhase === Phase.IMPORT && deepMemory) {
      // Re-consolidate to get the archive (it's not persisted to disk as a zip)
      const result = await this.consolidate();
      importResult = await this.importArchive(result.archive, deepMemory);
    }

    return {
      phase: await this.state.getCurrentPhase(),
      sourcesExtracted,
      entitiesFound,
      relationshipsFound,
      consolidationReport,
      importResult,
      validationResults,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private async loadVocabularyAndRules(): Promise<void> {
    if (!this.vocabulary) {
      this.vocabulary = await readFile(this.config.vocabularyPath, 'utf-8');
    }
    if (!this.extractionRules && this.config.extractionRulesPath) {
      try {
        this.extractionRules = await readFile(this.config.extractionRulesPath, 'utf-8');
      } catch {
        // Extraction rules are optional
        this.extractionRules = null;
      }
    }
    if (!this.domainGuidance && this.config.domainGuidancePath) {
      try {
        this.domainGuidance = await readFile(this.config.domainGuidancePath, 'utf-8');
      } catch {
        // Domain guidance is optional
        this.domainGuidance = null;
      }
    }
  }

  /** Scan a directory recursively for indexable documents */
  private async scanSourceDirectory(dir: string): Promise<IndexSource[]> {
    const sources: IndexSource[] = [];
    const indexableExtensions = new Set(['.md', '.txt', '.json', '.csv']);

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (indexableExtensions.has(extname(entry.name).toLowerCase())) {
          const stats = await stat(fullPath);
          sources.push({
            path: fullPath,
            type: inferDocumentType(entry.name),
            status: 'pending',
            notes: `${Math.round(stats.size / 1024)} KB`,
          });
        }
      }
    };

    await walk(dir);
    return sources;
  }
}

/** Infer document type from filename patterns */
function inferDocumentType(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes('spec-sheet') || lower.includes('specsheet')) return 'spec-sheet';
  if (lower.includes('performance-handbook') || lower.includes('performance_handbook')) return 'performance-handbook';
  if (lower.includes('om-manual') || lower.includes('o&m') || lower.includes('operation')) return 'om-manual';
  if (lower.includes('parts-catalog') || lower.includes('parts_catalog')) return 'parts-catalog';
  if (lower.includes('troubleshoot')) return 'troubleshooting';
  return 'general';
}
