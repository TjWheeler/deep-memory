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
 *
 * **Deleted repositories.** A repository counts as missing once its record
 * (the marker a delete removes first) is gone, even while a delete that has
 * not finished leaves entities, relationships or a vocabulary behind. Every
 * method that takes a repository id throws `RepositoryNotFoundError` for a
 * missing repository — reads, searches, traversals, the change log, the
 * timeline, export and import included — except `getRepository` (which
 * answers `null`) and `deleteRepository` (which finishes a partial delete;
 * see there). `GraphTraversalProvider.traverse` follows the same rule. The
 * check runs ahead of any outcome for a particular id (repository → id →
 * source → target) and ahead of an empty result, so a caller can tell a
 * deleted repository from an empty one, from a missing id or from a lookup
 * that matched nothing. A call that throws it before writing changes
 * nothing; the windows below are the calls that can throw it, or miss it,
 * after a partial write. The one documented exception to the check is a
 * `getVocabulary` answered from a provider's vocabulary cache (see there);
 * traversals check the repository whatever the cache holds.
 *
 * CosmosDB has no transaction across Gremlin requests, so a delete of the
 * repository that races a multi-request call opens these windows:
 * - a batch delete of more than 100 ids runs in chunks; the chunks deleted
 *   before a later chunk finds the repository gone stay deleted;
 * - `deleteRelationship`, `deleteRelationships` and
 *   `deleteRelationshipsByType` read the repository marker, then drop in a
 *   second request, so a delete landing in between lets the drop remove
 *   edges (which the repository delete removes anyway) and report them
 *   instead of throwing;
 * - `importBulk` checks the repository before each chunk but not per row,
 *   so a delete that starts mid-chunk can let that chunk's remaining rows
 *   land (a later `deleteRepository` removes them); a repository already
 *   gone before the call gets nothing written;
 * - `exportAll` checks once, before the first page, so a delete that starts
 *   mid-export is not detected (the call only reads);
 * - reads that check the repository with a separate request issued alongside
 *   the data read (`getRelationship`, `getVocabularyChangeLog`,
 *   `findEntities`, and traversals on a warm vocabulary cache) can, when a
 *   delete lands between the two requests, answer with rows the delete has
 *   not drained yet, or `null` / empty, instead of throwing (the call only
 *   reads).
 *
 * `deleteEntitiesByType` and `deleteRelationshipsByType` run in batches on
 * Neo4j and CosmosDB, one transaction or request per batch, so a large type
 * does not outlast a server timeout. When a later batch finds the repository
 * missing (`RepositoryNotFoundError`) or fails, the batches before it stay
 * deleted. Resending the call deletes what is left.
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
   *
   * A repository whose record is gone but whose data a delete did not finish
   * removing is not missing here: the call finishes the delete and reports
   * what it removed.
   *
   * @throws RepositoryNotFoundError when there was nothing at all to delete:
   *   no record and no data. The repository is already gone, so a caller
   *   retrying a delete can treat this as done (it is also the answer for an
   *   id that never existed).
   */
  deleteRepository(
    repositoryId: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }>;
  /**
   * Delete all entities and relationships in a repository without deleting the repository itself.
   *
   * @throws RepositoryNotFoundError when the repository is missing.
   */
  deleteAllContents(repositoryId: string, onProgress?: DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }>;
  /**
   * Entity and relationship counts, per type, and the vocabulary version.
   *
   * @throws RepositoryNotFoundError when the repository is missing, rather
   *   than reporting zero counts.
   */
  getRepositoryStats(repositoryId: string): Promise<RepositoryStats>;

  // ─── Vocabulary ────────────────────────────────────────────────────

  /**
   * Read the repository's vocabulary. Pass `{ fresh: true }` to bypass any
   * provider-side cache; providers without a cache ignore `options`.
   *
   * A provider with a cache drops a repository's entry whenever one of its
   * calls finds that repository missing, and when it deletes the repository
   * itself. A cached read within the cache's lifetime is not checked against
   * the store, so it may still return the vocabulary of a repository that
   * another process deleted; `{ fresh: true }` always reflects the store.
   *
   * @throws RepositoryNotFoundError when the repository is missing (on every
   *   read that goes to the store), never an empty vocabulary in its place.
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
   *
   * When `changeRecord` is given, the provider persists it in the same
   * statement or transaction as the compare-and-set write, so the vocabulary
   * change and its audit record commit together or not at all. CosmosDB is
   * the exception: it writes both in one Gremlin traversal, which is not a
   * transaction, so a failure after the vocabulary write leaves the new
   * vocabulary stored without its record, and the error propagates. A write that
   * fails its compare-and-set (`VocabularyVersionConflictError`) or finds the
   * repository missing (`RepositoryNotFoundError`) writes no record. Once the
   * call returns, `getVocabularyChangeLog` includes the record. There is no
   * separate append: a record written apart from the vocabulary could
   * describe a change that never landed, or miss one that did.
   */
  saveVocabulary(
    repositoryId: string,
    vocabulary: MemoryVocabulary,
    expectedVersion: string,
    changeRecord?: VocabularyChangeRecord,
  ): Promise<void>;
  /**
   * Page the repository's vocabulary change log, newest first: by
   * `proposedAt` descending, then by `changeId` descending between records
   * with the same `proposedAt`, so paging is stable. Records are written only by `saveVocabulary`, together
   * with the vocabulary change they describe. `limit` defaults to 10 and
   * `offset` to 0; `total` counts every record in the repository.
   *
   * @throws RepositoryNotFoundError when the repository is missing.
   */
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
   * @throws RepositoryNotFoundError when the repository is missing, ahead of
   *   the entity check: an entity a delete has not yet removed is not updated.
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
  /**
   * Delete one entity and its associated relationships.
   *
   * @throws RepositoryNotFoundError when the repository is missing, ahead of
   *   any outcome for the id: an entity a delete has not yet removed is not
   *   deleted here.
   * @throws EntityNotFoundError when the repository exists and no entity has
   *   the id, including an id an earlier call already deleted.
   */
  deleteEntity(repositoryId: string, entityId: string): Promise<void>;
  /**
   * Delete multiple entities and their associated relationships in a single
   * batch operation. Ids with no entity are reported in `notFound`.
   *
   * @throws RepositoryNotFoundError when the repository is missing, even for
   *   an empty `ids` list; no id is reported as not found, and nothing is
   *   deleted (on CosmosDB, with more than 100 ids, chunks deleted before the
   *   repository went missing stay deleted).
   */
  deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }>;
  /**
   * Delete all entities of a given type and their associated relationships.
   *
   * `deletedEntities` is the exact number of entities removed, and `0` when
   * none of the type is left. On CosmosDB it is never more than were removed,
   * but may be fewer when a transient retry re-runs a partly applied drop.
   * The vocabulary engine relies on it: resending the deletion of a type the
   * vocabulary no longer declares re-runs this call, and answers `approved`
   * only when it removed something.
   *
   * `deletedRelationships` may be `undefined` when the provider does not count
   * cascaded edges. The CosmosDB provider skips the edge-count fan-out
   * (a `bothE()` walk across every partition the type touches) because the
   * count itself is rarely consumed — the vocabulary cascade does not read it.
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
   * generated the id (see `RelationshipCreateOptions`). CosmosDB, where
   * vertices and edges share one id space per partition, also refuses an id
   * equal to any other document id in the repository's partition (an entity,
   * the repository marker or a vocabulary vertex) with
   * `DuplicateRelationshipError`.
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
  /**
   * Delete one relationship.
   *
   * @throws RepositoryNotFoundError when the repository is missing, ahead of
   *   any outcome for the id: a relationship a delete has not yet removed is
   *   not deleted here.
   * @throws RelationshipNotFoundError when the repository exists and no
   *   relationship has the id, including an id an earlier call already
   *   deleted.
   */
  deleteRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<void>;
  /**
   * Delete multiple relationships in a single batch operation. Ids with no
   * relationship are reported in `notFound`.
   *
   * @throws RepositoryNotFoundError when the repository is missing, even for
   *   an empty `ids` list; no id is reported as not found, and nothing is
   *   deleted (on CosmosDB, with more than 100 ids, chunks deleted before the
   *   repository went missing stay deleted).
   */
  deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }>;
  /**
   * Delete all relationships of a given type.
   *
   * `deletedRelationships` is the exact number removed, and `0` when none of
   * the type is left. On CosmosDB it is never more than were removed, but may
   * be fewer when a transient retry re-runs a partly applied drop. The
   * vocabulary engine reads it the same way as `deleteEntitiesByType`'s
   * `deletedEntities`.
   */
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
