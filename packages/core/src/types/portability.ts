// Portability types — export/import of memory repositories

import type { GovernanceMode } from './vocabulary.js';
import type { MemoryVocabulary } from './vocabulary.js';
import type { StoredEntity } from './entities.js';
import type { StoredRelationship } from './relationships.js';
import type { ProvenanceContext } from './provenance.js';
import type { RepositoryConfig } from './repositories.js';

/** Manifest describing an exported repository archive */
export interface ExportManifest {
  /** Archive format version — for forward compatibility */
  formatVersion: '1.0.0';
  /** @utaba/deep-memory version that created this export */
  libraryVersion: string;
  /** ISO 8601 timestamp */
  exportedAt: string;
  exportedBy: ProvenanceContext;

  repository: {
    repositoryId: string;
    type?: string;
    label: string;
    description?: string;
    vocabularyVersion: string;
    governanceMode: GovernanceMode;
  };

  statistics: {
    entityCount: number;
    relationshipCount: number;
    entityTypeBreakdown: Record<string, number>;
    relationshipTypeBreakdown: Record<string, number>;
  };

  /** Embedding metadata — critical for portability */
  embedding?: {
    modelId: string;
    dimensions: number;
    note: string;
  };

  /** Legal and copyright metadata — set by the publisher of the archive */
  legal?: ExportLegalMetadata;

  /** Indexing pipeline metadata — present when archive was produced by the indexer */
  pipeline?: ExportPipelineMetadata;
}

/** Legal and copyright metadata for an export archive */
export interface ExportLegalMetadata {
  /** Copyright holder (e.g. "© 2026 Caterpillar Inc.") */
  copyright: string;
  /** SPDX license identifier or custom license name (e.g. "Apache-2.0", "LicenseRef-Proprietary") */
  license?: string;
  /** Full license text or URL pointing to license terms */
  licenseUrl?: string;
  /** Human-readable usage terms or restrictions summary */
  terms?: string;
  /** Organization that published this archive */
  publisher?: string;
  /** Contact for licensing questions (e.g. email address) */
  contact?: string;
}

/** Pipeline metadata describing how the data was produced */
export interface ExportPipelineMetadata {
  /** LLM model used for extraction (e.g. "claude-sonnet-4-20250514") */
  extractionModel: string;
  /** LLM provider name (e.g. "anthropic", "vllm") */
  extractionProvider?: string;
  /** Embeddings model used (e.g. "Qwen/Qwen3-Embedding-8B") */
  embeddingsModel?: string;
  /** Number of source documents processed */
  sourceCount: number;
  /** Source document names or paths */
  sources: string[];
  /** Extraction parameters used */
  parameters?: {
    chunkSize?: number;
    chunkOverlap?: number;
    maxOutputTokens?: number;
  };
}

/** A complete repository export archive */
export interface ExportArchive {
  manifest: ExportManifest;
  vocabulary: MemoryVocabulary;
  entities: StoredEntity[];
  relationships: StoredRelationship[];
}

/** A chunk of exported data (for streaming) */
export interface ExportChunk {
  type: 'entities' | 'relationships';
  data: StoredEntity[] | StoredRelationship[];
  sequence: number;
  isLast: boolean;
}

/** Items yielded by the streaming export */
export type ExportStreamItem =
  | { type: 'manifest'; data: ExportManifest }
  | { type: 'vocabulary'; data: MemoryVocabulary }
  | { type: 'entities'; data: StoredEntity[]; sequence: number; isLast: boolean }
  | { type: 'relationships'; data: StoredRelationship[]; sequence: number; isLast: boolean };

/** Options for exporting a repository */
export interface ExportOptions {
  /** Legal/copyright metadata to embed in the export manifest */
  legal?: ExportLegalMetadata;
}

/** Options for importing a repository archive */
export interface ImportOptions {
  /** How to handle the target repository */
  target:
    | { mode: 'create'; repositoryId: string; config: RepositoryConfig }
    | { mode: 'merge'; repositoryId: string };

  /** How to handle vocabulary differences (only for "merge" mode) */
  vocabularyConflict?: 'reject' | 'extend' | 'prompt';

  /** How to handle entity ID collisions (only for "merge" mode) */
  entityConflict?: 'skip' | 'overwrite' | 'rename';

  /** Whether to re-generate embeddings using the current EmbeddingProvider */
  reEmbed?: boolean;

  /**
   * Storage-provider bulk options forwarded to `StorageProvider.importBulk()`
   * for every chunk. Use this to tune adaptive concurrency or wire an
   * `onAdjust` callback for operator-visible logging.
   *
   * Note: `skipExistenceCheck` is set automatically based on import mode and
   * cannot be overridden here.
   */
  bulk?: Omit<BulkImportOptions, 'skipExistenceCheck'>;

  /**
   * Caller-supplied abort signal. Honoured at chunk boundaries — the chunk
   * currently in flight completes before the abort is observed, and any
   * entities/relationships already written are left in place. The repository
   * row and vocabulary (in `create` mode) are also left in place; the caller
   * is expected to delete the partial repository if it is no longer wanted.
   *
   * On abort, `import:failed` is emitted on the global event bus and
   * `OperationAbortedError` is thrown from the import call.
   */
  signal?: AbortSignal;
}

/** A chunk of data for bulk import */
export interface ImportChunk {
  entities?: StoredEntity[];
  relationships?: StoredRelationship[];
}

/** Options for bulk import operations at the storage provider level */
export interface BulkImportOptions {
  /**
   * Skip existence checks before inserting.
   * When true, the provider assumes items do not already exist and uses direct
   * inserts instead of upserts. This is safe for freshly created repositories
   * and significantly faster for providers that must otherwise check each item.
   * Default: false (upsert behavior — check existence, then create or update).
   */
  skipExistenceCheck?: boolean;

  /**
   * Adaptive concurrency configuration for providers that throttle under load
   * (e.g. CosmosDB on autoscale tiers). Providers that do not throttle may
   * ignore this. The runner starts at `start` parallel writes, halves on any
   * observed throttle, and ramps back up after `increaseAfter` consecutive
   * throttle-free completions. All fields are optional with provider-specific
   * defaults.
   */
  adaptiveConcurrency?: AdaptiveConcurrencyOptions;

  /**
   * Opaque container for cross-call adaptive-concurrency state. When the same
   * handle object is passed to multiple `importBulk` calls during a single
   * import operation, providers that support adaptive concurrency reuse their
   * controller across calls — preserving the learned concurrency level,
   * success streak, cooldown, and throttle history — instead of resetting on
   * every chunk. RepositoryImporter creates a fresh handle per import and
   * threads it through automatically; direct callers of `importBulk` only
   * need to set this when they invoke the method multiple times for one
   * logical import. Providers that do not throttle ignore the field.
   */
  adaptiveConcurrencyHandle?: AdaptiveConcurrencyHandle;
}

/**
 * Opaque marker for cross-call adaptive-concurrency state. Storage providers
 * that support adaptive concurrency attach their own private fields (e.g. the
 * controller instance) to this object. Callers should treat it as opaque —
 * construct a fresh empty `{}` per import and pass the same reference to every
 * `importBulk` call belonging to that import.
 */
export interface AdaptiveConcurrencyHandle {
  // Intentionally empty — providers attach their private state.
}

/** Reason the adaptive runner adjusted its concurrency level. */
export type AdaptiveConcurrencyAdjustReason = 'start' | 'throttle' | 'ramp-up';

/** Configuration for the adaptive concurrency runner used by bulk imports. */
export interface AdaptiveConcurrencyOptions {
  /** Floor concurrency. Default: 1. */
  min?: number;
  /** Initial concurrency at the start of the import. Default: 5. */
  start?: number;
  /** Ceiling concurrency. Default: 32. */
  max?: number;
  /**
   * Number of consecutive throttle-free task completions required before
   * concurrency is incremented by 1. Default: 50.
   */
  increaseAfter?: number;
  /**
   * Cooldown delay (ms) before any further task is dispatched after a throttle
   * is observed. Default: 1000.
   */
  cooldownMs?: number;
  /**
   * Minimum time (ms) that must elapse after a throttle before concurrency can
   * be incremented again. The dispatch cooldown (`cooldownMs`) only pauses new
   * task dispatch; this separately freezes the ramp-up streak so the controller
   * does not immediately climb back to a level that just proved unsustainable.
   * Default: 5000.
   */
  rampUpCooldownMs?: number;
  /**
   * Circuit breaker — abort the import after this many consecutive throttled
   * tasks while the controller is already at `min` concurrency. The streak is
   * reset by any throttle-free task completion. Set to a very large number to
   * disable. Default: 10.
   *
   * Rationale: at min concurrency the runner has already done everything it
   * can to relieve pressure. If the cluster is still throttling every task at
   * that level, more attempts will not help and the operator should be told
   * loudly rather than letting the import grind on for hours.
   */
  maxConsecutiveThrottlesAtMin?: number;
  /**
   * Multiplier applied to {@link increaseAfter} when ramping back up to a
   * level that has been throttled before (the "soft ceiling"). The controller
   * remembers the highest concurrency at which a throttle was observed and
   * requires `increaseAfter * throttleCeilingMultiplier` consecutive successes
   * to re-attain (or exceed) that level. Once the level has been held without
   * further throttling, the constraint is dropped — a future throttle will
   * establish a new ceiling. Default: 3.
   *
   * Rationale: the previous behaviour ramped back up to the throttled level
   * with the same number of successes every cycle, producing a
   * ramp-throttle-ramp-throttle oscillation on RU-constrained tiers. Making
   * the re-approach cost more breaks the cycle without permanently capping
   * concurrency below the cluster's real capacity.
   */
  throttleCeilingMultiplier?: number;
  /**
   * Called whenever the runner changes its concurrency level. Use this for
   * operator-visible logging. The callback is fire-and-forget; throwing has no
   * effect on the import.
   */
  onAdjust?: (event: AdaptiveConcurrencyAdjustEvent) => void;
}

/** Event payload for {@link AdaptiveConcurrencyOptions.onAdjust}. */
export interface AdaptiveConcurrencyAdjustEvent {
  /** New concurrency level in effect after this adjustment. */
  concurrency: number;
  /** Concurrency level immediately before this adjustment. */
  previousConcurrency: number;
  /** Why the change was made. */
  reason: AdaptiveConcurrencyAdjustReason;
  /** Total tasks completed (success or throttle) at the time of adjustment. */
  tasksCompleted: number;
  /** Total tasks observed to have been throttled at least once. */
  throttledCount: number;
}

/** Progress callback for delete operations */
export type DeleteProgressCallback = (progress: {
  entitiesDeleted: number;
  relationshipsDeleted: number;
  totalEntities: number;
  totalRelationships: number;
}) => void | Promise<void>;

/** Header for streaming import — sent before data chunks */
export interface ImportStreamHeader {
  manifest: ExportManifest;
  vocabulary: MemoryVocabulary;
}

/** Warning generated during import */
export interface ImportWarning {
  code: string;
  message: string;
  id?: string;
  relationshipId?: string;
}

/** Result of an import operation */
export interface ImportResult {
  success: boolean;
  repositoryId: string;
  statistics: {
    entitiesImported: number;
    entitiesSkipped: number;
    relationshipsImported: number;
    relationshipsSkipped: number;
    vocabularyExtensions: number;
  };
  warnings: ImportWarning[];
}
