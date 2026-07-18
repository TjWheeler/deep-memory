import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname, extname, basename } from 'node:path';
import type { DeepMemory, ExportArchive, ImportResult } from '@utaba/deep-memory';
import type { OrchestratorConfig, WorkerConfig } from '../types/config.js';
import type { ExtractionOutput } from '../types/extraction.js';
import type { IndexSourceList, IndexSource } from '../types/source-list.js';
import type { EntityRegistry } from '../types/registry.js';
import type { ValidationResult } from '../types/validation.js';
import { InvalidInputError } from '@utaba/deep-memory';
import { StateManager, Phase } from './StateManager.js';
import type { PipelinePhase } from './StateManager.js';
import { DoclingClient } from '../conversion/DoclingClient.js';
import { convertSources, mergeConvertOptions, convertOptionsEqual, type DocumentConverterSummary } from '../conversion/DocumentConverter.js';
import { matchesSourceFilter } from '../conversion/source-filter.js';
import { TableStructureDetector, buildTableCorruptionRecommendation } from '../conversion/TableStructureDetector.js';
import type { TableCorruptionRecommendation } from '../conversion/TableStructureDetector.js';
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
import { VocabularyConformanceGate } from '../review/VocabularyConformanceGate.js';
import type { ConformanceReport } from '../review/VocabularyConformanceGate.js';
import { parseVocabularyMarkdown } from '../consolidation/VocabularyMarkdownParser.js';
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

    // Re-examine already-registered binary sources for changes that invalidate
    // their derived Markdown. The append-if-new merge above never re-reads an
    // existing path, so an edited binary — or an unchanged binary whose convert
    // options have since changed — would keep feeding stale derived text to
    // extraction. Two triggers force reconversion: the on-disk bytes changed,
    // or the effective convert options (process default merged with any
    // per-source override) differ from those recorded at the last conversion.
    // Only binary (convertible) sources carry a `sourceHash` and derived files,
    // so text sources are untouched.
    const processConvertOptions = this.config.services?.docling?.convertOptions;
    const existingByPath = new Map(newSources.map(s => [s.path, s]));
    for (const source of sourceList.sources) {
      if (source.originalFormat === undefined || source.sourceHash === undefined) continue;
      // Only re-check sources that still exist on disk in this scan.
      if (!existingByPath.has(source.path)) continue;
      const bytes = await readFile(source.path);
      const currentHash = createHash('sha256').update(bytes).digest('hex');
      const bytesChanged = currentHash !== source.sourceHash;

      // Options change only re-queues an already-converted source; an unconverted
      // one is picked up by convert regardless. Compare the effective options
      // against what the last conversion actually used.
      const effectiveConvertOptions = mergeConvertOptions(processConvertOptions, source.sourceConvertOptions);
      const optionsChanged =
        source.derivedTextPath !== undefined &&
        !convertOptionsEqual(effectiveConvertOptions, source.convertOptionsUsed);

      if (!bytesChanged && !optionsChanged) continue;

      // Changed bytes, or changed convert options: drop stale derived files and
      // reset the entry so convert reprocesses it. Clearing the pointers means a
      // failed reconversion cannot leave the previous text masquerading as
      // current.
      await this.deleteDerivedFiles(source);
      source.status = 'needs-conversion';
      source.derivedTextPath = undefined;
      source.derivedDoclingJsonPath = undefined;
      source.sourceHash = undefined;
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
   * Convert: turn every `needs-conversion` source into derived Markdown via
   * the document-conversion service, so extraction reads clean text.
   *
   * Requires a `services.docling` config section — a repo with binary sources
   * but no service configured is a setup error, surfaced with an actionable
   * message. Stuck `converting` sources from an interrupted run are reset
   * before the batch starts. `sourceDir`, when provided, roots the derived
   * filename slugs; otherwise the common ancestor of the source paths is used.
   */
  async convert(sourceDir?: string): Promise<DocumentConverterSummary> {
    await this.state.setPipelineState(Phase.PREPARE);
    await this.state.clearStopRequest();
    await this.state.resetConvertingSources();

    const needsConversion = await this.state.getSourcesByStatus('needs-conversion');
    if (needsConversion.length === 0) {
      return { converted: 0, skipped: 0, failed: 0, stoppedEarly: false, perDoc: [] };
    }

    const doclingConfig = this.config.services?.docling;
    if (!doclingConfig) {
      throw new InvalidInputError(
        'services.docling',
        `${needsConversion.length} source(s) need conversion but no document-conversion service is configured.`,
        'Add a "services.docling" section to config.json (endpoint defaults to http://localhost:5001) and start the docling-worker docker profile.',
      );
    }

    // The client owns per-request transport concerns (timeout, retries, auth)
    // and the async poll backoff; the converter loop owns the sync/async mode
    // choice and the OCR heuristic, so those are passed to convertSources.
    const doclingClient = new DoclingClient({
      endpoint: doclingConfig.endpoint,
      ...(doclingConfig.timeoutMs !== undefined ? { timeoutMs: doclingConfig.timeoutMs } : {}),
      ...(doclingConfig.maxRetries !== undefined ? { maxRetries: doclingConfig.maxRetries } : {}),
      ...(doclingConfig.apiKey !== undefined ? { apiKey: doclingConfig.apiKey } : {}),
      ...(doclingConfig.pollIntervalMs !== undefined ? { pollIntervalMs: doclingConfig.pollIntervalMs } : {}),
      ...(doclingConfig.maxPollIntervalMs !== undefined ? { maxPollIntervalMs: doclingConfig.maxPollIntervalMs } : {}),
      ...(doclingConfig.maxTotalWaitMs !== undefined ? { maxTotalWaitMs: doclingConfig.maxTotalWaitMs } : {}),
    });

    const sourceRoot = sourceDir ?? commonAncestorDir(needsConversion.map(s => s.path));

    const { sourceFilter, maxItems } = this.config.extraction;
    const summary = await convertSources(
      { state: this.state, doclingClient, sourceRoot },
      {
        mode: doclingConfig.mode ?? 'async',
        ...(sourceFilter && sourceFilter.length > 0 ? { sourceFilter } : {}),
        ...(maxItems !== undefined ? { maxItems } : {}),
        ...(doclingConfig.doOcr !== undefined ? { doOcr: doclingConfig.doOcr } : {}),
        ...(doclingConfig.ocrTextYieldThreshold !== undefined
          ? { ocrTextYieldThreshold: doclingConfig.ocrTextYieldThreshold }
          : {}),
        ...(doclingConfig.convertOptions !== undefined ? { convertOptions: doclingConfig.convertOptions } : {}),
      },
    );

    return summary;
  }

  /**
   * Inspect converted documents for table-structure corruption and return
   * non-blocking, options-aware recommendations.
   *
   * Runs the static {@link TableStructureDetector} over every converted source
   * that has a structural sidecar, then gates each suspect/corrupt finding
   * against the options the source was last converted with: a file converted
   * under docling's defaults earns an executable re-convert with
   * `tableCellMatching` disabled; a file already converted with the flag earns
   * only a note that it did not resolve, so the same advice never loops. Clean
   * documents produce nothing. Pure computation — no LLM calls — safe to run at
   * both `analyze` (pre-extraction) and `diagnose`.
   */
  async detectTableCorruption(sourceFilter?: string[]): Promise<TableCorruptionRecommendation[]> {
    const sourceList = await this.state.getSourceList();
    if (!sourceList) return [];

    let sources = sourceList.sources.filter(
      s => s.status !== 'excluded' && s.derivedDoclingJsonPath !== undefined,
    );
    if (sourceFilter && sourceFilter.length > 0) {
      sources = sources.filter(s => matchesSourceFilter(s.path, sourceFilter));
    }

    const detector = new TableStructureDetector();
    const recommendations: TableCorruptionRecommendation[] = [];
    for (const source of sources) {
      const finding = await detector.analyzeSource({
        path: source.path,
        derivedTextPath: source.derivedTextPath,
        derivedDoclingJsonPath: source.derivedDoclingJsonPath,
      });
      const recommendation = buildTableCorruptionRecommendation(finding, source.convertOptionsUsed);
      if (recommendation) recommendations.push(recommendation);
    }
    return recommendations;
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

    // Apply sourceFilter — only process matching sources. Shares the one
    // path-filter predicate with convert and the MCP tool surface.
    const { sourceFilter, maxItems } = this.config.extraction;
    if (sourceFilter && sourceFilter.length > 0) {
      pendingSources = pendingSources.filter(s => matchesSourceFilter(s.path, sourceFilter));
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
   * Vocabulary conformance: validate extraction output against the domain
   * vocabulary before consolidation, reusing core's validator.
   *
   * Parses the vocabulary markdown into the same contract the live repository
   * enforces, then runs the conformance gate over the active extraction outputs
   * under the configured governance mode (default `managed`). Returns a report
   * of violations grouped by class plus, under `managed`, structured
   * vocabulary-extension recommendations for recurring closed-enum values.
   * Pure computation — no LLM calls, no repository access.
   */
  async conformanceDiagnostics(sourceFilter?: string[]): Promise<ConformanceReport> {
    await this.loadVocabularyAndRules();
    const vocabulary = parseVocabularyMarkdown(this.vocabulary ?? '');
    const mode = this.config.governanceMode ?? 'managed';

    let outputs = await this.state.getExtractionOutputs();
    if (sourceFilter && sourceFilter.length > 0) {
      outputs = outputs.filter(o => matchesSourceFilter(o.sourcePath, sourceFilter));
    }

    const gate = new VocabularyConformanceGate(vocabulary, mode);
    return gate.run(outputs);
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

  /**
   * Delete a source's derived Markdown + structural JSON, if present. Used to
   * invalidate stale conversion output when a source changes on disk.
   * Best-effort — a missing file is not an error.
   */
  private async deleteDerivedFiles(source: IndexSource): Promise<void> {
    for (const path of [source.derivedTextPath, source.derivedDoclingJsonPath]) {
      if (!path) continue;
      try {
        await unlink(path);
      } catch {
        // File may already be gone.
      }
    }
  }

  /** Scan a directory recursively for indexable documents */
  private async scanSourceDirectory(dir: string): Promise<IndexSource[]> {
    const sources: IndexSource[] = [];
    // Plain-text formats the extractor reads directly.
    const textExtensions = new Set(['.md', '.txt', '.json', '.csv']);
    // Rich formats docling-serve converts to Markdown before extraction.
    // Legacy binary `.doc` is intentionally excluded — docling accepts DOCX
    // but not the Word 97-2003 binary format, so registering it would create
    // sources that can never convert.
    const convertExtensions = new Set(['.pdf', '.docx', '.html', '.htm', '.pptx']);

    const walk = async (currentDir: string): Promise<void> => {
      const entries = await readdir(currentDir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(currentDir, entry.name);
        const ext = extname(entry.name).toLowerCase();
        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (textExtensions.has(ext)) {
          const stats = await stat(fullPath);
          sources.push({
            path: fullPath,
            type: inferDocumentType(entry.name),
            status: 'pending',
            notes: `${Math.round(stats.size / 1024)} KB`,
          });
        } else if (convertExtensions.has(ext)) {
          const stats = await stat(fullPath);
          sources.push({
            path: fullPath,
            type: inferDocumentType(entry.name),
            status: 'needs-conversion',
            originalFormat: ext,
            notes: `${Math.round(stats.size / 1024)} KB`,
          });
        }
      }
    };

    await walk(dir);
    return sources;
  }
}

/**
 * Compute the deepest directory that contains every given path. Used to root
 * derived-filename slugs when the caller does not supply the source directory.
 * Falls back to an empty string (converter then uses basenames) when the paths
 * share no common ancestor.
 */
function commonAncestorDir(paths: string[]): string {
  if (paths.length === 0) return '';
  const split = paths.map(p => p.split(/[\\/]/));
  const first = split[0]!;
  const common: string[] = [];
  for (let i = 0; i < first.length; i++) {
    const segment = first[i]!;
    if (split.every(parts => parts[i] === segment)) {
      common.push(segment);
    } else {
      break;
    }
  }
  // Drop the trailing segment if it is a shared filename rather than a directory
  // (only relevant when a single path is supplied).
  if (paths.length === 1) common.pop();
  return common.join('/');
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
