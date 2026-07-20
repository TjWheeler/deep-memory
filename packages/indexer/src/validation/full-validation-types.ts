/**
 * Types for full extraction validation.
 *
 * LLM-powered validation of every extracted entity and relationship
 * against source documents. Workers have tool access to navigate
 * source documents (read lines, search, list headings, cross-reference).
 *
 * Two modes:
 * - report: read-only verdicts, no data modification
 * - fix: proposes corrections for mismatches and hallucinations
 */

import type { ExtractedEntity, ExtractedRelationship } from '../types/extraction.js';

// ── Verdicts ──────────────────────────────────────────────────────────

/** Verdict assigned to each validated property/entity/relationship */
export type FullValidationVerdict =
  | 'confirmed'     // Value matches source text — worker found supporting evidence
  | 'mismatch'      // Value exists in source but is wrong (wrong field, wrong unit, different entity's data)
  | 'hallucinated'  // Value does not appear in the source document — fabricated by the extraction model
  | 'unverifiable'  // Source text at referenced lines is insufficient; worker explored but could not confirm or deny
  | 'corrected';    // (Fix mode only) Value was wrong; worker has proposed a correction with source evidence

/**
 * Operating mode for validation.
 * @deprecated Always 'fix' — validation always proposes corrections. Retained for serialized state compatibility.
 */
export type FullValidationMode = 'fix';

// ── Worker Configuration ──────────────────────────────────────────────

/** Configuration for a single validation worker */
export interface FullValidationWorkerConfig {
  /** Unique name for this worker (e.g., "cloud-opus", "local-qwen35b") */
  name: string;
  /** API key for authenticated endpoints (merged from config.secrets.json) */
  apiKey?: string;
  /**
   * LLM provider name. Must match a registered LLM provider on the orchestrator.
   * Use "anthropic" for the Anthropic Messages API.
   * Omit for any OpenAI-compatible endpoint (vLLM, OpenAI, Azure, Ollama, etc.) — the built-in provider is used automatically.
   */
  llmProvider?: string;
  /**
   * OpenAI-compatible endpoint URL for local workers (e.g., "http://localhost:8020/v1").
   * Required when llmProvider is omitted. Ignored for cloud providers like "anthropic".
   */
  endpoint?: string;
  /** Model identifier at the provider */
  model: string;
  /** Maximum entities/relationships per batch sent to the worker */
  maxBatchSize: number;
  /** Maximum output tokens per request */
  maxTokens: number;
  /** Cost per 1M input tokens in USD */
  costPerMillionInputTokens: number;
  /** Cost per 1M output tokens in USD */
  costPerMillionOutputTokens: number;
  /** Maximum concurrent requests for this worker */
  concurrency: number;
  /** Maximum tool calls the worker can make per batch (cost control). Default: 20 */
  maxToolCallsPerBatch?: number;
  /** Extra parameters merged into the request body (e.g., chat_template_kwargs for vLLM) */
  extraBodyParams?: Record<string, unknown>;
}

/** Hybrid validation configuration — two-tier: fast first pass, capable escalation */
export interface FullValidationHybridConfig {
  /** Worker name for the first pass (cheaper/faster model) */
  firstPass: string;
  /** Worker name for escalation (more capable model) */
  escalation: string;
  /** Verdicts that trigger escalation to the more capable model */
  escalateOn: FullValidationVerdict[];
}

/** Top-level validation configuration in config.json */
export interface FullValidationConfig {
  /** Named workers available for validation */
  workers: FullValidationWorkerConfig[];
  /** Default worker name (must match a worker in the workers array) */
  defaultWorker: string;
  /** Number of entities/relationships per batch. Default: 10 */
  batchSize: number;
  /** Optional hybrid two-tier configuration */
  hybrid?: FullValidationHybridConfig;
  /** Maximum number of batches to process in this run (cost control during R&D) */
  maxBatches?: number;
  /** Only validate entities/relationships from these source documents */
  sourceFilter?: string[];
  /** Only validate specific entity types (e.g., ["Equipment", "Fluid"]) */
  entityFilter?: string[];
  /** Stop when estimated cost reaches this threshold in USD */
  maxCost?: number;
  /** Maximum retries for failed batches. Default: 2 */
  maxRetries?: number;
}

// ── Batch Types ───────────────────────────────────────────────────────

/** Type discriminator for batch items */
export type BatchItemType = 'entity' | 'relationship';

/** An entity queued for validation */
export interface EntityBatchItem {
  type: 'entity';
  /** Source document filename */
  source: string;
  /** Full path to the source document */
  sourcePath: string;
  /** The extracted entity to validate */
  entity: {
    entityType: string;
    label: string;
    summary?: string;
    properties: Record<string, unknown>;
    aliases: string[];
    sourceRefs: Array<{
      description: string;
      lineStart: number;
      lineEnd: number;
    }>;
  };
}

/** A relationship queued for validation */
export interface RelationshipBatchItem {
  type: 'relationship';
  /** Source document filename */
  source: string;
  /** Full path to the source document */
  sourcePath: string;
  /** The extracted relationship to validate */
  relationship: {
    type: string;
    sourceLabel: string;
    targetLabel: string;
    properties: Record<string, unknown>;
    sourceRefs: Array<{
      description: string;
      lineStart: number;
      lineEnd: number;
    }>;
  };
}

/** A single item in a validation batch */
export type ValidationBatchItem = EntityBatchItem | RelationshipBatchItem;

/** A batch of items to validate in a single LLM call */
export interface ValidationBatch {
  /** Batch index (0-based, used for checkpointing) */
  batchIndex: number;
  /** Items in this batch */
  items: ValidationBatchItem[];
}

// ── Worker Results ────────────────────────────────────────────────────

/** Verdict for a single property on an entity */
export interface PropertyValidationResult {
  /** Property name */
  property: string;
  /** Extracted value */
  extractedValue: unknown;
  /** Validation verdict */
  verdict: FullValidationVerdict;
  /** Source evidence (quoted text or explanation) */
  evidence: string;
  /** Source line numbers where evidence was found */
  evidenceLines?: { lineStart: number; lineEnd: number };
  /** Proposed correction (fix mode only, when verdict is corrected) */
  correction?: {
    correctedValue: unknown;
    sourceEvidence: string;
    evidenceLines: { lineStart: number; lineEnd: number };
    confidence: number;
  };
}

/** Validation result for a single entity */
export interface EntityValidationResult {
  /** Source document */
  source: string;
  /** Entity type */
  entityType: string;
  /** Entity label */
  label: string;
  /** Overall entity verdict */
  entityVerdict: FullValidationVerdict;
  /** Whether the entity itself exists in the source (not hallucinated) */
  existenceVerdict: FullValidationVerdict;
  /** Classification correctness verdict */
  classificationVerdict: FullValidationVerdict;
  /** Per-property verdicts */
  propertyVerdicts: PropertyValidationResult[];
  /** Alias verdicts — each alias gets a verdict */
  aliasVerdicts: Array<{
    alias: string;
    verdict: FullValidationVerdict;
    evidence: string;
  }>;
  /** Worker notes (free-text explanation) */
  notes?: string;
  /**
   * Structural remodels the worker proposed for this item — e.g. a cross-reference
   * value that should be its own entity with a correctly-typed edge. Each step is a
   * correction primitive; the orchestrator links a result's steps into one atomic group.
   */
  remediations?: RemediationStep[];
}

/** Validation result for a single relationship */
export interface RelationshipValidationResult {
  /** Source document */
  source: string;
  /** Relationship type */
  type: string;
  /** Source entity label */
  sourceLabel: string;
  /** Target entity label */
  targetLabel: string;
  /** Overall relationship verdict */
  relationshipVerdict: FullValidationVerdict;
  /** Whether the relationship is supported by source text */
  existenceVerdict: FullValidationVerdict;
  /** Whether the relationship type is correct */
  typeVerdict: FullValidationVerdict;
  /** Whether the directionality (source→target) is correct */
  directionalityVerdict: FullValidationVerdict;
  /** Per-property verdicts */
  propertyVerdicts: PropertyValidationResult[];
  /** Worker notes */
  notes?: string;
  /**
   * Structural remodels the worker proposed for this item — e.g. an edge attached to
   * the wrong endpoint, or a deferral value that should be its own entity with a
   * correctly-typed edge. Each step is a correction primitive; the orchestrator links a
   * result's steps into one atomic group.
   */
  remediations?: RemediationStep[];
}

/** Result from validating a single batch */
export interface BatchValidationResult {
  /** Batch index */
  batchIndex: number;
  /** Entity results in this batch */
  entityResults: EntityValidationResult[];
  /** Relationship results in this batch */
  relationshipResults: RelationshipValidationResult[];
  /** Token usage for this batch */
  usage: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Number of tool calls made during this batch */
  toolCalls: number;
  /** Processing time in milliseconds */
  processingTimeMs: number;
  /** Worker name that processed this batch */
  worker: string;
  /** Whether this batch was an escalation (hybrid mode) */
  isEscalation?: boolean;
}

// ── State and Progress ────────────────────────────────────────────────

/** Aggregate verdict counts */
export interface VerdictCounts {
  confirmed: number;
  mismatch: number;
  hallucinated: number;
  unverifiable: number;
  corrected: number;
}

/** Cost tracking */
export interface ValidationCostTracker {
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

/** Batch status in the progress file */
export type BatchStatus = 'pending' | 'completed' | 'failed';

/** Per-batch checkpoint entry */
export interface BatchCheckpoint {
  batchIndex: number;
  status: BatchStatus;
  completedAt?: string;
  failedAt?: string;
  errorMessage?: string;
  retries: number;
  /** Processing time for this batch in milliseconds */
  processingTimeMs?: number;
}

/** Full validation progress state — persisted to state/full-validation-progress.json */
export interface FullValidationProgress {
  /** When validation started */
  startedAt: string;
  /** When validation was last updated */
  updatedAt: string;
  /** Worker used (or "hybrid" for hybrid mode) */
  worker: string;
  /** Total entities to validate */
  totalEntities: number;
  /** Total relationships to validate */
  totalRelationships: number;
  /** Batch tracking */
  batches: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
  };
  /** Aggregate verdicts across all completed batches */
  verdicts: VerdictCounts;
  /** Cost tracking */
  cost: ValidationCostTracker;
  /** Total LLM processing time across all completed batches in milliseconds */
  totalProcessingTimeMs: number;
  /** Per-batch checkpoint entries */
  batchCheckpoints: BatchCheckpoint[];
  /** Keys of validated items — used to skip already-validated items when batch size changes */
  validatedItemKeys?: string[];
}

// ── Validation Report ─────────────────────────────────────────────────

/** Per-document aggregate in the report */
export interface DocumentValidationSummary {
  /** Source document filename */
  source: string;
  /** Entity counts by verdict */
  entities: {
    total: number;
    confirmed: number;
    mismatch: number;
    hallucinated: number;
    unverifiable: number;
    corrected: number;
  };
  /** Relationship counts by verdict */
  relationships: {
    total: number;
    confirmed: number;
    mismatch: number;
    hallucinated: number;
    unverifiable: number;
    corrected: number;
  };
  /** Accuracy rate for this document */
  accuracyRate: number;
}

/** Per-entity-type aggregate in the report */
export interface EntityTypeValidationSummary {
  entityType: string;
  total: number;
  confirmed: number;
  mismatch: number;
  hallucinated: number;
  unverifiable: number;
  corrected: number;
  accuracyRate: number;
}

/** A flagged item requiring human attention */
export interface FlaggedValidationItem {
  /** Source document */
  source: string;
  /** Item type */
  itemType: 'entity' | 'relationship';
  /** Entity label or relationship description */
  label: string;
  /** Verdict that caused flagging */
  verdict: FullValidationVerdict;
  /** Property name (if property-level issue) */
  property?: string;
  /** The extracted value */
  extractedValue?: unknown;
  /** Evidence from source */
  evidence: string;
  /** Worker notes */
  notes?: string;
}

/**
 * The kind of mutation a correction represents.
 * - `update` — replace a property value with {@link PropertyCorrection.correctedValue}
 * - `remove-property` — delete the property entry entirely (source has no supporting value)
 * - `delete` — remove the entity (and cascade its relationships) or the relationship itself
 * - `create` — materialise a new entity or relationship the extraction should have carried
 * - `retarget` — reattach one endpoint of an existing relationship to a different entity
 */
export type CorrectionOperation = 'update' | 'remove-property' | 'delete' | 'create' | 'retarget';

/** Machine-readable relationship identity, matched against extraction JSON. */
export interface RelationshipKey {
  sourceLabel: string;
  type: string;
  targetLabel: string;
}

/**
 * Fields common to every correction, regardless of item type or operation.
 * The applier stamps `approved` when a correction is committed; the proposer
 * stamps `remediationGroupId` when a correction is one primitive of a larger
 * remodel that must apply as an atomic unit.
 */
export interface CorrectionBase {
  /** Source document */
  source: string;
  /** Entity label or "source → [type] → target" for display/debug */
  label: string;
  /** Source evidence for the correction */
  sourceEvidence: string;
  /** Line numbers of the evidence */
  evidenceLines: { lineStart: number; lineEnd: number };
  /** Confidence in the correction (0-1) */
  confidence: number;
  /** Whether this correction has been approved by a human */
  approved?: boolean;
  /**
   * Links this correction to the other primitives of a single remodel. All
   * corrections sharing an id are applied (or skipped) as one atomic group; a
   * group's members must all share the same `source`.
   */
  remediationGroupId?: string;
}

/**
 * Overwrite a single property (`update`) or drop it entirely (`remove-property`)
 * on an existing entity or relationship. This is the field-level correction the
 * validation worker has emitted since the first correction increment.
 */
export interface PropertyCorrection extends CorrectionBase {
  itemType: 'entity' | 'relationship';
  operation: 'update' | 'remove-property';
  /** Property being corrected */
  property: string;
  /** Original extracted value */
  originalValue?: unknown;
  /** Proposed corrected value — present for `update`, absent for `remove-property` */
  correctedValue?: unknown;
  /** Required when `itemType` is `relationship` — the edge to mutate */
  relationshipKey?: RelationshipKey;
}

/** Remove an entity (cascading its relationships) or a single relationship. */
export interface DeleteCorrection extends CorrectionBase {
  itemType: 'entity' | 'relationship';
  operation: 'delete';
  /** Required when `itemType` is `relationship` — the edge to remove */
  relationshipKey?: RelationshipKey;
}

/** Materialise a new entity that the extraction failed to model on its own. */
export interface CreateEntityCorrection extends CorrectionBase {
  itemType: 'entity';
  operation: 'create';
  /** The entity to add to the extraction file */
  entity: ExtractedEntity;
}

/** Materialise a new relationship between entities referenced by label. */
export interface CreateRelationshipCorrection extends CorrectionBase {
  itemType: 'relationship';
  operation: 'create';
  /** The relationship to add — endpoints reference entities by label */
  relationship: ExtractedRelationship;
}

/** Reattach one endpoint of an existing relationship to a different entity. */
export interface RetargetRelationshipCorrection extends CorrectionBase {
  itemType: 'relationship';
  operation: 'retarget';
  /** Current identity of the edge to retarget */
  relationshipKey: RelationshipKey;
  /** Which endpoint moves */
  endpoint: 'source' | 'target';
  /** Label of the entity the chosen endpoint should point at instead */
  newLabel: string;
}

/**
 * A proposed correction (fix mode). Discriminated on `(itemType, operation)`:
 * narrow on `operation` (and `itemType` for `create`) before reading
 * operation-specific fields.
 */
export type ProposedCorrection =
  | PropertyCorrection
  | DeleteCorrection
  | CreateEntityCorrection
  | CreateRelationshipCorrection
  | RetargetRelationshipCorrection;

/** Distribute `Omit` across each member of a union so the discriminated shape survives. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/**
 * A structural fix as the validation worker emits it — one primitive of a proposed
 * remodel. It is the {@link ProposedCorrection} union with the fields the orchestrator
 * owns removed: `source` (stamped from the validated item), `approved` (stamped by the
 * applier on commit), and `remediationGroupId` (stamped when the orchestrator links the
 * remodel's primitives into one atomic group). Deriving it from the correction union
 * keeps the payload shapes single-sourced — the worker cannot drift from what the applier
 * consumes.
 */
export type RemediationStep = DistributiveOmit<
  ProposedCorrection,
  'source' | 'approved' | 'remediationGroupId'
>;

/** Performance and token usage summary */
export interface ValidationPerformanceSummary {
  /** Total input tokens consumed across all batches */
  totalInputTokens: number;
  /** Total output tokens generated across all batches */
  totalOutputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
  /** Total LLM processing time in milliseconds */
  totalProcessingTimeMs: number;
  /** Output tokens per second (useful for estimating full-run duration) */
  outputTokensPerSecond: number;
  /** Average input tokens per batch */
  avgInputTokensPerBatch: number;
  /** Average output tokens per batch */
  avgOutputTokensPerBatch: number;
  /** Average processing time per batch in milliseconds */
  avgProcessingTimeMsPerBatch: number;
}

/** Complete validation report — persisted to state/full-validation-report.json */
export interface FullValidationReport {
  /** When the report was generated */
  generatedAt: string;
  /** Worker used */
  worker: string;
  /** Token usage and throughput metrics */
  performance: ValidationPerformanceSummary;
  /** Aggregate statistics */
  aggregate: {
    entities: {
      total: number;
      validated: number;
      confirmed: number;
      mismatch: number;
      hallucinated: number;
      unverifiable: number;
      corrected: number;
      accuracyRate: number;
    };
    relationships: {
      total: number;
      validated: number;
      confirmed: number;
      mismatch: number;
      hallucinated: number;
      unverifiable: number;
      corrected: number;
      accuracyRate: number;
    };
  };
  /** Per-document breakdown */
  byDocument: DocumentValidationSummary[];
  /** Per-entity-type breakdown */
  byEntityType: EntityTypeValidationSummary[];
  /** Items flagged for human attention */
  flaggedItems: FlaggedValidationItem[];
  /** Proposed corrections for mismatches and hallucinations */
  corrections: ProposedCorrection[];
  /** Cost summary */
  cost: ValidationCostTracker;
  /** Total processing time in milliseconds */
  totalProcessingTimeMs: number;
}

// ── Tool Definitions (for LLM tool use) ───────────────────────────────

/** Tool call from the validation LLM */
export interface ValidationToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** Tool result returned to the validation LLM */
export interface ValidationToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

// ── Cost Estimation ───────────────────────────────────────────────────

/** Validation cost estimate (added to analysis report) */
export interface ValidationCostEstimate {
  totalEntities: number;
  totalRelationships: number;
  totalBatches: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Cost estimate per configured worker */
  costByWorker: Record<string, string>;
}
