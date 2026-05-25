// CosmosDbProvider — CosmosDB Gremlin implementation of StorageProvider + GraphTraversalProvider

import type { StorageProvider, EnsureSchemaResult, EntityReadOptions } from '@utaba/deep-memory/providers';
import type { GraphTraversalProvider, GraphTraversalCapabilities } from '@utaba/deep-memory/providers';
import type {
  StoredEntity,
  StoredEntityUpdate,
  StoredRelationship,
  RelationshipQueryOptions,
  MemoryVocabulary,
  VocabularyChangeRecord,
  StorageRepositoryConfig,
  StoredRepository,
  StoredRepositorySummary,
  RepositoryFilter,
  RepositoryStats,
  RepositoryUpdate,
  StorageFindQuery,
  StorageExploreOptions,
  StoragePathOptions,
  StorageTimelineOptions,
  PaginationOptions,
  PaginatedResult,
  StorageNeighborhood,
  StoragePathResult,
  StorageTimelineResult,
  BulkImportResult,
  TraversalSpec,
  TraversalResult,
  QueryMetadata,
  UsageSink,
} from '@utaba/deep-memory/types';
import type { ExportChunk, ImportChunk, BulkImportOptions, DeleteProgressCallback } from '@utaba/deep-memory/types';
import crypto from 'node:crypto';
import { GremlinCompiler, ProviderError, InvalidInputError, isValidUuid, projectEntity, createSafeSink } from '@utaba/deep-memory';
import { CosmosDbConnection, usageScope } from './CosmosDbConnection.js';
import type { UsageAccumulator } from './CosmosDbConnection.js';
import { entityFromGremlin, relationshipFromGremlin } from './mapping.js';
import * as repoQueries from './queries/repository.js';
import * as vocabQueries from './queries/vocabulary.js';
import * as entityQueries from './queries/entity.js';
import * as relQueries from './queries/relationship.js';
import * as traversalQueries from './queries/traversal.js';
import * as timelineQueries from './queries/timeline.js';
import * as bulkQueries from './queries/bulk.js';

/** Configuration for CosmosDbProvider. */
export interface CosmosDbProviderConfig {
  /** Gremlin WebSocket endpoint (e.g. ws://host.docker.internal:8901/) */
  endpoint: string;
  /** CosmosDB REST endpoint for database/container provisioning (e.g. https://host.docker.internal:8081/) — derived from Gremlin endpoint if omitted */
  restEndpoint?: string;
  /** CosmosDB primary key */
  key: string;
  /** Database name */
  database: string;
  /** Container (graph) name */
  container: string;
  /** Partition key path (default: /repositoryId) */
  partitionKey?: string;
  /** Max retries for transient errors (default: 3) */
  maxRetries?: number;
  /** Default query timeout in ms (default: 30000) */
  defaultTimeoutMs?: number;
  /** Whether to reject unauthorized TLS certs — set false for emulator (default: true) */
  rejectUnauthorized?: boolean;
  /**
   * Optional usage sink. When provided, the provider emits one
   * {@link OperationUsage} record per public method call with the aggregated
   * CosmosDB request charge (RU). Never exposed to AI agents — the MCP server
   * deliberately does not plumb this sink through.
   */
  reportUsage?: UsageSink;
}

const PROVIDER_NAME = 'cosmosdb';
const SCHEMA_VERSION = 1;
const META_VERTEX_ID = '_meta:schema';

/**
 * Vocabulary TTL for the per-process cache. Vocabulary changes are rare
 * (governance-gated writes); a 60 s window bounds cross-process staleness
 * acceptably while eliminating the one extra round-trip on every traversal.
 */
const VOCABULARY_CACHE_TTL_MS = 60_000;

/**
 * CosmosDB Gremlin storage provider for deep-memory.
 * Implements both StorageProvider (full CRUD) and GraphTraversalProvider (native Gremlin traversals).
 */
export class CosmosDbProvider implements StorageProvider, GraphTraversalProvider {
  private readonly conn: CosmosDbConnection;
  private readonly config: CosmosDbProviderConfig;
  private readonly compiler = new GremlinCompiler();
  private readonly reportUsage: UsageSink | undefined;
  /**
   * Per-process vocabulary cache, keyed by repositoryId. Read lazily by
   * `traverseImpl` via `getVocabularyCached`; invalidated on `saveVocabulary`.
   * Each provider instance owns its own cache so isolated test providers do
   * not share state.
   */
  private readonly vocabularyCache = new Map<string, { vocab: MemoryVocabulary; expiresAt: number }>();

  constructor(config: CosmosDbProviderConfig) {
    this.config = config;
    this.reportUsage = createSafeSink(config.reportUsage);
    this.conn = new CosmosDbConnection({
      endpoint: config.endpoint,
      key: config.key,
      database: config.database,
      container: config.container,
      maxRetries: config.maxRetries,
      defaultTimeoutMs: config.defaultTimeoutMs,
      rejectUnauthorized: config.rejectUnauthorized,
    });
  }

  /**
   * Run the given operation inside an async-local usage scope. While the
   * operation runs, every `conn.submit()` call accumulates its request charge
   * into a shared accumulator. When the operation completes (success or
   * failure), a single {@link OperationUsage} record is emitted to the sink.
   *
   * Nested public-method calls (e.g. `traverse` internally calls
   * `getVocabulary`) are detected: the inner call joins the outer scope
   * instead of starting a new one, so one user-visible operation produces
   * exactly one usage record covering all its internal round-trips.
   *
   * If no sink is configured, this is a zero-overhead pass-through.
   */
  private async track<T>(
    operation: string,
    repositoryId: string | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (!this.reportUsage) return fn();
    // Already inside a parent scope — join it rather than emitting a
    // separate record. The outermost call owns emission.
    if (usageScope.getStore()) return fn();
    const acc: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
    try {
      return await usageScope.run(acc, fn);
    } finally {
      if (acc.calls > 0) {
        this.reportUsage({
          provider: PROVIDER_NAME,
          operation,
          unit: 'RU',
          value: acc.ru,
          ...(repositoryId ? { repositoryId } : {}),
          timestamp: new Date(),
          details: { calls: acc.calls, retries: acc.retries },
        });
      }
    }
  }

  /**
   * Reject any repositoryId that is not a valid v4 UUID.
   *
   * Every partition-scoped query filters on repositoryId. Since repositoryId is
   * the CosmosDB partition key, a predicate with a different value would target
   * a different partition. Strict format validation at the provider boundary
   * prevents injection (e.g. strings containing quotes or Gremlin syntax) from
   * ever reaching query construction.
   */
  private assertValidRepositoryId(repositoryId: string): void {
    if (!isValidUuid(repositoryId)) {
      throw new InvalidInputError(
        'repositoryId',
        `repositoryId must be a valid v4 UUID; got '${repositoryId}'`,
      );
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    await this.conn.connect();
  }

  async dispose(): Promise<void> {
    await this.conn.close();
  }

  async ensureSchema(): Promise<EnsureSchemaResult> {
    return this.track('ensureSchema', undefined, () => this.ensureSchemaImpl());
  }

  private async ensureSchemaImpl(): Promise<EnsureSchemaResult> {
    const restBase = this.getRestEndpoint();
    const partitionKey = this.config.partitionKey ?? '/repositoryId';
    let databaseCreated = false;
    let schemaCreated = false;

    try {
      // 1. Create database if not exists
      const dbCreated = await cosmosRestPut(
        restBase,
        this.config.key,
        'dbs',
        '',
        'dbs',
        { id: this.config.database },
        this.config.rejectUnauthorized ?? true,
      );
      databaseCreated = dbCreated;

      // 2. Create Gremlin graph container if not exists
      const containerCreated = await cosmosRestPut(
        restBase,
        this.config.key,
        `dbs/${this.config.database}/colls`,
        `dbs/${this.config.database}`,
        'colls',
        {
          id: this.config.container,
          partitionKey: { paths: [partitionKey], kind: 'Hash' },
        },
        this.config.rejectUnauthorized ?? true,
      );
      schemaCreated = containerCreated;

      // 3. Reconnect Gremlin client (it may have failed before db/container existed)
      await this.conn.close();
      await this.conn.connect();

      // 4. Write schema version meta vertex
      const existing = await this.conn.submit(
        "g.V().hasId(metaId).hasLabel('_meta').valueMap(true)",
        { metaId: META_VERTEX_ID },
      );

      if (existing.items.length > 0) {
        const props = existing.items[0] as Record<string, unknown>;
        const version = Number(unwrapGremlinValue(props['schemaVersion']) ?? 0);
        if (version >= SCHEMA_VERSION && !databaseCreated && !schemaCreated) {
          return {
            databaseCreated: false,
            schemaCreated: false,
            alreadyUpToDate: true,
            schemaVersion: SCHEMA_VERSION,
          };
        }
        await this.conn.submit(
          "g.V().hasId(metaId).hasLabel('_meta').property('schemaVersion', ver)",
          { metaId: META_VERTEX_ID, ver: SCHEMA_VERSION },
        );
      } else {
        await this.conn.submit(
          "g.addV('_meta').property('id', metaId).property('repositoryId', pk).property('schemaVersion', ver)",
          { metaId: META_VERTEX_ID, pk: '_system', ver: SCHEMA_VERSION },
        );
        schemaCreated = true;
      }

      return {
        databaseCreated,
        schemaCreated,
        alreadyUpToDate: !databaseCreated && !schemaCreated,
        schemaVersion: SCHEMA_VERSION,
      };
    } catch (err: unknown) {
      throw new ProviderError(
        `Failed to ensure CosmosDB schema: ${err instanceof Error ? err.message : String(err)}`,
        'Verify the CosmosDB REST endpoint is accessible and the Gremlin endpoint is reachable.',
      );
    }
  }

  /** Derive the REST endpoint from config — either explicit or from the Gremlin endpoint host. */
  private getRestEndpoint(): string {
    if (this.config.restEndpoint) return this.config.restEndpoint.replace(/\/+$/, '');
    // Derive from Gremlin endpoint: ws(s)://host:port/ → https://host:8081
    const url = new URL(this.config.endpoint);
    return `https://${url.hostname}:8081`;
  }

  // ─── Repository ────────────────────────────────────────────────────

  async createRepository(config: StorageRepositoryConfig): Promise<StoredRepository> {
    this.assertValidRepositoryId(config.repositoryId);
    return this.track('createRepository', config.repositoryId, () =>
      repoQueries.createRepository(this.conn, config),
    );
  }

  async getRepository(repositoryId: string): Promise<StoredRepository | null> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getRepository', repositoryId, () =>
      repoQueries.getRepository(this.conn, repositoryId),
    );
  }

  async listRepositories(filter?: RepositoryFilter): Promise<PaginatedResult<StoredRepositorySummary>> {
    return this.track('listRepositories', undefined, () =>
      repoQueries.listRepositories(this.conn, filter),
    );
  }

  async updateRepository(repositoryId: string, updates: RepositoryUpdate): Promise<StoredRepository> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('updateRepository', repositoryId, () =>
      repoQueries.updateRepository(this.conn, repositoryId, updates),
    );
  }

  async deleteRepository(repositoryId: string, onProgress?: DeleteProgressCallback): Promise<void> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteRepository', repositoryId, () =>
      repoQueries.deleteRepository(this.conn, repositoryId, onProgress),
    );
  }

  async deleteAllContents(repositoryId: string, onProgress?: DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteAllContents', repositoryId, () =>
      repoQueries.deleteAllContents(this.conn, repositoryId, onProgress),
    );
  }

  async getRepositoryStats(repositoryId: string): Promise<RepositoryStats> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getRepositoryStats', repositoryId, () =>
      repoQueries.getRepositoryStats(this.conn, repositoryId),
    );
  }

  // ─── Vocabulary ────────────────────────────────────────────────────

  async getVocabulary(repositoryId: string): Promise<MemoryVocabulary> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getVocabulary', repositoryId, () =>
      vocabQueries.getVocabulary(this.conn, repositoryId),
    );
  }

  /**
   * Cached vocabulary read used by traversal compilation. The vocabulary is
   * compile-time context for the GremlinCompiler — it changes on the order of
   * once per session, but the traversal hot path pays one round-trip per call
   * to fetch it. The cache flips that to one round-trip per TTL window.
   *
   * Reads inside an active usage scope are still recorded if a fetch happens
   * (cache miss); cache hits emit no round-trip and therefore no usage entry.
   */
  private async getVocabularyCached(repositoryId: string): Promise<MemoryVocabulary> {
    const now = Date.now();
    const cached = this.vocabularyCache.get(repositoryId);
    if (cached && cached.expiresAt > now) {
      return cached.vocab;
    }
    const vocab = await vocabQueries.getVocabulary(this.conn, repositoryId);
    this.vocabularyCache.set(repositoryId, {
      vocab,
      expiresAt: now + VOCABULARY_CACHE_TTL_MS,
    });
    return vocab;
  }

  /** Drop the cache entry for a repository — call after any vocabulary write. */
  private invalidateVocabularyCache(repositoryId: string): void {
    this.vocabularyCache.delete(repositoryId);
  }

  async saveVocabulary(repositoryId: string, vocabulary: MemoryVocabulary): Promise<void> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('saveVocabulary', repositoryId, async () => {
      await vocabQueries.saveVocabulary(this.conn, repositoryId, vocabulary);
      this.invalidateVocabularyCache(repositoryId);
    });
  }

  async getVocabularyChangeLog(repositoryId: string, options?: PaginationOptions): Promise<PaginatedResult<VocabularyChangeRecord>> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getVocabularyChangeLog', repositoryId, () =>
      vocabQueries.getVocabularyChangeLog(this.conn, repositoryId, options),
    );
  }

  // ─── Entities ──────────────────────────────────────────────────────

  async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('createEntity', repositoryId, () =>
      entityQueries.createEntity(this.conn, repositoryId, entity),
    );
  }

  async getEntity(repositoryId: string, entityId: string, options?: EntityReadOptions): Promise<StoredEntity | null> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getEntity', repositoryId, () =>
      entityQueries.getEntity(this.conn, repositoryId, entityId, options),
    );
  }

  async getEntityBySlug(repositoryId: string, slug: string, options?: EntityReadOptions): Promise<StoredEntity | null> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getEntityBySlug', repositoryId, () =>
      entityQueries.getEntityBySlug(this.conn, repositoryId, slug, options),
    );
  }

  async getEntities(repositoryId: string, entityIds: string[], options?: EntityReadOptions): Promise<Map<string, StoredEntity>> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getEntities', repositoryId, () =>
      entityQueries.getEntities(this.conn, repositoryId, entityIds, options),
    );
  }

  async updateEntity(repositoryId: string, entityId: string, updates: StoredEntityUpdate): Promise<StoredEntity> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('updateEntity', repositoryId, () =>
      entityQueries.updateEntity(this.conn, repositoryId, entityId, updates),
    );
  }

  async deleteEntity(repositoryId: string, entityId: string): Promise<void> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteEntity', repositoryId, () =>
      entityQueries.deleteEntity(this.conn, repositoryId, entityId),
    );
  }

  async deleteEntities(repositoryId: string, ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) return { deleted: [], notFound: [] };
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteEntities', repositoryId, () => this.deleteEntitiesImpl(repositoryId, ids));
  }

  private async deleteEntitiesImpl(repositoryId: string, ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    const deleted: string[] = [];
    const CHUNK = 100;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);

      // Find which vertex IDs actually exist using P.within
      const bindings: Record<string, unknown> = { rid: repositoryId };
      const idParams: string[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const p = `id${j}`;
        bindings[p] = chunk[j];
        idParams.push(p);
      }
      const withinExpr = `P.within(${idParams.join(', ')})`;
      const existResult = await this.conn.submit(
        `g.V().has('repositoryId', rid).hasId(${withinExpr}).has('entityType').values('id')`,
        bindings,
      );
      const found = existResult.items as string[];

      if (found.length > 0) {
        // Drop vertices — Gremlin drop() automatically cascades to connected edges
        const dropBindings: Record<string, unknown> = { rid: repositoryId };
        const dropIdParams: string[] = [];
        for (let j = 0; j < found.length; j++) {
          const p = `did${j}`;
          dropBindings[p] = found[j];
          dropIdParams.push(p);
        }
        const dropWithinExpr = `P.within(${dropIdParams.join(', ')})`;
        await this.conn.submit(
          `g.V().has('repositoryId', rid).hasId(${dropWithinExpr}).has('entityType').drop()`,
          dropBindings,
        );
        deleted.push(...found);
      }
    }

    const deletedSet = new Set(deleted);
    return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
  }

  async deleteEntitiesByType(repositoryId: string, entityType: string): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteEntitiesByType', repositoryId, () =>
      entityQueries.deleteEntitiesByType(this.conn, repositoryId, entityType),
    );
  }

  async findEntities(repositoryId: string, query: StorageFindQuery, options?: EntityReadOptions): Promise<PaginatedResult<StoredEntity>> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('findEntities', repositoryId, () =>
      entityQueries.findEntities(this.conn, repositoryId, query, options),
    );
  }

  // ─── Relationships ─────────────────────────────────────────────────

  async createRelationship(repositoryId: string, relationship: StoredRelationship): Promise<StoredRelationship> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('createRelationship', repositoryId, () =>
      relQueries.createRelationship(this.conn, repositoryId, relationship),
    );
  }

  async getRelationship(repositoryId: string, relationshipId: string): Promise<StoredRelationship | null> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getRelationship', repositoryId, () =>
      relQueries.getRelationship(this.conn, repositoryId, relationshipId),
    );
  }

  async getEntityRelationships(repositoryId: string, entityId: string, options?: RelationshipQueryOptions): Promise<PaginatedResult<StoredRelationship>> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getEntityRelationships', repositoryId, () =>
      relQueries.getEntityRelationships(this.conn, repositoryId, entityId, options),
    );
  }

  async deleteRelationship(repositoryId: string, relationshipId: string): Promise<void> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteRelationship', repositoryId, () =>
      relQueries.deleteRelationship(this.conn, repositoryId, relationshipId),
    );
  }

  async deleteRelationships(repositoryId: string, ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) return { deleted: [], notFound: [] };
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteRelationships', repositoryId, () => this.deleteRelationshipsImpl(repositoryId, ids));
  }

  private async deleteRelationshipsImpl(repositoryId: string, ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    const deleted: string[] = [];
    const CHUNK = 100;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);

      // Build Gremlin P.within(...) query to find which IDs actually exist
      const bindings: Record<string, unknown> = { rid: repositoryId };
      const idParams: string[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const p = `id${j}`;
        bindings[p] = chunk[j];
        idParams.push(p);
      }
      const withinExpr = `P.within(${idParams.join(', ')})`;
      const existResult = await this.conn.submit(
        `g.E().has('repositoryId', rid).hasId(${withinExpr}).values('id')`,
        bindings,
      );
      const found = existResult.items as string[];

      if (found.length > 0) {
        await cosmosRestBatchDelete(
          this.getRestEndpoint(),
          this.config.key,
          this.config.database,
          this.config.container,
          repositoryId,
          found,
          this.config.rejectUnauthorized ?? true,
        );
        deleted.push(...found);
      }
    }

    const deletedSet = new Set(deleted);
    return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
  }

  async deleteRelationshipsByType(repositoryId: string, relationshipType: string): Promise<{ deletedRelationships: number }> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteRelationshipsByType', repositoryId, () =>
      relQueries.deleteRelationshipsByType(this.conn, repositoryId, relationshipType),
    );
  }

  // ─── Graph Traversal (StorageProvider) ─────────────────────────────

  async exploreNeighborhood(repositoryId: string, entityId: string, options: StorageExploreOptions): Promise<StorageNeighborhood> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('exploreNeighborhood', repositoryId, () =>
      traversalQueries.exploreNeighborhood(this.conn, repositoryId, entityId, options),
    );
  }

  async findPaths(repositoryId: string, sourceId: string, targetId: string, options: StoragePathOptions): Promise<StoragePathResult> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('findPaths', repositoryId, () =>
      traversalQueries.findPaths(this.conn, repositoryId, sourceId, targetId, options),
    );
  }

  // ─── Timeline ──────────────────────────────────────────────────────

  async getTimeline(repositoryId: string, entityId: string, options: StorageTimelineOptions): Promise<StorageTimelineResult> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('getTimeline', repositoryId, () =>
      timelineQueries.getTimeline(this.conn, repositoryId, entityId, options),
    );
  }

  // ─── Bulk Operations ───────────────────────────────────────────────

  exportAll(repositoryId: string): AsyncIterable<ExportChunk> {
    this.assertValidRepositoryId(repositoryId);
    // exportAll is a streaming iterator — each chunk consumed drives new
    // submits. Wrapping the entire iteration in a single usage scope would
    // require holding the scope open across consumer awaits, which breaks
    // the AsyncLocalStorage contract. Instead, wrap each submit as its own
    // sub-operation by running the iterator generator inside the scope.
    return this.trackIterable('exportAll', repositoryId, bulkQueries.exportAll(this.conn, repositoryId));
  }

  async importBulk(repositoryId: string, data: ImportChunk[], options?: BulkImportOptions): Promise<BulkImportResult> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('importBulk', repositoryId, () =>
      bulkQueries.importBulk(this.conn, repositoryId, data, options),
    );
  }

  /**
   * Wrap an AsyncIterable so every emitted chunk is generated inside the
   * usage scope. On each iteration step, the scope aggregates charges from
   * the next chunk's submits; when the iterator completes (or is closed), a
   * single usage record is emitted for the whole stream.
   */
  private trackIterable<T>(operation: string, repositoryId: string, source: AsyncIterable<T>): AsyncIterable<T> {
    if (!this.reportUsage) return source;
    const sink = this.reportUsage;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => {
        const iter = source[Symbol.asyncIterator]();
        const acc: UsageAccumulator = { ru: 0, calls: 0, retries: 0 };
        let emitted = false;
        const emit = (): void => {
          if (emitted) return;
          emitted = true;
          if (acc.calls > 0) {
            sink({
              provider: PROVIDER_NAME,
              operation,
              unit: 'RU',
              value: acc.ru,
              repositoryId,
              timestamp: new Date(),
              details: { calls: acc.calls, retries: acc.retries },
            });
          }
        };
        return {
          async next(): Promise<IteratorResult<T>> {
            const step = await usageScope.run(acc, () => iter.next());
            if (step.done) emit();
            return step;
          },
          async return(value?: T): Promise<IteratorResult<T>> {
            emit();
            if (iter.return) return iter.return(value);
            return { done: true, value: value as T };
          },
          async throw(err?: unknown): Promise<IteratorResult<T>> {
            emit();
            if (iter.throw) return iter.throw(err);
            throw err;
          },
        };
      },
    };
  }

  // ─── GraphTraversalProvider ────────────────────────────────────────

  getCapabilities(): GraphTraversalCapabilities {
    return {
      supportsNativeQuery: true,
      nativeQueryLanguage: 'gremlin',
      maxTraversalDepth: 10,
      supportsRelationshipPropertyFilters: true,
      supportsEntityPropertyFilters: true,
      supportsAggregation: false,
      supportsRepeat: true,
      supportsDedup: true,
      supportsRelationshipSummary: false,
    };
  }

  async traverse(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<TraversalResult> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('traverse', repositoryId, () => this.traverseImpl(repositoryId, spec));
  }

  private async traverseImpl(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<TraversalResult> {
    const startTime = Date.now();

    // Vocabulary is compile-time context — fetch from the per-process cache so
    // back-to-back traversals do not each pay the `_vocabulary` round-trip.
    const vocabulary = await this.getVocabularyCached(repositoryId);

    // Compile the spec to Gremlin — the provider owns compilation.
    const compiled = this.compiler.compile(spec, vocabulary);

    // Scope the traversal to this repository's partition.
    // repositoryId is the CosmosDB partition key — the predicate both filters
    // and routes the query to a single physical partition. Bind it as a
    // parameter (never concatenated) so it cannot become Gremlin syntax even
    // if the upstream GUID check is ever bypassed.
    const scopedQuery = compiled.query.replace(
      'g.V()',
      "g.V().has('repositoryId', pRid)",
    );
    const scopedParams = { ...compiled.params, pRid: repositoryId };

    try {
      const result = await this.conn.submit(scopedQuery, scopedParams);
      const executionTimeMs = Date.now() - startTime;

      // Project stored entities to the requested detail level. This strips
      // embeddings and any other internal fields at every level — the
      // projection contract never surfaces embeddings via traversal results.
      const detailLevel = spec.detailLevel ?? 'summary';

      type ProjectedEntity = TraversalResult['entities'][number];
      type ProjectedRelationship = NonNullable<TraversalResult['relationships']>[number];

      const projectStoredEntity = (stored: StoredEntity): ProjectedEntity => {
        const projected = projectEntity(stored, detailLevel) as ProjectedEntity;
        if (!spec.includeProvenance) {
          delete (projected as unknown as Record<string, unknown>)['provenance'];
        }
        return projected;
      };

      // direction is mode-specific (Phase 7):
      //   'all'  — always 'outbound' (stored topology; the deduped union has
      //            no walk context). Callers derive walk direction relative
      //            to any anchor via sourceEntityId / targetEntityId.
      //   'path' — relative to the last hop within each walk; callers stamp
      //            via the `direction` argument.
      const projectStoredRelationship = (
        rel: StoredRelationship,
        direction: 'outbound' | 'inbound' = 'outbound',
      ): ProjectedRelationship => ({
        id: rel.id,
        type: rel.relationshipType,
        sourceEntityId: rel.sourceEntityId,
        targetEntityId: rel.targetEntityId,
        direction,
        properties: rel.properties,
      });

      let entities: ProjectedEntity[] = [];
      let relationships: ProjectedRelationship[] | undefined;
      let paths: NonNullable<TraversalResult['paths']> | undefined;

      if (spec.returnMode === 'terminal') {
        // Flat valueMap(true) rows — one vertex per row.
        for (const item of result.items) {
          const stored = entityFromGremlin(item as Record<string, unknown>);
          entities.push(projectStoredEntity(stored));
        }
        relationships = undefined;
      } else if (spec.returnMode === 'all') {
        // Flat stream of unique vertex AND edge projected Maps — the
        // union+dedup query already deduped server-side, so no id-keyed Map
        // needed here. Rows carry an explicit `__kind` discriminator
        // (`'v'` for vertex, `'e'` for edge), set by the compiler's per-branch
        // project chain.
        //
        // direction defaults to 'outbound' (stored topology) per the Phase 7
        // contract — the deduped union carries no walk context.
        relationships = [];
        for (const item of result.items) {
          const props = item as Record<string, unknown>;
          const kind = props['__kind'];
          if (kind === 'v') {
            entities.push(projectStoredEntity(entityFromGremlin(props)));
          } else if (kind === 'e') {
            relationships.push(projectStoredRelationship(relationshipFromGremlin(props)));
          }
          // Rows without a recognised marker are skipped defensively.
        }
      } else {
        // 'path' — Gremlin Path objects: { objects: [vertex|edge, ...] }
        // where each object is a projected Map carrying an explicit `__kind`
        // discriminator ('v' or 'e'). One TraversalPath per path, no dedup
        // across paths (distinct walks are the answer).
        //
        // Direction per edge is computed during the walk using a lastVertexId
        // cursor: 'outbound' when the walk crossed source → target, 'inbound'
        // when it crossed target → source. The outer `relationships` array
        // dedups by rel id and stamps the first-seen direction (matches the
        // in-memory provider's first-writer-wins semantic).
        const entityMap = new Map<string, StoredEntity>();
        const relMap = new Map<string, StoredRelationship>();
        const relFirstDirection = new Map<string, 'outbound' | 'inbound'>();
        const pathRows: Array<{ entityIds: string[]; relIds: string[]; relDirections: Array<'outbound' | 'inbound'> }> = [];

        for (const item of result.items) {
          const pathData = item as { objects?: unknown[] };
          if (!pathData.objects) continue;

          const pathEntityIds: string[] = [];
          const pathRelIds: string[] = [];
          const pathRelDirections: Array<'outbound' | 'inbound'> = [];
          let lastVertexId: string | null = null;

          for (const obj of pathData.objects) {
            const props = obj as Record<string, unknown>;
            const kind = props['__kind'];
            if (kind === 'v') {
              const stored = entityFromGremlin(props);
              entityMap.set(stored.id, stored);
              pathEntityIds.push(stored.id);
              lastVertexId = stored.id;
            } else if (kind === 'e') {
              const stored = relationshipFromGremlin(props);
              relMap.set(stored.id, stored);
              pathRelIds.push(stored.id);
              const direction: 'outbound' | 'inbound' =
                lastVertexId === stored.sourceEntityId ? 'outbound' : 'inbound';
              pathRelDirections.push(direction);
              if (!relFirstDirection.has(stored.id)) {
                relFirstDirection.set(stored.id, direction);
              }
            }
            // Objects without a recognised marker are skipped defensively.
          }

          pathRows.push({ entityIds: pathEntityIds, relIds: pathRelIds, relDirections: pathRelDirections });
        }

        paths = pathRows.map((row) => ({
          length: Math.max(row.entityIds.length - 1, 0),
          entities: row.entityIds.map((id) => {
            const stored = entityMap.get(id);
            if (!stored) {
              throw new ProviderError(
                'Unpacking Gremlin path: entity referenced by path is missing from the result',
                'This indicates a Gremlin response shape mismatch — inspect compiledQuery.',
              );
            }
            return projectStoredEntity(stored);
          }),
          relationships: row.relIds.map((id, i) => {
            const stored = relMap.get(id);
            if (!stored) {
              throw new ProviderError(
                'Unpacking Gremlin path: relationship referenced by path is missing from the result',
                'This indicates a Gremlin response shape mismatch — inspect compiledQuery.',
              );
            }
            return projectStoredRelationship(stored, row.relDirections[i]!);
          }),
        }));
        // Mirror in-memory: outer `relationships` for 'path' is the flat union
        // of per-path edges, each carrying the direction from the first walk
        // that produced it.
        relationships = Array.from(relMap.values()).map((rel) =>
          projectStoredRelationship(rel, relFirstDirection.get(rel.id) ?? 'outbound'),
        );
      }

      const limit = spec.limit ?? 50;
      // 'all' mode returns an interleaved entity+edge union — total must count
      // both so callers see the true page size (Phase 6 fix for issue I).
      let total: number;
      if (spec.returnMode === 'path') {
        total = paths?.length ?? 0;
      } else if (spec.returnMode === 'all') {
        total = entities.length + (relationships?.length ?? 0);
      } else {
        total = entities.length;
      }

      const queryMetadata: QueryMetadata = {
        executionTimeMs,
        resourceCost: result.requestCharge != null
          ? { units: 'RU', value: result.requestCharge }
          : undefined,
        compiledQuery: scopedQuery,
        compiledQueryLanguage: 'gremlin',
        appliedLimits: {
          maxResults: limit,
          maxDepth: spec.steps?.length,
        },
        truncated: total >= limit,
        truncationReason: total >= limit ? 'result_limit' : undefined,
      };

      return {
        entities,
        relationships,
        paths,
        total,
        returned: total,
        hasMore: total >= limit,
        queryMetadata,
      };
    } catch (err: unknown) {
      throw new ProviderError(
        `Gremlin traversal failed: ${err instanceof Error ? err.message : String(err)}`,
        'Check the traversal spec and ensure the CosmosDB connection is healthy.',
      );
    }
  }

  /**
   * Execute a raw Gremlin query with caller-supplied bindings.
   *
   * ⚠️  ELEVATED PRIVILEGE — SYSTEM-LEVEL OPERATION ⚠️
   *
   * This method is an unscoped pass-through: it does not filter by repository,
   * does not inject the partition key, and performs no validation on the query
   * string. A single call can read or mutate any vertex or edge in the
   * container regardless of which repository (partition) it belongs to.
   *
   * DO NOT expose this method to AI agents, end users, or any untrusted caller.
   * It is intended for:
   *   - administrative tooling (migrations, diagnostics, repairs)
   *   - internal library operations that need cross-partition reach
   *
   * `repositoryId` is accepted for interface symmetry but is intentionally
   * ignored here — the caller is trusted to scope the query themselves.
   *
   * For agent-facing graph queries use {@link traverse}, which enforces the
   * repositoryId partition predicate.
   */
  async executeNativeQuery(
    _repositoryId: string,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]> {
    // executeNativeQuery is cross-partition by design; no repositoryId is
    // stamped on the usage record because the query isn't scoped to one.
    return this.track('executeNativeQuery', undefined, () => this.executeNativeQueryImpl(query, params));
  }

  private async executeNativeQueryImpl(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]> {
    const result = await this.conn.submit(query, params);
    return result.items as unknown[];
  }
}

function unwrapGremlinValue(val: unknown): unknown {
  if (Array.isArray(val) && val.length > 0) return val[0];
  return val;
}

// ─── CosmosDB REST API helpers for database/container provisioning ──

/**
 * Generate a CosmosDB REST API authorization token.
 * See: https://learn.microsoft.com/en-us/rest/api/cosmos-db/access-control-on-cosmosdb-resources
 */
function cosmosAuthToken(
  verb: string,
  resourceType: string,
  resourceLink: string,
  date: string,
  key: string,
): string {
  const payload = `${verb.toLowerCase()}\n${resourceType.toLowerCase()}\n${resourceLink}\n${date.toLowerCase()}\n\n`;
  const keyBuffer = Buffer.from(key, 'base64');
  const hmac = crypto.createHmac('sha256', keyBuffer);
  hmac.update(payload);
  const signature = hmac.digest('base64');
  return encodeURIComponent(`type=master&ver=1.0&sig=${signature}`);
}

/**
 * Create a CosmosDB resource (database or container) via REST API.
 * Returns true if the resource was created, false if it already existed.
 */
async function cosmosRestPut(
  restBase: string,
  key: string,
  urlPath: string,
  resourceLink: string,
  resourceType: string,
  body: Record<string, unknown>,
  rejectUnauthorized: boolean,
): Promise<boolean> {
  const date = new Date().toUTCString();
  const token = cosmosAuthToken('post', resourceType, resourceLink, date, key);

  const url = `${restBase}/${urlPath}`;

  const options: RequestInit = {
    method: 'POST',
    headers: {
      'Authorization': token,
      'x-ms-version': '2018-12-31',
      'x-ms-date': date,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };

  // For self-signed certs (emulator), disable TLS verification process-wide.
  // Caller explicitly opted in via rejectUnauthorized: false.
  if (!rejectUnauthorized) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  }

  const response = await fetch(url, options);

  if (response.status === 201) return true; // Created
  if (response.status === 409) return false; // Already exists

  const text = await response.text();
  throw new Error(`CosmosDB REST ${response.status}: ${text}`);
}

/**
 * Delete multiple CosmosDB documents in a single Transactional Batch request.
 * All documents must share the same partition key value (repositoryId).
 * Max 100 operations per batch — caller is responsible for chunking.
 */
async function cosmosRestBatchDelete(
  restBase: string,
  key: string,
  database: string,
  container: string,
  partitionKeyValue: string,
  ids: string[],
  rejectUnauthorized: boolean,
): Promise<void> {
  const resourceLink = `dbs/${database}/colls/${container}`;
  const date = new Date().toUTCString();
  const token = cosmosAuthToken('post', 'docs', resourceLink, date, key);

  if (!rejectUnauthorized) {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  }

  const ops = ids.map((id) => ({ operationType: 'Delete', id }));

  const response = await fetch(`${restBase}/${resourceLink}/docs`, {
    method: 'POST',
    headers: {
      'Authorization': token,
      'x-ms-version': '2020-07-15',
      'x-ms-date': date,
      'Content-Type': 'application/json',
      'x-ms-documentdb-partitionkey': JSON.stringify([partitionKeyValue]),
      'x-ms-cosmos-is-batch-request': 'true',
      'x-ms-cosmos-batch-atomic': 'true',
    },
    body: JSON.stringify(ops),
  });

  // 200 (non-atomic) or 207 (atomic) indicate the batch was processed
  if (response.status !== 200 && response.status !== 207) {
    const text = await response.text();
    throw new ProviderError(`CosmosDB batch delete failed (${response.status}): ${text}`);
  }
}
