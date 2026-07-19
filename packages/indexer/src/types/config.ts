/**
 * Configuration types for the indexing pipeline.
 */

import type { GovernanceMode } from '@utaba/deep-memory';
import type { ValidationConfig } from './validation.js';
import type { FullValidationConfig } from '../validation/full-validation-types.js';
import type { DoclingConvertOptions } from '../conversion/types.js';

/**
 * Configurable quality thresholds for extraction and consolidation review.
 * These determine when metrics are rated 'good', 'acceptable', or 'needs-work'.
 * Appropriate thresholds depend on the domain — a medical knowledge graph
 * demands near-zero error rates, while a personal contacts graph may tolerate more.
 */
export interface QualityThresholds {
  extraction: {
    /** Property coverage (%). Entities above 'good' = good, above 'acceptable' = acceptable, below = needs-work */
    propertyCoverage: { good: number; acceptable: number };
    /** Orphan relationship rate (%). Below 'good' = good, below 'acceptable' = acceptable, above = needs-work */
    orphanRate: { good: number; acceptable: number };
    /** Truncation rate (%). At/below 'good' = good, at/below 'acceptable' = acceptable, above = needs-work */
    truncationRate: { good: number; acceptable: number };
  };
  consolidation: {
    /** Merge confidence bands. Scores >= high are high-confidence, >= medium are medium, below medium are low */
    mergeConfidence: { high: number; medium: number };
    /** Aliases this length or shorter are flagged as too generic */
    shortAliasLength: number;
    /** Property key overlap (Jaccard) below this ratio flags inconsistent merges */
    propertyOverlapMinimum: number;
    /** Type consistency: more than this many flagged merges = needs-work, 1..N = acceptable, 0 = good */
    typeConsistencyMaxAcceptable: number;
  };
}

/** Default quality thresholds — suitable for general-purpose knowledge graphs */
export const DEFAULT_QUALITY_THRESHOLDS: QualityThresholds = {
  extraction: {
    propertyCoverage: { good: 95, acceptable: 90 },
    orphanRate: { good: 2, acceptable: 5 },
    truncationRate: { good: 0, acceptable: 10 },
  },
  consolidation: {
    mergeConfidence: { high: 0.95, medium: 0.9 },
    shortAliasLength: 4,
    propertyOverlapMinimum: 0.3,
    typeConsistencyMaxAcceptable: 5,
  },
};

/** Top-level orchestrator configuration */
export interface OrchestratorConfig {
  /** Path to the index-state directory (entity registry, source list, extraction outputs) */
  stateDir: string;
  /** Path to the vocabulary file (starter kit vocabulary.md or parsed JSON) */
  vocabularyPath: string;
  /** Path to extraction rules/strategy (starter kit indexing-strategy.md or parsed JSON) */
  extractionRulesPath?: string;
  /** Path to domain guidance (starter kit domain-guidance.md) — domain-specific knowledge for the LLM */
  domainGuidancePath?: string;
  /** Repository ID to import into */
  repositoryId: string;
  /** Worker configuration for the extraction phase */
  extraction: ExtractionConfig;
  /** Reasoning Agent configuration for the consolidation phase */
  consolidation: ConsolidationConfig;
  /** Deep-memory configuration for the import phase */
  import: ImportConfig;
  /** Validation configuration (per-output Tier 1/2 validation + import-phase checkpoints) */
  validation?: ValidationConfig;
  /** Full extraction validation configuration (LLM-powered per-entity/relationship validation) */
  fullValidation?: FullValidationConfig;
  /** Embeddings configuration (embed all entities after import) */
  embeddings?: EmbeddingsConfig;
  /** Quality thresholds for review diagnostics — domain-specific acceptable error rates */
  qualityThresholds: QualityThresholds;
  /** External services the pipeline can call (e.g. document conversion) */
  services?: ServicesConfig;
  /**
   * How vocabulary-conformance violations are treated by the pre-consolidation
   * gate. `locked` fails on any violation; `managed` (default) warns and
   * surfaces vocabulary-extension recommendations for recurring closed-enum
   * values; `open` warns. Defaults to `managed` when omitted.
   */
  governanceMode?: GovernanceMode;
}

/** External-service configuration block */
export interface ServicesConfig {
  /** Document-conversion service (docling-serve) for rich-format sources */
  docling?: DoclingServiceConfig;
}

/** Configuration for the document-conversion service */
export interface DoclingServiceConfig {
  /** Base URL of the docling-serve container (e.g. http://localhost:5001) */
  endpoint: string;
  /**
   * Per-request timeout in milliseconds (default 600_000). On the async path
   * this bounds each individual submit/poll/result call, not the whole job.
   */
  timeoutMs?: number;
  /** Retry attempts on transient failures (default 3) */
  maxRetries?: number;
  /**
   * Whether the service runs OCR. When set, it is the global OCR decision and
   * disables the per-source text-yield heuristic. Leave unset to let the
   * heuristic decide per PDF (non-PDF formats carry text natively and never
   * run OCR). A per-source `doOcr` override takes precedence over this.
   */
  doOcr?: boolean;
  /** API key sent as the X-Api-Key header when the service requires auth */
  apiKey?: string;
  /**
   * How conversions are submitted. `async` submits a job and polls for the
   * result, which survives the server-side synchronous wait ceiling that
   * large documents hit; `sync` keeps a single request open. Defaults to
   * `async`; `sync` is the escape hatch for older containers without the async
   * routes.
   */
  mode?: 'sync' | 'async';
  /**
   * Base interval in milliseconds between async status polls (default 1_000).
   * The wait grows with full-jitter backoff toward `maxPollIntervalMs`.
   */
  pollIntervalMs?: number;
  /** Ceiling in milliseconds the async poll backoff grows toward (default 15_000). */
  maxPollIntervalMs?: number;
  /**
   * Safety ceiling in milliseconds on a whole async job — from submit until a
   * terminal status. Async has no per-request wall clock by design, so this
   * only stops an indefinitely-pending task from polling forever. Defaults to
   * 3_600_000 (1 hour), i.e. effectively off for any real conversion.
   */
  maxTotalWaitMs?: number;
  /**
   * Chars-per-page floor below which a born-digital PDF is treated as scanned
   * and reconverted once with OCR. A born-digital page typically yields many
   * hundreds of characters; a scanned page with no text layer yields near
   * zero. Default 100. Only consulted when no explicit `doOcr` (per-source or
   * global) is set and the converted document reported a page count.
   */
  ocrTextYieldThreshold?: number;
  /**
   * Process-wide default conversion options forwarded to docling-serve's
   * convert step. Each field is optional and, when unset, leaves docling's
   * default in force. A per-source `sourceConvertOptions` override wins over
   * this default for that source.
   */
  convertOptions?: DoclingConvertOptions;
}

/**
 * Configuration for extraction workers.
 *
 * Backward-compatible: when `workers` is omitted, the top-level fields
 * (endpoint, model, concurrency, etc.) define a single default worker.
 * When `workers` is provided, it defines a pool and the orchestrator
 * assigns documents to workers based on size, capability, and cost.
 */
export interface ExtractionConfig {
  /** OpenAI-compatible endpoint URL (e.g., http://localhost:8020/v1) */
  endpoint: string;
  /** Model name at that endpoint */
  model: string;
  /** Maximum concurrent workers */
  concurrency: number;
  /** Maximum tokens per request */
  maxTokens?: number;
  /** Temperature (0 for deterministic extraction) */
  temperature?: number;
  /**
   * Maximum characters per chunk when splitting large documents.
   * Set based on your model's context window — smaller models (32K tokens)
   * need ~20,000 chars, larger models (200K tokens) can use 100,000+.
   * Default: 100,000 characters.
   */
  maxChunkSize?: number;
  /**
   * Extra parameters merged into the chat completions request body.
   * Use for model-specific options not covered by the standard fields.
   * Example: disable Qwen3 thinking mode via vLLM:
   *   { "chat_template_kwargs": { "enable_thinking": false } }
   */
  extraBodyParams?: Record<string, unknown>;
  /**
   * Worker pool for multi-worker routing.
   * When provided, the orchestrator assigns documents to workers based on
   * document size, required capabilities, and cost (cheapest viable worker).
   * When omitted, all documents use the single worker defined by the
   * top-level endpoint/model/concurrency fields.
   */
  workers?: WorkerConfig[];
  /**
   * Maximum number of documents to extract in a single run.
   * Useful for cost control and testing — extract a small batch first,
   * review quality, then increase. When omitted, all pending documents
   * are extracted.
   */
  maxItems?: number;
  /**
   * Filter extraction to specific source documents by path or filename.
   * When provided, only sources whose path matches one of these values
   * (exact path or filename substring) are processed. Other pending
   * sources are skipped but remain pending for future runs.
   */
  sourceFilter?: string[];
  /**
   * When true and a worker pool is configured, the orchestrator automatically
   * reassigns failed documents to a more capable worker and retries.
   * Requires `workers` to be set with at least 2 workers.
   * Default: false.
   */
  autoReassignFailures?: boolean;
  /**
   * Strategy for splitting large documents into extraction units.
   * - "auto": Use progressive chapter-based splitting for markdown documents
   *   with heading structure, fixed-size chunking for others. (default)
   * - "chapters": Always use chapter-based splitting (falls back to fixed-size
   *   if the document has no headings).
   * - "fixed": Always use fixed-size character chunking (legacy behavior).
   */
  chunkingStrategy?: 'auto' | 'chapters' | 'fixed';
  /**
   * Number of recent chapters whose entity context is carried forward in
   * progressive chapter-based extraction. Higher values give better cross-
   * reference quality but increase prompt size. Default: 6.
   */
  progressiveContextWindow?: number;
  /**
   * Consume the completion as a Server-Sent Events stream on the built-in
   * openai-compat provider. Applies to that provider only — workers using
   * `llmProvider: "anthropic"` ignore it. Resolves to `true` when unset;
   * streaming keeps long generations alive because response headers arrive
   * immediately and the transport idle timer resets on every token, so a
   * dense chunk that generates for minutes does not outrun the client's
   * idle timeout. Opt out (`false`) only for pathological servers or proxies
   * that do not stream SSE correctly.
   */
  stream?: boolean;
  /**
   * Total wall-clock cap, in milliseconds, on a single completion request to
   * the built-in openai-compat provider. Applies to that provider only —
   * workers using `llmProvider: "anthropic"` ignore it. Default `undefined`
   * imposes no extra cap. This can only *shorten* a request: it does not extend
   * the ~300s non-streaming time-to-first-byte limit (streaming is the
   * mechanism for long generations), so it is a defense-in-depth ceiling on a
   * genuinely stuck request, not a way to allow longer ones. When set it must
   * be a positive integer number of milliseconds.
   */
  requestTimeoutMs?: number;
}

/** Capability tags for worker routing decisions */
export type WorkerCapability =
  | 'structured-extraction'   // Tables, spec sheets, structured data
  | 'prose-extraction'        // Narrative text, troubleshooting guides
  | 'reasoning'               // Judgment-heavy tasks, consolidation
  | 'large-context';          // Documents requiring >32K token context

/** Configuration for a single named worker in the worker pool */
export interface WorkerConfig {
  /** Unique name for this worker (e.g., "local-qwen", "cloud-haiku") */
  name: string;
  /** OpenAI-compatible endpoint URL */
  endpoint: string;
  /** Model name at that endpoint */
  model: string;
  /** Maximum context window in tokens (used for document assignment) */
  contextWindow: number;
  /** Maximum characters per chunk (derived from contextWindow minus prompt overhead) */
  maxChunkSize: number;
  /** Maximum output tokens per request */
  maxOutputTokens: number;
  /** Cost per 1M input tokens in USD (0 for local models) */
  costPerMillionInputTokens: number;
  /** Cost per 1M output tokens in USD (0 for local models) */
  costPerMillionOutputTokens: number;
  /** Temperature (default 0) */
  temperature?: number;
  /** Extra body parameters (e.g., disable thinking mode) */
  extraBodyParams?: Record<string, unknown>;
  /** Maximum concurrent requests this worker can handle */
  concurrency: number;
  /** Capability tags — orchestrator uses these for assignment decisions */
  capabilities: WorkerCapability[];
  /** API key for authenticated endpoints */
  apiKey?: string;
  /**
   * LLM provider name. Omit for built-in OpenAI-compatible provider.
   * Set to a registered provider name (e.g., "anthropic") to use
   * a vendor-specific provider package.
   */
  llmProvider?: string;
  /**
   * Consume the completion as a Server-Sent Events stream on the built-in
   * openai-compat provider. Applies to that provider only — a worker with
   * `llmProvider: "anthropic"` ignores it. Resolves to `true` when unset;
   * streaming keeps long generations alive because response headers arrive
   * immediately and the transport idle timer resets on every token, so a
   * dense chunk that generates for minutes does not outrun the client's
   * idle timeout. Opt out (`false`) only for pathological servers or proxies
   * that do not stream SSE correctly.
   */
  stream?: boolean;
  /**
   * Total wall-clock cap, in milliseconds, on a single completion request to
   * the built-in openai-compat provider. Applies to that provider only — a
   * worker with `llmProvider: "anthropic"` ignores it. Default `undefined`
   * imposes no extra cap. This can only *shorten* a request: it does not extend
   * the ~300s non-streaming time-to-first-byte limit (streaming is the
   * mechanism for long generations), so it is a defense-in-depth ceiling on a
   * genuinely stuck request, not a way to allow longer ones. When set it must
   * be a positive integer number of milliseconds.
   */
  requestTimeoutMs?: number;
}

/** Configuration for the consolidation Reasoning Agent */
export interface ConsolidationConfig {
  /** OpenAI-compatible endpoint URL (could be cloud or local) */
  endpoint: string;
  /** Model name */
  model: string;
  /** API key (for cloud endpoints) */
  apiKey?: string;
  /** Maximum tokens for consolidation responses */
  maxTokens?: number;
}

/** Configuration for the import phase */
export interface ImportConfig {
  /** Deep-memory storage provider configuration */
  storage: StorageProviderConfig;
  /** Deep-memory embedding provider configuration (optional, for re-embedding on import) */
  embedding?: EmbeddingProviderConfig;
}

/** Storage provider configuration (provider-specific) */
export interface StorageProviderConfig {
  type: string;
  [key: string]: unknown;
}

/** Embedding provider configuration (provider-specific) */
export interface EmbeddingProviderConfig {
  type: string;
  [key: string]: unknown;
}

/** Configuration for a single embeddings worker in a multi-worker pool */
export interface EmbeddingsWorkerConfig {
  /** Unique name (e.g., "local-gpu", "openai-api") */
  name: string;
  /** OpenAI-compatible endpoint URL */
  endpoint: string;
  /** Model name at that endpoint */
  model: string;
  /** API key (for cloud endpoints) */
  apiKey?: string;
  /** Entities per batch (default 50, max 200) */
  batchSize?: number;
  /** Max concurrent batch requests for this worker (default 1) */
  concurrency?: number;
  /** Milliseconds delay between batches (default 0) */
  delayBetweenBatchesMs?: number;
  /** Retries per batch (default 3) */
  maxRetries?: number;
  /** Cost per 1M tokens in USD (for estimation/tracking, default 0) */
  costPerMillionTokens?: number;
  /** Relative throughput weight for entity range allocation (default 1). Higher = more entities. */
  weight?: number;
}

/** Configuration for the embeddings phase */
export interface EmbeddingsConfig {
  /** OpenAI-compatible endpoint URL for the embeddings model */
  endpoint: string;
  /** Embeddings model name */
  model: string;
  /** API key (for cloud endpoints) */
  apiKey?: string;
  /** Output dimensions (if model supports configurable dimensions) */
  dimensions?: number;
  /** Entities per batch (default 50, max 200) */
  batchSize?: number;
  /** Milliseconds to wait between batches for rate limiting (default 0) */
  delayBetweenBatchesMs?: number;
  /** Retries per batch on embedding API failure with exponential backoff (default 3) */
  maxRetries?: number;
  /** Abort after this many cumulative failures. Omit for no limit. */
  errorThresholdToAbort?: number;
  /** Cost per 1M tokens in USD (for estimation) */
  costPerMillionTokens?: number;
  /** Average tokens per entity (for estimation, default 25) */
  averageTokensPerEntity?: number;
  /**
   * Worker pool for multi-endpoint embedding.
   * When provided, entities are split across workers by range.
   * Top-level endpoint/model fields are used as defaults when workers is absent.
   */
  workers?: EmbeddingsWorkerConfig[];
}
