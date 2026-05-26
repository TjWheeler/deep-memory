import type { LLMProvider } from '../providers/LLMProvider.js';
import type { ExtractionOutput } from '../types/extraction.js';
import { FullValidationWorker } from './FullValidationWorker.js';
import type {
  FullValidationConfig,
  FullValidationWorkerConfig,
  ValidationBatch,
  ValidationBatchItem,
  EntityBatchItem,
  RelationshipBatchItem,
  BatchValidationResult,
  FullValidationProgress,
  FullValidationReport,
  BatchCheckpoint,
  VerdictCounts,
  ValidationCostTracker,
  DocumentValidationSummary,
  EntityTypeValidationSummary,
  FlaggedValidationItem,
  ProposedCorrection,
  EntityValidationResult,
  RelationshipValidationResult,
  FullValidationVerdict,
} from './full-validation-types.js';

/** Generate a deterministic key for a validation item */
function itemKey(item: ValidationBatchItem): string {
  if (item.type === 'entity') {
    return `entity:${item.source}:${item.entity.entityType}:${item.entity.label}`;
  }
  return `rel:${item.source}:${item.relationship.type}:${item.relationship.sourceLabel}:${item.relationship.targetLabel}`;
}

/** Options for a single validateFull() run */
export interface FullValidationRunOptions {
  /** Override the default worker name for this run */
  workerName?: string;
  /** Maximum batches to process (cost control) */
  maxBatches?: number;
  /** Only validate entities/relationships from these source documents */
  sourceFilter?: string[];
  /** Only validate specific entity types */
  entityFilter?: string[];
  /** Stop when estimated cost exceeds this USD amount */
  maxCost?: number;
}

/** Callbacks for progress reporting */
export interface FullValidationProgressCallbacks {
  onBatchComplete?: (batchIndex: number, result: BatchValidationResult) => void;
  onProgress?: (progress: FullValidationProgress) => void;
}

/**
 * FullValidationOrchestrator — manages the full extraction-validation run.
 *
 * Responsibilities:
 * - Build batches from extraction outputs (grouped by source document)
 * - Resume from per-batch checkpoints on restart
 * - Dispatch batches to FullValidationWorker with concurrency control
 * - Accumulate verdicts and cost tracking
 * - Persist progress and final report via callbacks
 */
export class FullValidationOrchestrator {
  constructor(
    private readonly config: FullValidationConfig,
    private readonly providers: Map<string, LLMProvider>,
    private readonly logDir?: string,
    private readonly vocabularySummary?: string,
    private readonly domainGuidance?: string,
  ) {}

  /**
   * Run full validation on all extraction outputs.
   * Resumable — loads existing progress and skips completed batches.
   */
  async run(
    extractions: ExtractionOutput[],
    existingProgress: FullValidationProgress | null,
    options: FullValidationRunOptions,
    callbacks: FullValidationProgressCallbacks,
    signal?: AbortSignal,
    isStopRequested?: () => Promise<boolean>,
  ): Promise<{ progress: FullValidationProgress; report: FullValidationReport }> {
    // Resolve workers: single worker if specified, otherwise all configured workers
    const workerConfigs = options.workerName
      ? [this.resolveWorkerConfig(options.workerName)]
      : this.config.workers;

    // Collect all source paths for cross-reference tool
    const allSourcePaths = extractions.map(e => e.sourcePath);

    const effectiveMaxBatches = options.maxBatches ?? this.config.maxBatches;
    const effectiveMaxCost = options.maxCost ?? this.config.maxCost;

    // Worker name for progress tracking — single worker or "multi"
    const progressWorkerName = workerConfigs.length === 1
      ? workerConfigs[0]!.name
      : workerConfigs.map(w => w.name).join('+');

    // Load validated item keys from existing progress — these items are skipped
    // during batch construction regardless of batch size changes
    const validatedItemKeys = new Set<string>(existingProgress?.validatedItemKeys ?? []);

    // Collect ALL items matching the filter (for accurate totals), then filter out validated ones (for batching)
    const allFilteredItems = this.collectItems(extractions, options, new Set());
    const unvalidatedItems = allFilteredItems.filter(item => !validatedItemKeys.has(itemKey(item)));

    // Count entities vs relationships in the full filtered set (including already validated)
    let filteredEntities = 0;
    let filteredRelationships = 0;
    for (const item of allFilteredItems) {
      if (item.type === 'entity') filteredEntities++;
      else filteredRelationships++;
    }

    // Distribute items round-robin across workers, then batch per-worker
    const workerQueues = new Map<string, ValidationBatch[]>();
    const perWorkerItems = new Map<string, ValidationBatchItem[]>();
    for (const wc of workerConfigs) {
      perWorkerItems.set(wc.name, []);
    }
    for (let i = 0; i < unvalidatedItems.length; i++) {
      const wc = workerConfigs[i % workerConfigs.length]!;
      perWorkerItems.get(wc.name)!.push(unvalidatedItems[i]!);
    }

    // Build batches per-worker using each worker's maxBatchSize (falls back to global batchSize)
    let batchIndex = 0;
    let totalBatches = 0;
    for (const wc of workerConfigs) {
      const items = perWorkerItems.get(wc.name)!;
      const batchSize = wc.maxBatchSize ?? this.config.batchSize;
      const batches: ValidationBatch[] = [];
      for (let i = 0; i < items.length; i += batchSize) {
        batches.push({
          batchIndex: batchIndex++,
          items: items.slice(i, i + batchSize),
        });
      }
      workerQueues.set(wc.name, batches);
      totalBatches += batches.length;
    }

    // Initialize or resume progress — always recompute totals from the filtered item set
    // so that sourceFilter changes and re-runs show accurate counts
    const progress = existingProgress
      ? resumeProgress(existingProgress, totalBatches, filteredEntities, filteredRelationships)
      : initializeProgress(progressWorkerName, filteredEntities, filteredRelationships, totalBatches);

    // Ensure validatedItemKeys is initialized on progress
    if (!progress.validatedItemKeys) {
      progress.validatedItemKeys = [...validatedItemKeys];
    }

    // Reset batch checkpoints — batch indices are for THIS run's batches only
    if (existingProgress) {
      progress.batchCheckpoints = [];
      progress.batches.completed = 0;
      progress.batches.failed = 0;
      progress.batches.pending = totalBatches;
      progress.batches.total = totalBatches;
    }

    // Persist initial progress so status tool can report batch counts immediately
    callbacks.onProgress?.(progress);

    // Collect all batch results (merged from checkpoints + new runs)
    const allEntityResults: EntityValidationResult[] = [];
    const allRelationshipResults: RelationshipValidationResult[] = [];

    // Shared mutable state across all workers
    let batchesAttempted = 0;
    let costExceeded = false;
    let stopped = false;

    // Create a worker runner for each configured worker
    const workerPromises: Promise<void>[] = [];

    for (const workerConfig of workerConfigs) {
      const provider = this.resolveProvider(workerConfig);
      const worker = new FullValidationWorker(workerConfig, provider, allSourcePaths, this.logDir, this.vocabularySummary, this.domainGuidance);
      const queue = workerQueues.get(workerConfig.name)!;

      // Spawn concurrent tasks for this worker
      const concurrency = workerConfig.concurrency;
      let queueIndex = 0;

      const runTask = async (): Promise<void> => {
        while (true) {
          if (signal?.aborted || stopped || costExceeded) break;
          if (effectiveMaxBatches !== undefined && batchesAttempted >= effectiveMaxBatches) break;

          // Grab next batch from this worker's queue
          const batchIdx = queueIndex++;
          if (batchIdx >= queue.length) break;
          const batch = queue[batchIdx]!;

          // Claim this batch immediately so concurrent tasks respect maxBatches
          batchesAttempted++;

          // Check stop signal periodically
          if (isStopRequested && await isStopRequested()) {
            stopped = true;
            break;
          }

          try {
            const batchResult = await worker.validateBatch(batch, signal);

            // Accumulate results (synchronized — JS is single-threaded between awaits)
            allEntityResults.push(...batchResult.entityResults);
            allRelationshipResults.push(...batchResult.relationshipResults);

            accumulateVerdicts(progress.verdicts, batchResult.entityResults, batchResult.relationshipResults);
            updateCost(progress.cost, batchResult.usage, workerConfig);
            progress.totalProcessingTimeMs += batchResult.processingTimeMs;

            // Record validated item keys for resume across batch size changes
            for (const batchItem of batch.items) {
              progress.validatedItemKeys!.push(itemKey(batchItem));
            }

            upsertCheckpoint(progress.batchCheckpoints, {
              batchIndex: batch.batchIndex,
              status: 'completed',
              completedAt: new Date().toISOString(),
              retries: getRetryCount(progress.batchCheckpoints, batch.batchIndex),
              processingTimeMs: batchResult.processingTimeMs,
            });

            progress.batches.completed++;
            progress.batches.pending = Math.max(0, progress.batches.pending - 1);
            progress.updatedAt = new Date().toISOString();

            callbacks.onBatchComplete?.(batch.batchIndex, batchResult);
            callbacks.onProgress?.(progress);

            if (effectiveMaxCost !== undefined && progress.cost.estimatedCost >= effectiveMaxCost) {
              costExceeded = true;
            }
          } catch (err) {
            const maxRetries = this.config.maxRetries ?? 2;
            const retries = getRetryCount(progress.batchCheckpoints, batch.batchIndex);

            upsertCheckpoint(progress.batchCheckpoints, {
              batchIndex: batch.batchIndex,
              status: retries < maxRetries ? 'pending' : 'failed',
              failedAt: new Date().toISOString(),
              errorMessage: err instanceof Error ? err.message : String(err),
              retries: retries + 1,
            });

            progress.batches.failed++;
            progress.batches.pending = Math.max(0, progress.batches.pending - 1);
            progress.updatedAt = new Date().toISOString();
          }
        }
      };

      // Spawn up to `concurrency` parallel tasks for this worker
      const taskCount = Math.min(concurrency, queue.length);
      for (let t = 0; t < taskCount; t++) {
        workerPromises.push(runTask());
      }
    }

    // Run all workers in parallel
    await Promise.all(workerPromises);

    // Build the report
    const report = this.buildReport(
      progressWorkerName,
      allEntityResults,
      allRelationshipResults,
      progress.cost,
      progress.totalProcessingTimeMs,
      progress.batches.completed,
    );

    return { progress, report };
  }

  // ── Batch Construction ──────────────────────────────────────────────

  /**
   * Build validation batches from extraction outputs.
   * Batches are grouped by source document so the worker's primary source context is consistent.
   */
  private collectItems(
    extractions: ExtractionOutput[],
    options: FullValidationRunOptions,
    validatedItemKeys: Set<string>,
  ): ValidationBatchItem[] {
    const items: ValidationBatchItem[] = [];

    for (const extraction of extractions) {
      // Apply source filter
      if (options.sourceFilter && options.sourceFilter.length > 0) {
        const matches = options.sourceFilter.some(f =>
          extraction.sourcePath === f || extraction.source.includes(f),
        );
        if (!matches) continue;
      }

      // Collect entity items, applying entity type filter
      const entityItems: EntityBatchItem[] = extraction.entities
        .filter(e => {
          if (options.entityFilter && options.entityFilter.length > 0) {
            return options.entityFilter.includes(e.entityType);
          }
          return true;
        })
        .map(entity => ({
          type: 'entity' as const,
          source: extraction.source,
          sourcePath: extraction.sourcePath,
          entity: {
            entityType: entity.entityType,
            label: entity.label,
            summary: entity.summary,
            properties: entity.properties,
            aliases: entity.aliases,
            sourceRefs: entity.sourceRefs,
          },
        }));

      // Collect relationship items
      const relationshipItems: RelationshipBatchItem[] = extraction.relationships.map(rel => ({
        type: 'relationship' as const,
        source: extraction.source,
        sourcePath: extraction.sourcePath,
        relationship: {
          type: rel.type,
          sourceLabel: rel.sourceLabel,
          targetLabel: rel.targetLabel,
          properties: rel.properties,
          sourceRefs: rel.sourceRefs,
        },
      }));

      // Combine and filter out already-validated items
      for (const item of [...entityItems, ...relationshipItems]) {
        if (!validatedItemKeys.has(itemKey(item))) {
          items.push(item);
        }
      }
    }

    return items;
  }

  // ── Report Construction ─────────────────────────────────────────────

  private buildReport(
    workerName: string,
    entityResults: EntityValidationResult[],
    relationshipResults: RelationshipValidationResult[],
    cost: ValidationCostTracker,
    totalProcessingTimeMs: number,
    batchesCompleted: number,
  ): FullValidationReport {

    // Aggregate entity counts
    const entityCounts = countVerdicts(entityResults.map(e => e.entityVerdict));
    const relCounts = countVerdicts(relationshipResults.map(r => r.relationshipVerdict));

    // Per-document summaries
    const byDocument = buildDocumentSummaries(entityResults, relationshipResults);

    // Per-entity-type summaries
    const byEntityType = buildEntityTypeSummaries(entityResults);

    // Flagged items
    const flaggedItems = buildFlaggedItems(entityResults, relationshipResults);

    // Proposed corrections for mismatches and hallucinations
    const corrections = buildCorrections(entityResults, relationshipResults);

    const totalEntities = entityResults.length;
    const totalRelationships = relationshipResults.length;
    const totalSeconds = totalProcessingTimeMs / 1000;

    const performance = {
      totalInputTokens: cost.inputTokens,
      totalOutputTokens: cost.outputTokens,
      totalTokens: cost.inputTokens + cost.outputTokens,
      totalProcessingTimeMs,
      outputTokensPerSecond: totalSeconds > 0 ? cost.outputTokens / totalSeconds : 0,
      avgInputTokensPerBatch: batchesCompleted > 0 ? Math.round(cost.inputTokens / batchesCompleted) : 0,
      avgOutputTokensPerBatch: batchesCompleted > 0 ? Math.round(cost.outputTokens / batchesCompleted) : 0,
      avgProcessingTimeMsPerBatch: batchesCompleted > 0 ? Math.round(totalProcessingTimeMs / batchesCompleted) : 0,
    };

    return {
      generatedAt: new Date().toISOString(),
      worker: workerName,
      performance,
      aggregate: {
        entities: {
          total: totalEntities,
          validated: totalEntities,
          confirmed: entityCounts.confirmed,
          mismatch: entityCounts.mismatch,
          hallucinated: entityCounts.hallucinated,
          unverifiable: entityCounts.unverifiable,
          corrected: entityCounts.corrected,
          accuracyRate: totalEntities > 0
            ? (entityCounts.confirmed + entityCounts.corrected) / totalEntities
            : 1,
        },
        relationships: {
          total: totalRelationships,
          validated: totalRelationships,
          confirmed: relCounts.confirmed,
          mismatch: relCounts.mismatch,
          hallucinated: relCounts.hallucinated,
          unverifiable: relCounts.unverifiable,
          corrected: relCounts.corrected,
          accuracyRate: totalRelationships > 0
            ? (relCounts.confirmed + relCounts.corrected) / totalRelationships
            : 1,
        },
      },
      byDocument,
      byEntityType,
      flaggedItems,
      corrections,
      cost,
      totalProcessingTimeMs,
    };
  }

  // ── Provider Resolution ─────────────────────────────────────────────

  private resolveWorkerConfig(workerName?: string): FullValidationWorkerConfig {
    const name = workerName ?? this.config.defaultWorker;
    const cfg = this.config.workers.find(w => w.name === name);
    if (!cfg) {
      throw new Error(
        `Validation worker "${name}" not found in config. ` +
        `Available workers: ${this.config.workers.map(w => w.name).join(', ')}`,
      );
    }
    return cfg;
  }

  private resolveProvider(workerConfig: FullValidationWorkerConfig): LLMProvider {
    // Local workers (no llmProvider) are registered by their worker name.
    // Cloud workers (e.g. "anthropic") are registered by provider name.
    const lookupKey = workerConfig.llmProvider ?? workerConfig.name;
    const provider = this.providers.get(lookupKey);
    if (!provider) {
      throw new Error(
        `LLM provider for worker "${workerConfig.name}" is not registered (looked up as "${lookupKey}"). ` +
        'Register it on the orchestrator with registerLLMProvider().',
      );
    }
    return provider;
  }
}

// ── State Helpers ─────────────────────────────────────────────────────

function initializeProgress(
  workerName: string,
  totalEntities: number,
  totalRelationships: number,
  totalBatches: number,
): FullValidationProgress {
  const now = new Date().toISOString();
  return {
    startedAt: now,
    updatedAt: now,
    worker: workerName,
    totalEntities,
    totalRelationships,
    batches: {
      total: totalBatches,
      completed: 0,
      failed: 0,
      pending: totalBatches,
    },
    verdicts: { confirmed: 0, mismatch: 0, hallucinated: 0, unverifiable: 0, corrected: 0 },
    cost: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    totalProcessingTimeMs: 0,
    batchCheckpoints: [],
  };
}

function resumeProgress(
  existing: FullValidationProgress,
  totalBatches: number,
  totalEntities: number,
  totalRelationships: number,
): FullValidationProgress {
  const completed = existing.batchCheckpoints.filter(c => c.status === 'completed').length;
  const failed = existing.batchCheckpoints.filter(c => c.status === 'failed').length;
  // Recover totalProcessingTimeMs from batch checkpoints if missing (e.g. progress from older build)
  const totalProcessingTimeMs = existing.totalProcessingTimeMs
    ?? existing.batchCheckpoints.reduce((sum, c) => sum + (c.processingTimeMs ?? 0), 0);

  return {
    ...existing,
    totalEntities,
    totalRelationships,
    batches: {
      total: totalBatches,
      completed,
      failed,
      pending: totalBatches - completed - failed,
    },
    totalProcessingTimeMs,
    updatedAt: new Date().toISOString(),
  };
}

function upsertCheckpoint(checkpoints: BatchCheckpoint[], entry: BatchCheckpoint): void {
  const idx = checkpoints.findIndex(c => c.batchIndex === entry.batchIndex);
  if (idx >= 0) {
    checkpoints[idx] = entry;
  } else {
    checkpoints.push(entry);
  }
}

function getRetryCount(checkpoints: BatchCheckpoint[], batchIndex: number): number {
  return checkpoints.find(c => c.batchIndex === batchIndex)?.retries ?? 0;
}

function accumulateVerdicts(
  verdicts: VerdictCounts,
  entityResults: EntityValidationResult[],
  relationshipResults: RelationshipValidationResult[],
): void {
  for (const r of entityResults) {
    verdicts[r.entityVerdict]++;
  }
  for (const r of relationshipResults) {
    verdicts[r.relationshipVerdict]++;
  }
}

function updateCost(
  cost: ValidationCostTracker,
  usage: { inputTokens: number; outputTokens: number },
  workerConfig: FullValidationWorkerConfig,
): void {
  cost.inputTokens += usage.inputTokens;
  cost.outputTokens += usage.outputTokens;
  const inputCost = (usage.inputTokens / 1_000_000) * workerConfig.costPerMillionInputTokens;
  const outputCost = (usage.outputTokens / 1_000_000) * workerConfig.costPerMillionOutputTokens;
  cost.estimatedCost += inputCost + outputCost;
}

// ── Report Helpers ────────────────────────────────────────────────────

function countVerdicts(verdicts: FullValidationVerdict[]): {
  confirmed: number; mismatch: number; hallucinated: number; unverifiable: number; corrected: number;
} {
  return verdicts.reduce(
    (counts, v) => {
      counts[v]++;
      return counts;
    },
    { confirmed: 0, mismatch: 0, hallucinated: 0, unverifiable: 0, corrected: 0 },
  );
}

function buildDocumentSummaries(
  entityResults: EntityValidationResult[],
  relationshipResults: RelationshipValidationResult[],
): DocumentValidationSummary[] {
  const docMap = new Map<string, DocumentValidationSummary>();

  const getOrCreate = (source: string): DocumentValidationSummary => {
    let summary = docMap.get(source);
    if (!summary) {
      summary = {
        source,
        entities: { total: 0, confirmed: 0, mismatch: 0, hallucinated: 0, unverifiable: 0, corrected: 0 },
        relationships: { total: 0, confirmed: 0, mismatch: 0, hallucinated: 0, unverifiable: 0, corrected: 0 },
        accuracyRate: 1,
      };
      docMap.set(source, summary);
    }
    return summary;
  };

  for (const r of entityResults) {
    const s = getOrCreate(r.source);
    s.entities.total++;
    s.entities[r.entityVerdict]++;
  }
  for (const r of relationshipResults) {
    const s = getOrCreate(r.source);
    s.relationships.total++;
    s.relationships[r.relationshipVerdict]++;
  }

  // Compute accuracy rates
  for (const summary of docMap.values()) {
    const total = summary.entities.total + summary.relationships.total;
    const correct = summary.entities.confirmed + summary.entities.corrected
      + summary.relationships.confirmed + summary.relationships.corrected;
    summary.accuracyRate = total > 0 ? correct / total : 1;
  }

  return [...docMap.values()];
}

function buildEntityTypeSummaries(
  entityResults: EntityValidationResult[],
): EntityTypeValidationSummary[] {
  const typeMap = new Map<string, EntityTypeValidationSummary>();

  for (const r of entityResults) {
    let s = typeMap.get(r.entityType);
    if (!s) {
      s = {
        entityType: r.entityType,
        total: 0,
        confirmed: 0,
        mismatch: 0,
        hallucinated: 0,
        unverifiable: 0,
        corrected: 0,
        accuracyRate: 1,
      };
      typeMap.set(r.entityType, s);
    }
    s.total++;
    s[r.entityVerdict]++;
  }

  for (const s of typeMap.values()) {
    s.accuracyRate = s.total > 0 ? (s.confirmed + s.corrected) / s.total : 1;
  }

  return [...typeMap.values()];
}

function buildFlaggedItems(
  entityResults: EntityValidationResult[],
  relationshipResults: RelationshipValidationResult[],
): FlaggedValidationItem[] {
  const flagged: FlaggedValidationItem[] = [];
  const flagVerdicts = new Set<FullValidationVerdict>(['mismatch', 'hallucinated', 'unverifiable']);

  for (const r of entityResults) {
    if (flagVerdicts.has(r.entityVerdict)) {
      flagged.push({
        source: r.source,
        itemType: 'entity',
        label: `${r.entityType}: ${r.label}`,
        verdict: r.entityVerdict,
        evidence: r.notes ?? '',
      });
    }
    // Also flag individual properties
    for (const pv of r.propertyVerdicts) {
      if (flagVerdicts.has(pv.verdict)) {
        flagged.push({
          source: r.source,
          itemType: 'entity',
          label: r.label,
          verdict: pv.verdict,
          property: pv.property,
          extractedValue: pv.extractedValue,
          evidence: pv.evidence,
        });
      }
    }
  }

  for (const r of relationshipResults) {
    if (flagVerdicts.has(r.relationshipVerdict)) {
      flagged.push({
        source: r.source,
        itemType: 'relationship',
        label: `${r.sourceLabel} → [${r.type}] → ${r.targetLabel}`,
        verdict: r.relationshipVerdict,
        evidence: r.notes ?? '',
      });
    }
  }

  return flagged;
}

/**
 * Build mechanical, AI-applicable corrections from validation verdicts.
 *
 * Four correction classes are emitted (see plan/correction-workflow-plan.md):
 * - entity property update / remove-property (property mismatch with or without a concrete replacement)
 * - entity delete (hallucinated entity — the apply step cascades relationships referencing it)
 * - relationship property update / remove-property
 * - relationship delete (hallucinated relationship)
 *
 * `unverifiable` verdicts never become corrections — the user must decide.
 */
function buildCorrections(
  entityResults: EntityValidationResult[],
  relationshipResults: RelationshipValidationResult[],
): ProposedCorrection[] {
  const corrections: ProposedCorrection[] = [];

  for (const r of entityResults) {
    for (const pv of r.propertyVerdicts) {
      if (pv.correction) {
        const isRemoval = pv.correction.correctedValue === null;
        const base = {
          source: r.source,
          itemType: 'entity' as const,
          label: r.label,
          property: pv.property,
          originalValue: pv.extractedValue,
          sourceEvidence: pv.correction.sourceEvidence,
          evidenceLines: pv.correction.evidenceLines,
          confidence: pv.correction.confidence,
        };
        corrections.push(
          isRemoval
            ? { ...base, operation: 'remove-property' }
            : { ...base, operation: 'update', correctedValue: pv.correction.correctedValue },
        );
      }
    }

    if (r.entityVerdict === 'hallucinated') {
      corrections.push({
        source: r.source,
        itemType: 'entity',
        operation: 'delete',
        label: r.label,
        sourceEvidence: r.notes ?? 'Entity verdict: hallucinated — no supporting evidence in source.',
        evidenceLines: { lineStart: 0, lineEnd: 0 },
        confidence: 0.9,
      });
    }
  }

  for (const r of relationshipResults) {
    const key = { sourceLabel: r.sourceLabel, type: r.type, targetLabel: r.targetLabel };
    const displayLabel = `${r.sourceLabel} → [${r.type}] → ${r.targetLabel}`;

    for (const pv of r.propertyVerdicts) {
      if (pv.correction) {
        const isRemoval = pv.correction.correctedValue === null;
        const base = {
          source: r.source,
          itemType: 'relationship' as const,
          label: displayLabel,
          property: pv.property,
          originalValue: pv.extractedValue,
          sourceEvidence: pv.correction.sourceEvidence,
          evidenceLines: pv.correction.evidenceLines,
          confidence: pv.correction.confidence,
          relationshipKey: key,
        };
        corrections.push(
          isRemoval
            ? { ...base, operation: 'remove-property' }
            : { ...base, operation: 'update', correctedValue: pv.correction.correctedValue },
        );
      }
    }

    if (r.relationshipVerdict === 'hallucinated') {
      corrections.push({
        source: r.source,
        itemType: 'relationship',
        operation: 'delete',
        label: displayLabel,
        sourceEvidence: r.notes ?? 'Relationship verdict: hallucinated — no supporting evidence in source.',
        evidenceLines: { lineStart: 0, lineEnd: 0 },
        confidence: 0.9,
        relationshipKey: key,
      });
    }
  }

  return corrections;
}
