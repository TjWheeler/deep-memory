import { readFile, writeFile, readdir, mkdir, unlink as unlinkFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { EntityRegistry, RegistryEntry } from '../types/registry.js';
import type { IndexSourceList, IndexSource, IndexSourceStatus } from '../types/source-list.js';
import type { ExtractionOutput } from '../types/extraction.js';
import type { ExtractionProgress, ExtractionCheckpoint } from '../extraction/ExtractionProgress.js';

/** Pipeline phase constants */
export const Phase = {
  PREPARE: 'prepare',
  EXTRACT: 'extract',
  EXTRACTION_REVIEW: 'extraction-review',
  CONSOLIDATE: 'consolidate',
  IMPORT: 'import',
  IMPORT_REVIEW: 'import-review',
  EMBEDDINGS: 'embeddings',
  COMPLETE: 'complete',
} as const;

/** Pipeline phase determined from state on disk */
export type PipelinePhase = typeof Phase[keyof typeof Phase];

const SOURCE_LIST_FILE = 'index-source-list.json';
const REGISTRY_FILE = 'entity-registry.json';
const EXTRACTION_DIR = 'extraction-notes';
const EXTRACTION_PROGRESS_DIR = 'extraction-progress';
const EXTRACTION_CHECKPOINTS_DIR = 'extraction-checkpoints';
const EXPORTS_DIR = 'exports';
const VALIDATION_REPORT_FILE = 'validation-report.json';
const CHECKPOINT_REVIEW_FILE = 'checkpoint-review.json';
const PIPELINE_STATE_FILE = 'pipeline-state.json';
const STOP_SIGNAL_FILE = 'stop-requested.json';
const ANALYSIS_REPORT_FILE = 'analysis-report.json';
const REVIEW_DIAGNOSTICS_FILE = 'review-diagnostics.json';
const MERGE_LOG_FILE = 'consolidation-merge-log.json';
const CONSOLIDATION_REVIEW_FILE = 'consolidation-review-diagnostics.json';
const FULL_VALIDATION_PROGRESS_FILE = 'full-validation-progress.json';
const FULL_VALIDATION_REPORT_FILE = 'full-validation-report.json';
const FULL_VALIDATION_CORRECTIONS_FILE = 'full-validation-corrections.json';
const EMBEDDING_PROGRESS_FILE = 'embedding-progress.json';
const EXTRACTION_STARTED_FILE = 'extraction-started.json';
const PROCESS_LOCK_FILE = 'process-lock.json';

/**
 * Manages persistent state for the indexing pipeline.
 *
 * Reads and writes files in the state directory (entity registry, source list,
 * extraction outputs). Provides resume detection by inspecting what exists on disk.
 */
export class StateManager {
  constructor(private readonly stateDir: string) {}

  /** Get the state directory path */
  getStateDirPath(): string {
    return this.stateDir;
  }

  /** Ensure the state directory and subdirectories exist */
  async initialize(): Promise<void> {
    await mkdir(join(this.stateDir, EXTRACTION_DIR), { recursive: true });
    await mkdir(join(this.stateDir, EXTRACTION_PROGRESS_DIR), { recursive: true });
    await mkdir(join(this.stateDir, EXPORTS_DIR), { recursive: true });
  }

  // ── Source List ──────────────────────────────────────────────────

  /** Load the source list from disk, or return null if it doesn't exist */
  async getSourceList(): Promise<IndexSourceList | null> {
    return this.readJsonFile<IndexSourceList>(join(this.stateDir, SOURCE_LIST_FILE));
  }

  /** Save the source list to disk */
  async saveSourceList(sourceList: IndexSourceList): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, SOURCE_LIST_FILE), sourceList);
  }

  /** Update the status of a single source document */
  async updateSourceStatus(path: string, status: IndexSourceStatus): Promise<void> {
    const sourceList = await this.getSourceList();
    if (!sourceList) {
      throw new Error(`Source list not found in ${this.stateDir}`);
    }
    const source = sourceList.sources.find(s => s.path === path);
    if (!source) {
      throw new Error(`Source not found in list: ${path}`);
    }
    source.status = status;
    await this.saveSourceList(sourceList);
  }

  /** Get sources filtered by status */
  async getSourcesByStatus(status: IndexSourceStatus): Promise<IndexSource[]> {
    const sourceList = await this.getSourceList();
    if (!sourceList) return [];
    return sourceList.sources.filter(s => s.status === status);
  }

  /** Update arbitrary fields on a source document */
  async updateSource(path: string, updates: Partial<Pick<IndexSource, 'assignedWorkers' | 'estimatedTokens' | 'actualTokens' | 'lastError' | 'attempts' | 'status' | 'extractionFiles' | 'selectedExtraction' | 'notes' | 'processingTimeMs' | 'statusReason'>>): Promise<void> {
    const sourceList = await this.getSourceList();
    if (!sourceList) throw new Error(`Source list not found in ${this.stateDir}`);
    const source = sourceList.sources.find(s => s.path === path);
    if (!source) throw new Error(`Source not found in list: ${path}`);
    Object.assign(source, updates);
    await this.saveSourceList(sourceList);
  }

  /**
   * Atomically record a worker's extraction output and check completion.
   *
   * Re-reads the source list fresh to avoid race conditions when multiple
   * workers finish concurrently on the same source. Merges the new worker's
   * extraction file into the existing map, then checks if all assigned
   * workers have completed.
   *
   * Returns the new status: 'extracted' if all workers are done, 'pending' otherwise.
   */
  async recordExtractionComplete(
    sourcePath: string,
    workerName: string,
    extractionFile: string,
    updates: Partial<Pick<IndexSource, 'actualTokens' | 'processingTimeMs'>>,
  ): Promise<'extracted' | 'pending'> {
    const sourceList = await this.getSourceList();
    if (!sourceList) throw new Error(`Source list not found in ${this.stateDir}`);
    const source = sourceList.sources.find(s => s.path === sourcePath);
    if (!source) throw new Error(`Source not found in list: ${sourcePath}`);

    // Merge this worker's output into the existing map
    const extractionFiles = { ...(source.extractionFiles ?? {}), [workerName]: extractionFile };
    source.extractionFiles = extractionFiles;

    // Check if all assigned workers have completed
    const assignedWorkers = source.assignedWorkers ?? [workerName];
    const allDone = assignedWorkers.every(w => extractionFiles[w]);
    source.status = allDone ? 'extracted' : 'pending';
    source.lastError = undefined;

    // Auto-select the extraction when there's only one worker — no other option exists,
    // so downstream phases (review, consolidation) can proceed without manual selection.
    if (allDone && assignedWorkers.length === 1) {
      source.selectedExtraction = extractionFile;
    }

    // Apply additional updates (tokens, processing time)
    Object.assign(source, updates);

    await this.saveSourceList(sourceList);
    return source.status as 'extracted' | 'pending';
  }

  /**
   * Atomically record a worker's extraction failure.
   *
   * Re-reads the source list fresh to avoid stomping extractionFiles entries
   * from workers that succeeded. Only updates error-related fields and
   * increments attempts. Does NOT reset status to 'pending' if another
   * worker already succeeded (status is 'extracted').
   */
  async recordExtractionError(
    sourcePath: string,
    workerName: string,
    errorMessage: string,
    processingTimeMs: number,
  ): Promise<void> {
    const sourceList = await this.getSourceList();
    if (!sourceList) throw new Error(`Source list not found in ${this.stateDir}`);
    const source = sourceList.sources.find(s => s.path === sourcePath);
    if (!source) throw new Error(`Source not found in list: ${sourcePath}`);

    // Only revert to pending if the source hasn't been marked extracted
    // by another worker that succeeded
    if (source.status !== 'extracted') {
      source.status = 'pending';
    }
    source.lastError = `[${workerName}] ${errorMessage}`;
    source.attempts = (source.attempts ?? 0) + 1;
    source.processingTimeMs = processingTimeMs;

    await this.saveSourceList(sourceList);
  }

  // ── Entity Registry ─────────────────────────────────────────────

  /** Load the entity registry from disk, or return null if it doesn't exist */
  async getRegistry(): Promise<EntityRegistry | null> {
    return this.readJsonFile<EntityRegistry>(join(this.stateDir, REGISTRY_FILE));
  }

  /** Save the entity registry to disk */
  async saveRegistry(registry: EntityRegistry): Promise<void> {
    registry.lastUpdated = new Date().toISOString();
    await this.writeJsonFile(join(this.stateDir, REGISTRY_FILE), registry);
  }

  /** Look up a registry entry by slug */
  async findRegistryEntry(slug: string): Promise<RegistryEntry | undefined> {
    const registry = await this.getRegistry();
    if (!registry) return undefined;
    return registry.entities.find(e => e.slug === slug);
  }

  // ── Extraction Outputs ──────────────────────────────────────────

  /**
   * Get extraction outputs that have been selected for downstream phases.
   * Reads from each source's `selectedExtraction` path. Sources without
   * a selection are skipped.
   */
  async getExtractionOutputs(): Promise<ExtractionOutput[]> {
    const sourceList = await this.getSourceList();
    if (!sourceList) return [];

    const outputs: ExtractionOutput[] = [];
    for (const source of sourceList.sources) {
      if (source.status === 'excluded' || !source.selectedExtraction) continue;
      const output = await this.readJsonFile<ExtractionOutput>(join(this.stateDir, source.selectedExtraction));
      if (output) outputs.push(output);
    }
    return outputs;
  }

  /** List all worker subdirectories under extraction-notes/ */
  async getWorkerNames(): Promise<string[]> {
    const dir = join(this.stateDir, EXTRACTION_DIR);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return [];
    }
    // Filter to directories only by checking if they contain .json files
    const workers: string[] = [];
    for (const entry of entries) {
      try {
        const subFiles = await readdir(join(dir, entry));
        if (subFiles.some(f => f.endsWith('.json'))) {
          workers.push(entry);
        }
      } catch {
        // Not a directory or not accessible — skip
      }
    }
    return workers;
  }

  /**
   * Get ALL extraction outputs across all workers (reads directly from disk).
   * Unlike getExtractionOutputs(), this does NOT filter on selectedExtraction.
   * Use during extract/extraction-review phases when you want to see everything.
   * Returns a flat array — if multiple workers extracted the same source, both appear.
   */
  async getAllExtractionOutputs(): Promise<ExtractionOutput[]> {
    const workers = await this.getWorkerNames();
    const allOutputs: ExtractionOutput[] = [];
    for (const worker of workers) {
      const outputs = await this.getExtractionOutputsByWorker(worker);
      allOutputs.push(...outputs);
    }
    return allOutputs;
  }

  /** Get all extraction outputs from a specific worker's subdirectory */
  async getExtractionOutputsByWorker(workerName: string): Promise<ExtractionOutput[]> {
    const dir = join(this.stateDir, EXTRACTION_DIR, workerName);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const outputs: ExtractionOutput[] = [];
    for (const file of jsonFiles) {
      const output = await this.readJsonFile<ExtractionOutput>(join(dir, file));
      if (output) outputs.push(output);
    }
    return outputs;
  }

  /** Save an extraction output to disk under extraction-notes/{workerName}/ */
  async saveExtractionOutput(output: ExtractionOutput, workerName: string): Promise<string> {
    const filename = this.extractionFilename(output.source);
    const workerDir = join(this.stateDir, EXTRACTION_DIR, workerName);
    await mkdir(workerDir, { recursive: true });
    const filepath = join(workerDir, filename);
    await this.writeJsonFile(filepath, output);
    // Always use forward slashes in stored paths for cross-platform consistency
    return `${EXTRACTION_DIR}/${workerName}/${filename}`;
  }

  /** Check if an extraction output exists for a given source and worker */
  async hasExtractionOutput(source: string, workerName: string): Promise<boolean> {
    const filename = this.extractionFilename(source);
    const filepath = join(this.stateDir, EXTRACTION_DIR, workerName, filename);
    return (await this.readJsonFile(filepath)) !== null;
  }

  // ── Export Archives ─────────────────────────────────────────────

  /** List export archive files in the exports directory */
  async getExportArchives(): Promise<string[]> {
    const dir = join(this.stateDir, EXPORTS_DIR);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    return files.filter(f => f.endsWith('.zip')).map(f => join(dir, f));
  }

  /** Get the full path for a new export archive */
  getExportArchivePath(name: string): string {
    return join(this.stateDir, EXPORTS_DIR, name);
  }

  // ── Validation State ─────────────────────────────────────────────

  /** Save validation report to disk */
  async saveValidationReport(report: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, VALIDATION_REPORT_FILE), report);
  }

  /** Load validation report from disk */
  async getValidationReport(): Promise<unknown | null> {
    return this.readJsonFile(join(this.stateDir, VALIDATION_REPORT_FILE));
  }

  /** Get the explicit pipeline state override (for import-review) */
  async getPipelineState(): Promise<{ state: PipelinePhase } | null> {
    return this.readJsonFile<{ state: PipelinePhase }>(join(this.stateDir, PIPELINE_STATE_FILE));
  }

  /** Set an explicit pipeline state (e.g., import-review) */
  async setPipelineState(state: PipelinePhase): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, PIPELINE_STATE_FILE), { state, updatedAt: new Date().toISOString() });
  }

  /** Clear the explicit pipeline state override */
  async clearPipelineState(): Promise<void> {
    try {
      await unlinkFile(join(this.stateDir, PIPELINE_STATE_FILE));
    } catch {
      // File may not exist
    }
  }

  /** Check if a checkpoint review file exists */
  async hasCheckpointReview(): Promise<boolean> {
    return (await this.readJsonFile(join(this.stateDir, CHECKPOINT_REVIEW_FILE))) !== null;
  }

  // ── Analysis Report ──────────────────────────────────────────────

  /** Save an analysis report to disk */
  async saveAnalysisReport(report: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, ANALYSIS_REPORT_FILE), report);
  }

  /** Load analysis report from disk */
  async getAnalysisReport(): Promise<unknown | null> {
    return this.readJsonFile(join(this.stateDir, ANALYSIS_REPORT_FILE));
  }

  // ── Review Diagnostics ──────────────────────────────────────────

  /** Save a review diagnostics report to disk */
  async saveReviewDiagnostics(report: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, REVIEW_DIAGNOSTICS_FILE), report);
  }

  /** Load review diagnostics report from disk */
  async getReviewDiagnostics<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, REVIEW_DIAGNOSTICS_FILE));
  }

  /** Check if a review diagnostics report exists */
  async hasReviewDiagnostics(): Promise<boolean> {
    return (await this.readJsonFile(join(this.stateDir, REVIEW_DIAGNOSTICS_FILE))) !== null;
  }

  // ── Merge Log ───────────────────────────────────────────────────

  /** Save a consolidation merge log to disk */
  async saveMergeLog(log: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, MERGE_LOG_FILE), log);
  }

  /** Load consolidation merge log from disk */
  async getMergeLog<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, MERGE_LOG_FILE));
  }

  // ── Consolidation Review Diagnostics ────────────────────────────

  /** Save a consolidation review diagnostics report to disk */
  async saveConsolidationReviewDiagnostics(report: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, CONSOLIDATION_REVIEW_FILE), report);
  }

  /** Load consolidation review diagnostics report from disk */
  async getConsolidationReviewDiagnostics<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, CONSOLIDATION_REVIEW_FILE));
  }

  // ── Extraction Progress ──────────────────────────────────────────

  /** Write an extraction progress file for an active extraction */
  async writeExtractionProgress(sourceFilename: string, progress: ExtractionProgress, workerName?: string): Promise<void> {
    const dir = join(this.stateDir, EXTRACTION_PROGRESS_DIR);
    await mkdir(dir, { recursive: true });
    const prefix = workerName ? `${workerName}--` : '';
    const filename = prefix + sourceFilename.replace(/\.[^.]+$/, '') + '.json';
    await this.writeJsonFile(join(dir, filename), progress);
  }

  /** Delete the extraction progress file for a source (called on completion) */
  async deleteExtractionProgress(sourceFilename: string, workerName?: string): Promise<void> {
    const prefix = workerName ? `${workerName}--` : '';
    const filename = prefix + sourceFilename.replace(/\.[^.]+$/, '') + '.json';
    try {
      await unlinkFile(join(this.stateDir, EXTRACTION_PROGRESS_DIR, filename));
    } catch {
      // File may not exist
    }
  }

  /** Get all active extraction progress files */
  async getActiveExtractionProgress(): Promise<ExtractionProgress[]> {
    const dir = join(this.stateDir, EXTRACTION_PROGRESS_DIR);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return [];
    }
    const jsonFiles = files.filter(f => f.endsWith('.json'));
    const results: ExtractionProgress[] = [];
    for (const file of jsonFiles) {
      const progress = await this.readJsonFile<ExtractionProgress>(join(dir, file));
      if (progress) results.push(progress);
    }
    return results;
  }

  // ── Extraction Checkpoints ───────────────────────────────────────

  /** Write a checkpoint file for an in-progress extraction */
  async writeExtractionCheckpoint(sourceFilename: string, checkpoint: ExtractionCheckpoint, workerName?: string): Promise<void> {
    const dir = join(this.stateDir, EXTRACTION_CHECKPOINTS_DIR);
    await mkdir(dir, { recursive: true });
    const prefix = workerName ? `${workerName}--` : '';
    const filename = prefix + sourceFilename.replace(/\.[^.]+$/, '') + '.checkpoint.json';
    await this.writeJsonFile(join(dir, filename), checkpoint);
  }

  /** Read a checkpoint file for a source, or null if none exists */
  async getExtractionCheckpoint(sourceFilename: string, workerName?: string): Promise<ExtractionCheckpoint | null> {
    const prefix = workerName ? `${workerName}--` : '';
    const filename = prefix + sourceFilename.replace(/\.[^.]+$/, '') + '.checkpoint.json';
    return this.readJsonFile<ExtractionCheckpoint>(join(this.stateDir, EXTRACTION_CHECKPOINTS_DIR, filename));
  }

  /** Delete a checkpoint file (called on completion or explicit reset) */
  async deleteExtractionCheckpoint(sourceFilename: string, workerName?: string): Promise<void> {
    const prefix = workerName ? `${workerName}--` : '';
    const filename = prefix + sourceFilename.replace(/\.[^.]+$/, '') + '.checkpoint.json';
    try {
      await unlinkFile(join(this.stateDir, EXTRACTION_CHECKPOINTS_DIR, filename));
    } catch {
      // File may not exist
    }
  }

  // ── Stop Signal ─────────────────────────────────────────────────

  /** Request the pipeline to stop. Workers check this between operations. */
  async requestStop(reason?: string): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, STOP_SIGNAL_FILE), {
      requestedAt: new Date().toISOString(),
      reason: reason ?? 'Stop requested',
    });
  }

  /** Check whether a stop has been requested */
  async isStopRequested(): Promise<boolean> {
    return (await this.readJsonFile(join(this.stateDir, STOP_SIGNAL_FILE))) !== null;
  }

  /** Clear the stop signal (called before starting a new run) */
  async clearStopRequest(): Promise<void> {
    try {
      await unlinkFile(join(this.stateDir, STOP_SIGNAL_FILE));
    } catch {
      // File may not exist
    }
  }

  /** Reorder a source within the source list array */
  async reorderSource(path: string, order: number | 'start' | 'end' | 'up' | 'down'): Promise<{ newIndex: number; total: number }> {
    const sourceList = await this.getSourceList();
    if (!sourceList) throw new Error(`Source list not found in ${this.stateDir}`);

    const currentIndex = sourceList.sources.findIndex(s => s.path === path);
    if (currentIndex === -1) throw new Error(`Source not found in list: ${path}`);

    const total = sourceList.sources.length;
    const [source] = sourceList.sources.splice(currentIndex, 1);

    let targetIndex: number;
    if (order === 'start') {
      targetIndex = 0;
    } else if (order === 'end') {
      targetIndex = total - 1;
    } else if (order === 'up') {
      targetIndex = Math.max(0, currentIndex - 1);
    } else if (order === 'down') {
      targetIndex = Math.min(total - 1, currentIndex + 1);
    } else {
      targetIndex = Math.max(0, Math.min(total - 1, order));
    }

    sourceList.sources.splice(targetIndex, 0, source!);
    await this.saveSourceList(sourceList);

    return { newIndex: targetIndex, total };
  }

  /** Reset any sources stuck in 'extracting' or 'deduplicating' back to 'pending' */
  async resetExtractingSources(): Promise<number> {
    const sourceList = await this.getSourceList();
    if (!sourceList) return 0;
    let count = 0;
    for (const source of sourceList.sources) {
      if (source.status === 'extracting' || source.status === 'deduplicating') {
        source.status = 'pending';
        count++;
      }
    }
    if (count > 0) {
      await this.saveSourceList(sourceList);
    }
    return count;
  }

  // ── Resume Detection ────────────────────────────────────────────

  /**
   * Determine the current pipeline phase based on state on disk.
   *
   * - Explicit pipeline state override → use that (e.g., import-review)
   * - No source list → prepare
   * - Some sources pending → extract
   * - All extracted, validation enabled → validate
   * - All sources extracted, no export → consolidate
   * - Export exists, registry has non-imported entries → import
   * - All imported → complete
   */
  async getCurrentPhase(): Promise<PipelinePhase> {
    // Check for explicit pipeline state (e.g., import-review)
    const pipelineState = await this.getPipelineState();
    if (pipelineState) {
      return pipelineState.state;
    }

    // Check for pending checkpoint review
    if (await this.hasCheckpointReview()) {
      return Phase.IMPORT_REVIEW;
    }

    const sourceList = await this.getSourceList();

    // No source list at all — need to prepare
    if (!sourceList || sourceList.sources.length === 0) {
      return Phase.PREPARE;
    }

    // Exclude 'excluded' sources from phase detection — they are deliberately removed from the pipeline
    const activeSources = sourceList.sources.filter(s => s.status !== 'excluded');
    const statuses = activeSources.map(s => s.status);

    // No active sources — if all were excluded, treat as complete
    if (statuses.length === 0) {
      return Phase.COMPLETE;
    }

    // All sources validated — fully complete
    if (statuses.every(s => s === 'validated')) {
      return Phase.COMPLETE;
    }

    // Any sources still pending, extracting, or deduplicating — continue extraction
    if (statuses.some(s => s === 'pending' || s === 'extracting' || s === 'deduplicating')) {
      return Phase.EXTRACT;
    }

    // All sources extracted but none consolidated yet
    // Note: the orchestrator writes EXTRACTION_REVIEW to pipeline-state.json when extraction
    // completes — this fallback handles legacy processes without an explicit state file
    if (statuses.every(s => s === 'extracted')) {
      return Phase.EXTRACTION_REVIEW;
    }

    // Some sources imported but not all validated — still in import phase
    if (statuses.some(s => s === 'imported')) {
      return Phase.IMPORT;
    }

    // Sources consolidated but not imported — check for export archive
    if (statuses.some(s => s === 'consolidated')) {
      const archives = await this.getExportArchives();
      if (archives.length > 0) {
        return Phase.IMPORT;
      }
      // Consolidated in source list but no archive — re-consolidate
      return Phase.CONSOLIDATE;
    }

    return Phase.COMPLETE;
  }

  // ── Full Extraction Validation ──────────────────────────────────

  /** Save full validation progress to disk */
  async saveFullValidationProgress(progress: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, FULL_VALIDATION_PROGRESS_FILE), progress);
  }

  /** Load full validation progress from disk */
  async getFullValidationProgress<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, FULL_VALIDATION_PROGRESS_FILE));
  }

  /** Save full validation report to disk */
  async saveFullValidationReport(report: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, FULL_VALIDATION_REPORT_FILE), report);
  }

  /** Load full validation report from disk */
  async getFullValidationReport<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, FULL_VALIDATION_REPORT_FILE));
  }

  /** Save proposed corrections from fix-mode validation */
  async saveFullValidationCorrections(corrections: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, FULL_VALIDATION_CORRECTIONS_FILE), corrections);
  }

  /** Load proposed corrections */
  async getFullValidationCorrections<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, FULL_VALIDATION_CORRECTIONS_FILE));
  }

  /** Clear all full validation state files (progress, report, corrections) */
  async clearFullValidationState(): Promise<void> {
    const files = [
      FULL_VALIDATION_PROGRESS_FILE,
      FULL_VALIDATION_REPORT_FILE,
      FULL_VALIDATION_CORRECTIONS_FILE,
    ];
    for (const file of files) {
      try {
        await unlinkFile(join(this.stateDir, file));
      } catch {
        // File may not exist
      }
    }
  }

  // ── Embedding Progress ───────────────────────────────────────────

  /** Save embedding progress to disk */
  async saveEmbeddingProgress(progress: unknown): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, EMBEDDING_PROGRESS_FILE), progress);
  }

  /** Load embedding progress from disk */
  async getEmbeddingProgress<T = unknown>(): Promise<T | null> {
    return this.readJsonFile<T>(join(this.stateDir, EMBEDDING_PROGRESS_FILE));
  }

  /** Delete embedding progress file (called on completion or reset) */
  async deleteEmbeddingProgress(): Promise<void> {
    try {
      await unlinkFile(join(this.stateDir, EMBEDDING_PROGRESS_FILE));
    } catch {
      // File may not exist
    }
  }

  // ── Extraction Started Timestamp ──────────────────────────────────

  /** Record when extraction started (wall-clock time for current run) */
  async setExtractionStartedAt(): Promise<void> {
    await this.writeJsonFile(join(this.stateDir, EXTRACTION_STARTED_FILE), {
      startedAt: new Date().toISOString(),
    });
  }

  /** Get the extraction start timestamp, or null if not set */
  async getExtractionStartedAt(): Promise<string | null> {
    const data = await this.readJsonFile<{ startedAt: string }>(join(this.stateDir, EXTRACTION_STARTED_FILE));
    return data?.startedAt ?? null;
  }

  /** Clear the extraction start timestamp */
  async clearExtractionStartedAt(): Promise<void> {
    try {
      await unlinkFile(join(this.stateDir, EXTRACTION_STARTED_FILE));
    } catch {
      // File may not exist
    }
  }

  // ── Process Lock ─────────────────────────────────────────────────

  /** Acquire a process lock. Returns false if another operation is already running.
   *  If a stale lock is found (the holding PID is no longer alive), it is
   *  automatically reclaimed so the caller can proceed. */
  async acquireProcessLock(operation: string): Promise<boolean> {
    const existing = await this.getProcessLock();
    if (existing) {
      // Check if the PID that holds the lock is still alive
      if (StateManager.isProcessAlive(existing.pid)) {
        return false;
      }
      // Stale lock — the process that held it has died. Clean up and reclaim.
      await this.releaseProcessLock();
    }
    await this.writeJsonFile(join(this.stateDir, PROCESS_LOCK_FILE), {
      operation,
      acquiredAt: new Date().toISOString(),
      pid: process.pid,
    });
    return true;
  }

  /** Release the process lock. */
  async releaseProcessLock(): Promise<void> {
    try {
      await unlinkFile(join(this.stateDir, PROCESS_LOCK_FILE));
    } catch {
      // File may not exist
    }
  }

  /** Get the current process lock, or null if none is held. */
  async getProcessLock(): Promise<{ operation: string; acquiredAt: string; pid: number } | null> {
    return this.readJsonFile<{ operation: string; acquiredAt: string; pid: number }>(
      join(this.stateDir, PROCESS_LOCK_FILE),
    );
  }

  /** Check whether a given PID is still running. Works on both Windows and Unix. */
  static isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0); // signal 0 = existence check, does not kill
      return true;
    } catch {
      return false;
    }
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private extractionFilename(source: string): string {
    // Strip extension and add .json
    const base = basename(source).replace(/\.[^.]+$/, '');
    return `${base}.json`;
  }

  private async readJsonFile<T>(filepath: string): Promise<T | null> {
    try {
      const content = await readFile(filepath, 'utf-8');
      return JSON.parse(content) as T;
    } catch {
      return null;
    }
  }

  private async writeJsonFile(filepath: string, data: unknown): Promise<void> {
    await writeFile(filepath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }
}
