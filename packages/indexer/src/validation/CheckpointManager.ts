import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ValidationConfig, CheckpointResult, ValidationIssue, Tier1Result } from '../types/validation.js';
import type { ExtractionOutput } from '../types/extraction.js';
import { Validator } from './Validator.js';
import { VerificationWorker, readSourceContent } from './VerificationWorker.js';
import type { ValidationRules } from '../types/validation.js';

const CHECKPOINT_REVIEW_FILE = 'checkpoint-review.json';
const CHECKPOINT_HISTORY_FILE = 'checkpoint-history.json';

interface CheckpointReview {
  batchNumber: number;
  createdAt: string;
  flaggedItems: Array<ValidationIssue & { resolution?: 'accept' | 'reject' | 'correct' }>;
}

interface CheckpointHistoryEntry {
  batchNumber: number;
  timestamp: string;
  verdict: 'continue' | 'warnings' | 'review-required';
  documentsInBatch: number;
  documentsCumulative: number;
  errorCount: number;
  warningCount: number;
}

/**
 * CheckpointManager — periodic validation during the import pipeline phase.
 *
 * Runs Tier 1 and optionally Tier 2 validation on batches of imported documents.
 * Pauses the pipeline when errors are found and supports resume after human review.
 */
export class CheckpointManager {
  private documentsImported = 0;
  private batchNumber = 0;

  constructor(
    private readonly config: ValidationConfig,
    private readonly stateDir: string,
    private readonly rules: ValidationRules,
    private readonly vocabulary: string,
  ) {}

  /** Check if a checkpoint should run after importing a batch */
  shouldCheckpoint(documentsImported: number): boolean {
    if (this.config.checkpointInterval <= 0) return false;
    this.documentsImported = documentsImported;
    return documentsImported > 0 && documentsImported % this.config.checkpointInterval === 0;
  }

  /**
   * Run a checkpoint on a batch of recently extracted documents.
   * Returns the result and whether the pipeline should continue or pause.
   */
  async runCheckpoint(
    batchExtractions: ExtractionOutput[],
  ): Promise<CheckpointResult> {
    this.batchNumber++;

    const validator = new Validator(this.rules, this.vocabulary);
    const allErrors: ValidationIssue[] = [];
    const allWarnings: ValidationIssue[] = [];

    // Run Tier 1 on every extraction in the batch
    let totalSchemaErrors = 0;
    let totalRangeViolations = 0;
    let totalStructuralIssues = 0;

    for (const extraction of batchExtractions) {
      const result = validator.validate(extraction);
      allErrors.push(...result.errors);
      allWarnings.push(...result.warnings);
      totalSchemaErrors += result.tier1.schemaErrors;
      totalRangeViolations += result.tier1.rangeViolations;
      totalStructuralIssues += result.tier1.structuralIssues;
    }

    const tier1: Tier1Result = {
      schemaErrors: totalSchemaErrors,
      rangeViolations: totalRangeViolations,
      structuralIssues: totalStructuralIssues,
      passed: allErrors.length === 0,
    };

    // Run Tier 2 on a sample if configured
    let tier2;
    if (this.config.tier2Scope !== 'flagged-only' || allErrors.length > 0) {
      if (this.config.verificationEndpoint && this.config.verificationModel) {
        const worker = new VerificationWorker({
          endpoint: this.config.verificationEndpoint,
          model: this.config.verificationModel,
        });

        // Sample one extraction from the batch for Tier 2
        const sampleIndex = this.batchNumber % batchExtractions.length;
        const sampleExtraction = batchExtractions[sampleIndex]!;

        try {
          const sourceContent = await readSourceContent(sampleExtraction.sourcePath);
          const verificationResult = await worker.verify(
            sampleExtraction,
            sourceContent,
            'all',
          );
          tier2 = verificationResult.tier2;
          for (const issue of verificationResult.issues) {
            if (issue.severity === 'error') {
              allErrors.push(issue);
            } else {
              allWarnings.push(issue);
            }
          }
        } catch {
          // Tier 2 failure is non-fatal at checkpoint — log as warning
          allWarnings.push({
            tier: 2,
            severity: 'warning',
            message: `[checkpoint] Tier 2 verification failed for sample "${sampleExtraction.source}" — skipping`,
          });
        }
      }
    }

    // Determine verdict
    const hasErrors = allErrors.length > 0;
    const hasWarnings = allWarnings.length > 0;
    let verdict: 'continue' | 'warnings' | 'review-required';

    if (hasErrors) {
      verdict = 'review-required';
    } else if (hasWarnings && this.config.pauseOnWarnings) {
      verdict = 'review-required';
    } else if (hasWarnings) {
      verdict = 'warnings';
    } else {
      verdict = 'continue';
    }

    const flaggedItems = [...allErrors, ...allWarnings];

    const result: CheckpointResult = {
      batchNumber: this.batchNumber,
      documentsInBatch: batchExtractions.length,
      documentsCumulative: this.documentsImported,
      tier1,
      tier2,
      verdict,
      flaggedItems,
    };

    // Write checkpoint review file if paused
    if (verdict === 'review-required') {
      const review: CheckpointReview = {
        batchNumber: this.batchNumber,
        createdAt: new Date().toISOString(),
        flaggedItems: flaggedItems.map(item => ({ ...item })),
      };
      await writeFile(
        join(this.stateDir, CHECKPOINT_REVIEW_FILE),
        JSON.stringify(review, null, 2) + '\n',
        'utf-8',
      );
    }

    // Append to checkpoint history
    await this.appendHistory({
      batchNumber: this.batchNumber,
      timestamp: new Date().toISOString(),
      verdict,
      documentsInBatch: batchExtractions.length,
      documentsCumulative: this.documentsImported,
      errorCount: allErrors.length,
      warningCount: allWarnings.length,
    });

    return result;
  }

  /**
   * Check if there is a pending checkpoint review that needs resolution.
   */
  async hasPendingReview(): Promise<boolean> {
    try {
      await readFile(join(this.stateDir, CHECKPOINT_REVIEW_FILE), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the pending checkpoint review items.
   */
  async getPendingReview(): Promise<CheckpointReview | null> {
    try {
      const content = await readFile(join(this.stateDir, CHECKPOINT_REVIEW_FILE), 'utf-8');
      return JSON.parse(content) as CheckpointReview;
    } catch {
      return null;
    }
  }

  /**
   * Resume after human review. The resolutions map has item indices → resolution.
   * Returns true if all items are resolved and the pipeline can continue.
   */
  async resume(
    resolutions: Record<number, 'accept' | 'reject' | 'correct'>,
  ): Promise<{ canContinue: boolean; unresolvedCount: number }> {
    const review = await this.getPendingReview();
    if (!review) {
      return { canContinue: true, unresolvedCount: 0 };
    }

    // Apply resolutions
    for (const [indexStr, resolution] of Object.entries(resolutions)) {
      const index = parseInt(indexStr, 10);
      const item = review.flaggedItems[index];
      if (item) {
        item.resolution = resolution;
      }
    }

    const unresolved = review.flaggedItems.filter(item => !item.resolution);

    if (unresolved.length === 0) {
      // All resolved — remove the review file to unblock the pipeline
      try {
        await unlink(join(this.stateDir, CHECKPOINT_REVIEW_FILE));
      } catch {
        // File may already be removed
      }
      return { canContinue: true, unresolvedCount: 0 };
    }

    // Save updated review with partial resolutions
    await writeFile(
      join(this.stateDir, CHECKPOINT_REVIEW_FILE),
      JSON.stringify(review, null, 2) + '\n',
      'utf-8',
    );

    return { canContinue: false, unresolvedCount: unresolved.length };
  }

  /** Append a checkpoint result to the history log */
  private async appendHistory(entry: CheckpointHistoryEntry): Promise<void> {
    const historyPath = join(this.stateDir, CHECKPOINT_HISTORY_FILE);
    let history: CheckpointHistoryEntry[] = [];

    try {
      const content = await readFile(historyPath, 'utf-8');
      history = JSON.parse(content) as CheckpointHistoryEntry[];
    } catch {
      // First checkpoint — start fresh
    }

    history.push(entry);
    await writeFile(historyPath, JSON.stringify(history, null, 2) + '\n', 'utf-8');
  }
}
