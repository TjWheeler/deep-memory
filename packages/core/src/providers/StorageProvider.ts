// StorageProvider — the primary provider interface for graph persistence

import type {
  StoredEntity,
  StoredEntityUpdate,
} from '../types/entities.js';
import type {
  StoredRelationship,
  RelationshipQueryOptions,
} from '../types/relationships.js';
import type { MemoryVocabulary, VocabularyChangeRecord } from '../types/vocabulary.js';
import type {
  StorageRepositoryConfig,
  StoredRepository,
  StoredRepositorySummary,
  RepositoryFilter,
  RepositoryStats,
  RepositoryUpdate,
} from '../types/repositories.js';
import type {
  StorageFindQuery,
  StorageExploreOptions,
  StoragePathOptions,
  StorageTimelineOptions,
  PaginationOptions,
} from '../types/queries.js';
import type {
  PaginatedResult,
  StorageNeighborhood,
  StoragePathResult,
  StorageTimelineResult,
  BulkImportResult,
} from '../types/results.js';
import type { ExportChunk, ImportChunk, BulkImportOptions, DeleteProgressCallback } from '../types/portability.js';

/** Result returned by ensureSchema describing what actions were taken. */
export interface EnsureSchemaResult {
  /** Whether the database was created (only relevant for server-based providers) */
  databaseCreated: boolean;
  /** Whether schema tables/indexes were created */
  schemaCreated: boolean;
  /** Whether the schema was already up to date (no changes needed) */
  alreadyUpToDate: boolean;
  /** Schema version after the operation */
  schemaVersion: number;
}

/**
 * Internal entity-read options shared by `getEntity`, `getEntityBySlug`,
 * `getEntities`, and `findEntities`.
 *
 * `loadEmbeddings` defaults to `false`. When `false`, providers must not ship
 * the stored embedding over the wire — this is the AI-agent hot-path
 * contract. When `true`, providers populate `StoredEntity.embedding` from the
 * underlying store. The only legitimate caller is the vector-search path in
 * `SearchOrchestrator.searchByConcept`.
 *
 * Providers that do not separate light/full reads (e.g. the in-memory
 * provider, which always carries the full entity) may ignore this option.
 */
export interface EntityReadOptions {
  loadEmbeddings?: boolean;
}

/**
 * Vocabulary-read options for `getVocabulary`.
 *
 * `fresh` bypasses any provider-side cache and reads the stored vocabulary
 * directly. Callers that are about to modify the vocabulary use it so the
 * `expectedVersion` they pass to `saveVocabulary` reflects what is actually
 * stored. Providers without a cache ignore it.
 */
export interface VocabularyReadOptions {
  fresh?: boolean;
}

/**
 * Options for `createRelationship`.
 *
 * `idMinted` is `true` when the engine generated `relationship.id` itself
 * (`generateRelationshipId`, a random UUID) rather than taking it from the
 * caller. A minted id cannot collide with a stored one in practice, so a
 * provider may skip its check that the id is unused in the repository when
 * that check is expensive. A provider that enforces id uniqueness for free
 * (a primary key) keeps enforcing it. Defaults to `false`: an id the caller
 * supplied is always checked.
 *
 * `idMinted` is an engine-only assertion. Only the engine's relationship
 * create path, at the point where it generated the id, may set it. Setting it
 * for an id the engine did not generate removes the reused-id guarantee on
 * providers that skip the check: Neo4j, for example, then stores a second
 * relationship with the same id in the repository.
 */
export interface RelationshipCreateOptions {
  idMinted?: boolean;
}

/**
 * StorageProvider — the primary persistence interface.
 *
 * Must be supplied when creating a DeepMemory instance. Handles all
 * persistence of entities, relationships, vocabulary, and repositories.
 *
 * Works with "Stored" types (full internal representations including
 * provenance and embeddings). The core engine maps these to public types
 * based on the requested detail level.
 */
export interface StorageProvider {
  // ─── Lifecycle ─────────────────────────────────────────────────────

  /** Optional initialization (e.g., database connection) */
  initialize?(): Promise<void>;

  /** Optional cleanup (e.g., close connections) */
  dispose?(): Promise<void>;

  /** Optional schema creation / migration (e.g., create tables if they don't exist) */
  ensureSchema?(): Promise<EnsureSchemaResult>;

  // ─── Repository ────────────────────────────────────────────────────

  /**
   * Create a repository. Also persists its initial vocabulary —
   * `config.vocabulary` when supplied, otherwise an empty vocabulary — so
   * that every repository has exactly one stored vocabulary from the moment
   * it exists. `saveVocabulary` relies on this: it only ever updates.
   */
  createRepository(config: StorageRepositoryConfig): Promise<StoredRepository>;
  getRepository(repositoryId: string): Promise<StoredRepository | null>;
  listRepositories(
    filter?: RepositoryFilter,
  ): Promise<PaginatedResult<StoredRepositorySummary>>;
  updateRepository(repositoryId: string, updates: RepositoryUpdate): Promise<StoredRepository>;
  /**
   * Delete a repository and everything in it, and report how many entities
   * and relationships the call removed. Providers do not count the
   * repository before deleting it: a whole-repository read ahead of the
   * delete can outlast a server timeout on a large repository and leave it
   * undeletable. `onProgress` reports the running counts as the delete
   * proceeds; providers that delete in one statement may not call it.
   */
  deleteRepository(
    repositoryId: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }>;
  /** Delete all entities and relationships in a repository without deleting the repository itself */
  deleteAllContents(repositoryId: string, onProgress?: DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }>;
  getRepositoryStats(repositoryId: string): Promise<RepositoryStats>;

  // ─── Vocabulary ────────────────────────────────────────────────────

  /**
   * Read the repository's vocabulary. Pass `{ fresh: true }` to bypass any
   * provider-side cache; providers without a cache ignore `options`.
   */
  getVocabulary(repositoryId: string, options?: VocabularyReadOptions): Promise<MemoryVocabulary>;
  /**
   * Replace the repository's vocabulary using compare-and-set on its version.
   *
   * The write lands only when the stored vocabulary's version equals
   * `expectedVersion`; the check and the write must be atomic so two
   * concurrent writers cannot both succeed against the same base version.
   *
   * - Throws `VocabularyVersionConflictError` when the stored version differs
   *   from `expectedVersion`; the stored vocabulary is left unchanged.
   * - Throws `RepositoryNotFoundError` when the repository or its vocabulary
   *   does not exist.
   * - Never creates a vocabulary — `createRepository` seeds it.
   */
  saveVocabulary(
    repositoryId: string,
    vocabulary: MemoryVocabulary,
    expectedVersion: string,
  ): Promise<void>;
  getVocabularyChangeLog(
    repositoryId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<VocabularyChangeRecord>>;

  // ─── Entities ──────────────────────────────────────────────────────
  //
  // An entity's slug is unique within its repository.

  /**
   * Store a new entity.
   *
   * @throws DuplicateEntityError when an entity with `entity.id` already
   *   exists in the repository (and only then).
   * @throws SlugConflictError when a different entity already holds
   *   `entity.slug`; nothing is written.
   */
  createEntity(
    repositoryId: string,
    entity: StoredEntity,
  ): Promise<StoredEntity>;
  getEntity(
    repositoryId: string,
    entityId: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null>;
  /** The entity holding `slug` in the repository (slugs are unique per repository), or `null`. */
  getEntityBySlug(
    repositoryId: string,
    slug: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null>;
  getEntities(
    repositoryId: string,
    entityIds: string[],
    options?: EntityReadOptions,
  ): Promise<Map<string, StoredEntity>>;
  /**
   * Apply `updates` to an existing entity.
   *
   * @throws EntityNotFoundError when no entity has `entityId`.
   * @throws SlugConflictError when `updates.slug` is held by a different
   *   entity; the entity is left unchanged. Its own current slug is never a
   *   conflict.
   */
  updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity>;
  deleteEntity(repositoryId: string, entityId: string): Promise<void>;
  /** Delete multiple entities and their associated relationships in a single batch operation */
  deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }>;
  /**
   * Delete all entities of a given type and their associated relationships.
   *
   * `deletedRelationships` may be `undefined` when the provider does not count
   * cascaded edges. The CosmosDB provider skips the edge-count fan-out
   * (a `bothE()` walk across every partition the type touches) because the
   * count itself is rarely consumed — vocabulary cascade-delete discards it.
   * SQL Server and in-memory providers continue to return the exact number.
   */
  deleteEntitiesByType(
    repositoryId: string,
    entityType: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }>;
  findEntities(
    repositoryId: string,
    query: StorageFindQuery,
    options?: EntityReadOptions,
  ): Promise<PaginatedResult<StoredEntity>>;

  // ─── Relationships ─────────────────────────────────────────────────

  /**
   * Create a relationship. Its id must be unused in the repository: a
   * provider refuses an id already held by another relationship with
   * `DuplicateRelationshipError`, unless `options.idMinted` says the engine
   * generated the id (see `RelationshipCreateOptions`).
   */
  createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
    options?: RelationshipCreateOptions,
  ): Promise<StoredRelationship>;
  getRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<StoredRelationship | null>;
  getEntityRelationships(
    repositoryId: string,
    entityId: string,
    options?: RelationshipQueryOptions,
  ): Promise<PaginatedResult<StoredRelationship>>;
  deleteRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<void>;
  /** Delete multiple relationships in a single batch operation */
  deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }>;
  /** Delete all relationships of a given type */
  deleteRelationshipsByType(
    repositoryId: string,
    relationshipType: string,
  ): Promise<{ deletedRelationships: number }>;

  // ─── Graph Traversal ───────────────────────────────────────────────

  exploreNeighborhood(
    repositoryId: string,
    entityId: string,
    options: StorageExploreOptions,
  ): Promise<StorageNeighborhood>;
  findPaths(
    repositoryId: string,
    sourceId: string,
    targetId: string,
    options: StoragePathOptions,
  ): Promise<StoragePathResult>;

  // ─── Timeline ──────────────────────────────────────────────────────

  getTimeline(
    repositoryId: string,
    entityId: string,
    options: StorageTimelineOptions,
  ): Promise<StorageTimelineResult>;

  // ─── Bulk Operations (for export/import) ───────────────────────────

  exportAll(repositoryId: string): AsyncIterable<ExportChunk>;
  importBulk(
    repositoryId: string,
    data: ImportChunk[],
    options?: BulkImportOptions,
  ): Promise<BulkImportResult>;
}
