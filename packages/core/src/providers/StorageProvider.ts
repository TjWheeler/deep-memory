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

  createRepository(config: StorageRepositoryConfig): Promise<StoredRepository>;
  getRepository(repositoryId: string): Promise<StoredRepository | null>;
  listRepositories(
    filter?: RepositoryFilter,
  ): Promise<PaginatedResult<StoredRepositorySummary>>;
  updateRepository(repositoryId: string, updates: RepositoryUpdate): Promise<StoredRepository>;
  deleteRepository(repositoryId: string, onProgress?: DeleteProgressCallback): Promise<void>;
  /** Delete all entities and relationships in a repository without deleting the repository itself */
  deleteAllContents(repositoryId: string, onProgress?: DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }>;
  getRepositoryStats(repositoryId: string): Promise<RepositoryStats>;

  // ─── Vocabulary ────────────────────────────────────────────────────

  getVocabulary(repositoryId: string): Promise<MemoryVocabulary>;
  saveVocabulary(
    repositoryId: string,
    vocabulary: MemoryVocabulary,
  ): Promise<void>;
  getVocabularyChangeLog(
    repositoryId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<VocabularyChangeRecord>>;

  // ─── Entities ──────────────────────────────────────────────────────

  createEntity(
    repositoryId: string,
    entity: StoredEntity,
  ): Promise<StoredEntity>;
  getEntity(
    repositoryId: string,
    entityId: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null>;
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

  createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
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
