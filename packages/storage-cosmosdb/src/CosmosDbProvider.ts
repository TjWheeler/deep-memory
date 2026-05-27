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
  StorageNeighborhoodLayer,
  StoragePath,
  StoragePathResult,
  StorageTimelineResult,
  BulkImportResult,
  TraversalSpec,
  TraversalStep,
  TraversalResult,
  QueryMetadata,
  UsageSink,
} from '@utaba/deep-memory/types';
import type { ExportChunk, ImportChunk, BulkImportOptions, DeleteProgressCallback } from '@utaba/deep-memory/types';
import {
  GremlinCompiler,
  ProviderError,
  InvalidInputError,
  isValidUuid,
  projectEntity,
  createSafeSink,
  matchesPropertyFilters,
} from '@utaba/deep-memory';
import { CosmosDbConnection } from './CosmosDbConnection.js';
import { CosmosDocumentClient } from './CosmosDocumentClient.js';
import { usageScope } from './usage.js';
import type { UsageAccumulator } from './usage.js';
import { cosmosRestPut } from './cosmos-rest-auth.js';
import { entityFromGremlin, relationshipFromGremlin } from './mapping.js';
import * as repoQueries from './queries/repository.js';
import * as vocabQueries from './queries/vocabulary.js';
import * as entityQueries from './queries/entity.js';
import * as relQueries from './queries/relationship.js';
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
 * Indexing-policy paths that `findEntities` SQL relies on. If a container's
 * `excludedPaths` covers any of these (directly or via wildcard), the rewrite
 * falls back to scan — see {@link CosmosDbProvider.runIndexingPolicyDiagnostic}.
 */
const GUARDED_INDEX_PATHS = [
  '/entityLabel',
  '/slug',
  '/summary',
  '/entityType',
  '/properties',
  '/repositoryId',
] as const;

/**
 * Raw, un-projected output from {@link CosmosDbProvider.executeTraversal}.
 * Only the fields relevant to the spec's `returnMode` are populated; the rest
 * remain empty. Used to share the compile + submit + parse pipeline between
 * `traverseInternal` (which projects into the public TraversalResult shape)
 * and the storage-layer rewrites of `exploreNeighborhood` / `findPaths`
 * (which need raw stored entities to rebuild storage-level outputs).
 */
interface RawTraversalResult {
  /** Populated when `spec.returnMode === 'terminal'`. */
  terminalEntities: StoredEntity[];
  /** Populated when `spec.returnMode === 'all'`. */
  allEntities: StoredEntity[];
  /** Populated when `spec.returnMode === 'all'`. */
  allRelationships: StoredRelationship[];
  /** Populated when `spec.returnMode === 'path'`. */
  pathRows: Array<{
    entityIds: string[];
    relationshipIds: string[];
    relationshipDirections: Array<'out' | 'in'>;
  }>;
  /**
   * Lookup table — populated for `'all'` and `'path'` modes. Includes every
   * entity that appears in any returned row.
   */
  entityMap: Map<string, StoredEntity>;
  /**
   * Lookup table — populated for `'all'` and `'path'` modes. Includes every
   * relationship that appears in any returned row.
   */
  relationshipMap: Map<string, StoredRelationship>;
  /**
   * First-seen walk direction per deduped edge id. Populated only for
   * `'path'` mode — the `'all'` mode's deduped union carries no walk context.
   */
  pathRelFirstDirection: Map<string, 'out' | 'in'>;
  executionTimeMs: number;
  requestCharge: number | undefined;
  compiledQuery: string;
}

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
  private readonly docClient: CosmosDocumentClient;
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
    // Document (NoSQL SQL) endpoint client — used by query paths the Gremlin
    // subset can't express server-side (substring + case-insensitive search,
    // structured property predicates). RU accumulates into the same
    // usageScope as `conn`, so one public-method call emits one usage record
    // even when both endpoints are touched.
    this.docClient = new CosmosDocumentClient({
      restEndpoint: this.getRestEndpoint(),
      key: config.key,
      database: config.database,
      container: config.container,
      rejectUnauthorized: config.rejectUnauthorized ?? true,
      maxRetries: config.maxRetries,
      defaultTimeoutMs: config.defaultTimeoutMs,
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
        if (version < SCHEMA_VERSION || databaseCreated || schemaCreated) {
          await this.conn.submit(
            "g.V().hasId(metaId).hasLabel('_meta').property('schemaVersion', ver)",
            { metaId: META_VERTEX_ID, ver: SCHEMA_VERSION },
          );
        }
      } else {
        await this.conn.submit(
          "g.addV('_meta').property('id', metaId).property('repositoryId', pk).property('schemaVersion', ver)",
          { metaId: META_VERTEX_ID, pk: '_system', ver: SCHEMA_VERSION },
        );
        schemaCreated = true;
      }

      // 5. Bootstrap the `_repository_index` sentinel. Idempotent — first run
      // does a one-time cross-partition scan to backfill existing repos, every
      // subsequent run is a single cheap doc-fetch that returns null.
      await repoQueries.ensureRepositoryIndex(this.conn);

      // 6. Step E — indexing-policy diagnostic. Always runs (operators may
      // drift policy between calls). Never fails ensureSchema — see helper.
      await this.runIndexingPolicyDiagnostic();

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

  /**
   * Step E — verify the container's indexing policy covers every path that
   * the SQL `findEntities` rewrite hits. The probe (2026-05-26) confirmed
   * code-managed containers get the Cosmos default policy (everything
   * indexed). This guard is for operator-facing protection: externally
   * provisioned containers (ARM/Bicep) can have `excludedPaths` set, which
   * would force `findEntities` to scan rather than index-lookup.
   *
   * Single GET against the colls resource, minimal RU. Never fails
   * `ensureSchema` — a diagnostic must not break provisioning.
   */
  private async runIndexingPolicyDiagnostic(): Promise<void> {
    let policy: { excludedPaths: Array<{ path: string }> };
    try {
      const props = await this.docClient.getContainerProperties();
      policy = props.indexingPolicy;
    } catch (err: unknown) {
      console.warn(
        `[CosmosDbProvider] could not verify indexing policy on container ` +
          `${this.config.container}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const offending: string[] = [];
    for (const entry of policy.excludedPaths) {
      // Cosmos exclusion paths end in `/?` (exact) or `/*` (subtree). Strip
      // the wildcard to get the prefix the exclusion governs.
      const prefix = entry.path.replace(/\/[?*]$/, '');
      if (prefix === '' || prefix === '/') {
        // Root wildcard — every guarded path is excluded.
        for (const guard of GUARDED_INDEX_PATHS) {
          offending.push(`${guard} (covered by ${entry.path})`);
        }
        break;
      }
      for (const guard of GUARDED_INDEX_PATHS) {
        if (prefix === guard || guard.startsWith(prefix + '/')) {
          offending.push(`${guard} (excluded by ${entry.path})`);
        }
      }
    }

    if (offending.length > 0) {
      console.warn(
        `[CosmosDbProvider] Container ${this.config.container} has indexing-policy ` +
          `excludedPaths that cover paths used by findEntities. The query will ` +
          `fall back to scan and may exceed RU budgets:\n  ${offending.join('\n  ')}\n` +
          `Verify the ARM/Bicep template that provisioned the container.`,
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

  /**
   * Single round-trip bulk-delete via the aggregate-side-effect pattern:
   * collapses the per-chunk existence-check + drop into one Gremlin call.
   *
   *   g.V()...hasId(within(...)).has('entityType')
   *     .aggregate('found').by('id')   // collects the ids that match
   *     .drop()                         // drops the vertices (and cascaded edges)
   *     .cap('found')                   // emits the bucket as the single result
   *
   * The bucket is always emitted as a single list item — empty when nothing
   * matched (probe-verified 2026-05-25, local-tests/phase7-shape-probe.mjs).
   * `notFound` is derived client-side as the set difference.
   */
  private async deleteEntitiesImpl(repositoryId: string, ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    const deleted: string[] = [];
    const CHUNK = 100;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);

      const bindings: Record<string, unknown> = { rid: repositoryId };
      const idParams: string[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const p = `id${j}`;
        bindings[p] = chunk[j];
        idParams.push(p);
      }
      const withinExpr = `within(${idParams.join(', ')})`;
      const result = await this.conn.submit(
        `g.V().has('repositoryId', rid).hasId(${withinExpr}).has('entityType')` +
          `.aggregate('found').by('id').drop().cap('found')`,
        bindings,
      );
      const bucket = result.items[0];
      if (Array.isArray(bucket)) {
        deleted.push(...(bucket as string[]));
      }
    }

    const deletedSet = new Set(deleted);
    return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
  }

  async deleteEntitiesByType(repositoryId: string, entityType: string): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('deleteEntitiesByType', repositoryId, () =>
      entityQueries.deleteEntitiesByType(this.conn, repositoryId, entityType),
    );
  }

  async findEntities(repositoryId: string, query: StorageFindQuery, options?: EntityReadOptions): Promise<PaginatedResult<StoredEntity>> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('findEntities', repositoryId, () =>
      entityQueries.findEntities(this.docClient, repositoryId, query, options),
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

  /**
   * Single round-trip bulk relationship delete via the aggregate-side-effect
   * pattern: collapses the per-chunk existence-check + drop into one Gremlin
   * call. Gremlin drop on edges is routed by the engine and the bucket gives
   * back the exact ids that were actually dropped, so `notFound` can be
   * derived client-side.
   *
   * Source-id partition routing is not exposed on this method (the public
   * surface accepts only edge ids), so the lookup may fan out across
   * partitions — see [docs/cosmosdb-gremlin-compatibility.md §`g.E().has`
   * doesn't always push partition down]. Callers that already hold a
   * StoredRelationship and want partition-scoped routing should add a
   * dedicated method when the need is concrete.
   */
  private async deleteRelationshipsImpl(repositoryId: string, ids: string[]): Promise<{ deleted: string[]; notFound: string[] }> {
    const deleted: string[] = [];
    const CHUNK = 100;

    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);

      const bindings: Record<string, unknown> = { rid: repositoryId };
      const idParams: string[] = [];
      for (let j = 0; j < chunk.length; j++) {
        const p = `id${j}`;
        bindings[p] = chunk[j];
        idParams.push(p);
      }
      const withinExpr = `within(${idParams.join(', ')})`;
      const result = await this.conn.submit(
        `g.E().has('repositoryId', rid).hasId(${withinExpr})` +
          `.aggregate('found').by('id').drop().cap('found')`,
        bindings,
      );
      const bucket = result.items[0];
      if (Array.isArray(bucket)) {
        deleted.push(...(bucket as string[]));
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
      this.exploreNeighborhoodImpl(repositoryId, entityId, options),
    );
  }

  /**
   * Compiler-model implementation of exploreNeighborhood.
   *
   * Strategy: for each depth `d` from 1 to `options.depth`, build a
   * cumulative `TraversalSpec` with `d` steps and `returnMode: 'all'`, run
   * it through {@link executeTraversal}, then walk one BFS layer client-side
   * from the previous frontier using the returned edges.
   *
   * The server-side step direction is fixed to `'both'` (catches every edge
   * in either direction). The directional + bidirectional filter is applied
   * client-side per hop — i.e. `direction: 'out'` includes inbound edges
   * where `bidirectional` is true. The CosmosDB Gremlin compiler does not
   * natively express the `union(outE, inE.has(bidirectional))` shape that
   * would push this filter server-side, so it stays client-side; the
   * observable contract (which edges count toward `'out'` given
   * bidirectionality) is preserved.
   *
   * Round-trips per call: `options.depth` (one per layer). The previous BFS
   * was `1 + fanout + fanout² + …` round-trips for the same depth.
   */
  private async exploreNeighborhoodImpl(
    repositoryId: string,
    entityId: string,
    options: StorageExploreOptions,
  ): Promise<StorageNeighborhood> {
    const layers: StorageNeighborhoodLayer[] = [];
    const visited = new Set<string>([entityId]);
    let frontier = new Set<string>([entityId]);

    for (let d = 1; d <= options.depth; d++) {
      if (frontier.size === 0) break;

      const spec: TraversalSpec = {
        start: { entityId },
        steps: buildExploreSteps(d, options),
        returnMode: 'all',
        // Each round-trip fetches the cumulative subgraph at depth `d` and
        // we reconstruct layers client-side. The result can include every
        // edge and vertex reachable in ≤d hops in either direction; size
        // the limit generously.
        limit: 10_000,
        // Use 'full' + includeProvenance so executeTraversal returns full
        // StoredEntity rows (StorageNeighborhood embeds StoredEntity).
        detailLevel: 'full',
        includeProvenance: true,
      };
      const raw = await this.executeTraversal(repositoryId, spec);

      // Index edges by either endpoint so we can find edges incident to each
      // frontier vertex in O(1).
      const edgesByVertex = new Map<string, StoredRelationship[]>();
      for (const rel of raw.allRelationships) {
        const a = edgesByVertex.get(rel.sourceEntityId);
        if (a) a.push(rel); else edgesByVertex.set(rel.sourceEntityId, [rel]);
        const b = edgesByVertex.get(rel.targetEntityId);
        if (b) b.push(rel); else edgesByVertex.set(rel.targetEntityId, [rel]);
      }

      const layer: StorageNeighborhoodLayer = {};
      const nextFrontier = new Set<string>();
      // Dedup edges within a layer: the cumulative-d response can include the
      // same edge multiple times across the deduped union (server-side dedup
      // is by row, not by edge-in-context). The visit set prevents the same
      // (vertex, edge) pairing from contributing twice.
      const layerEdgeSeen = new Set<string>();

      for (const fv of frontier) {
        const incident = edgesByVertex.get(fv) ?? [];
        for (const rel of incident) {
          const isSource = rel.sourceEntityId === fv;
          const isTarget = rel.targetEntityId === fv;
          let matchesDirection = false;
          let connectedId: string | undefined;

          if (isSource && (options.direction === 'out' || options.direction === 'both')) {
            matchesDirection = true;
            connectedId = rel.targetEntityId;
          } else if (isTarget && (options.direction === 'in' || options.direction === 'both')) {
            matchesDirection = true;
            connectedId = rel.sourceEntityId;
          } else if (rel.bidirectional) {
            if (isSource && options.direction === 'in') {
              matchesDirection = true;
              connectedId = rel.targetEntityId;
            } else if (isTarget && options.direction === 'out') {
              matchesDirection = true;
              connectedId = rel.sourceEntityId;
            }
          }
          if (!matchesDirection || !connectedId) continue;
          if (visited.has(connectedId)) continue;

          // Relationship property filter — applied client-side per hop, matching
          // the existing BFS. Edges that fail the filter neither populate the
          // layer nor expand the frontier.
          if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
            if (!matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters)) continue;
          }

          const connectedEntity = raw.entityMap.get(connectedId);
          if (!connectedEntity) continue;

          // Entity type filter — applied client-side; the server spec walks
          // direction 'both' without entity-type narrowing so deeper layers
          // are still reachable through any intermediate.
          if (options.entityTypes && options.entityTypes.length > 0 &&
              !options.entityTypes.includes(connectedEntity.entityType)) {
            continue;
          }

          // Dedup the (vertex-pair, edge) within this layer.
          const edgeKey = `${rel.id}|${fv}->${connectedId}`;
          if (layerEdgeSeen.has(edgeKey)) continue;
          layerEdgeSeen.add(edgeKey);

          const relType = rel.relationshipType;
          if (!layer[relType]) {
            layer[relType] = { total: 0, entities: [], relationships: [] };
          }
          layer[relType]!.entities.push(connectedEntity);
          layer[relType]!.relationships.push(rel);
          layer[relType]!.total = layer[relType]!.entities.length;
          nextFrontier.add(connectedId);
        }
      }

      // Per-type pagination (matches the existing CosmosDB BFS — total
      // reflects the full pre-slice count).
      for (const relType of Object.keys(layer)) {
        const group = layer[relType]!;
        const start = options.offsetPerType;
        const end = start + options.limitPerType;
        group.entities = group.entities.slice(start, end);
        group.relationships = group.relationships.slice(start, end);
      }

      if (Object.keys(layer).length > 0) {
        layers.push(layer);
      }

      // Promote nextFrontier to visited AFTER the full layer is processed so
      // the same entity can appear under multiple relationship types within
      // a single layer (matches the existing semantic).
      for (const id of nextFrontier) {
        visited.add(id);
      }
      frontier = nextFrontier;
    }

    return { centerId: entityId, layers };
  }

  async findPaths(repositoryId: string, sourceId: string, targetId: string, options: StoragePathOptions): Promise<StoragePathResult> {
    this.assertValidRepositoryId(repositoryId);
    return this.track('findPaths', repositoryId, () =>
      this.findPathsImpl(repositoryId, sourceId, targetId, options),
    );
  }

  /**
   * Compiler-model implementation of findPaths.
   *
   * Strategy: build a `TraversalSpec` with a single `'both'` direction step
   * in `repeat()` mode with `emitIntermediates: true` and `returnMode:
   * 'path'`, run it once. The compiler always emits `.simplePath()` in path
   * mode for cycle prevention, producing
   * `.emit().repeat(bothE().otherV()).times(maxDepth).simplePath()
   * .range(...).path().by(<v>).by(<e>)`, which yields paths of every length
   * from 0 (the start vertex alone) to `maxDepth`. Live-probed against the
   * Cosmos emulator 2026-05-25 — see local-tests/phase4-repeat-emit-probe.mjs.
   *
   * The pre-Phase-4 Cosmos BFS in (now-deleted) `packages/storage-cosmosdb/
   * src/queries/traversal.ts` traversed edges with unconditional `bothE()`
   * regardless of the `bidirectional` flag (path discovery is reachability,
   * not semantic direction). Mirror that here by using step direction
   * `'both'` and not applying any direction filter. The plan's §6
   * observable-outputs rule requires preserving this.
   *
   * One round-trip total. The previous BFS was up to `1 + fanout + fanout² + …`.
   */
  private async findPathsImpl(
    repositoryId: string,
    sourceId: string,
    targetId: string,
    options: StoragePathOptions,
  ): Promise<StoragePathResult> {
    if (sourceId === targetId) {
      return { paths: [{ entityIds: [sourceId], relationshipIds: [] }], totalPaths: 1 };
    }

    const step: TraversalStep = {
      direction: 'both',
      repeat: { maxDepth: options.maxDepth, emitIntermediates: true },
    };
    if (options.relationshipTypes && options.relationshipTypes.length > 0) {
      step.relationshipTypes = options.relationshipTypes;
    }
    if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
      step.relationshipFilter = options.relationshipPropertyFilters;
    }

    const spec: TraversalSpec = {
      start: { entityId: sourceId },
      steps: [step],
      returnMode: 'path',
      // Cycle prevention comes from the compiler unconditionally emitting
      // .simplePath() in path mode — replaces the explicit
      // `state.path.includes(nextId)` guard from the old BFS.
      // Pull the full pool of paths so we can post-filter to those ending at
      // targetId, then paginate. The emulator returns paths of every length
      // 0..maxDepth in one round-trip with the repeat+emit shape; cap
      // generously to ensure all candidates are inspected.
      limit: Math.max(options.limit + options.offset, options.limit) * 10,
      detailLevel: 'full',
      includeProvenance: true,
    };

    const raw = await this.executeTraversal(repositoryId, spec);

    const matchingPaths: StoragePath[] = [];
    for (const row of raw.pathRows) {
      // The repeat+emit shape includes the 0-hop "path" (just the start
      // vertex). source !== target at this point (handled above), so the
      // last-entity check naturally rejects it.
      const last = row.entityIds[row.entityIds.length - 1];
      if (last !== targetId) continue;
      // Apply entity-type filter on intermediate entities (matches the
      // existing CosmosDB BFS — source and target are always allowed).
      if (options.entityTypes && options.entityTypes.length > 0) {
        let rejected = false;
        for (let i = 1; i < row.entityIds.length - 1; i++) {
          const intermediate = raw.entityMap.get(row.entityIds[i]!);
          if (!intermediate) { rejected = true; break; }
          if (!options.entityTypes.includes(intermediate.entityType)) {
            rejected = true;
            break;
          }
        }
        if (rejected) continue;
      }
      matchingPaths.push({
        entityIds: [...row.entityIds],
        relationshipIds: [...row.relationshipIds],
      });
    }

    // Pagination — slice the matching set. `totalPaths` reflects the full
    // pre-slice count, matching the existing storage contract.
    const paginated = matchingPaths.slice(options.offset, options.offset + options.limit);

    return {
      paths: paginated,
      totalPaths: matchingPaths.length,
    };
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
    return this.track('traverse', repositoryId, () => this.traverseInternal(repositoryId, spec));
  }

  /**
   * Compile + execute a TraversalSpec against this repository's partition.
   *
   * Internal entrypoint shared by `traverse` (the public surface) and the
   * compiler-model rewrites of `exploreNeighborhood` / `findPaths`. Does NOT
   * wrap in `track()` — the outer public method owns its own usage scope, and
   * inner submits accumulate into that scope (the nested-scope guard in
   * `track()` keeps nested public calls from emitting duplicate records).
   */
  private async traverseInternal(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<TraversalResult> {
    const raw = await this.executeTraversal(repositoryId, spec);

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

    // direction is mode-specific:
    //   'all'  — always 'out' (stored topology; the deduped union has
    //            no walk context). Callers derive walk direction relative
    //            to any anchor via sourceEntityId / targetEntityId.
    //   'path' — relative to the last hop within each walk; callers stamp
    //            via the `direction` argument.
    const projectStoredRelationship = (
      rel: StoredRelationship,
      direction: 'out' | 'in' = 'out',
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

    // Server-side row count BEFORE greedy-expand. The compiler's union emits
    // vertices before edges at each depth so the deduped stream is closed
    // under per-hop entity references; this preserved count is what hasMore /
    // truncated anchor to, independent of any client-side endpoint backfill.
    const rangeRowCount =
      spec.returnMode === 'all'
        ? raw.allEntities.length + raw.allRelationships.length
        : 0;

    if (spec.returnMode === 'terminal') {
      entities = raw.terminalEntities.map(projectStoredEntity);
      relationships = undefined;
    } else if (spec.returnMode === 'all') {
      // Greedy-expand: pull endpoint vertices into the page if any edge in
      // the slice references a vertex that fell outside the server-side
      // range window. Happens at multi-hop page boundaries where a deeper
      // edge's near endpoint sits in a prior page. One batched getEntities
      // round-trip; soft-limit cost on the visible page size. The pulled-in
      // vertices will reappear at their natural union position in a later
      // page — that duplication is the documented cost of "each page is
      // independently usable".
      const missingIds = new Set<string>();
      for (const rel of raw.allRelationships) {
        if (!raw.entityMap.has(rel.sourceEntityId)) {
          missingIds.add(rel.sourceEntityId);
        }
        if (!raw.entityMap.has(rel.targetEntityId)) {
          missingIds.add(rel.targetEntityId);
        }
      }
      if (missingIds.size > 0) {
        const fetched = await this.getEntities(repositoryId, [...missingIds]);
        for (const stored of fetched.values()) {
          raw.allEntities.push(stored);
          raw.entityMap.set(stored.id, stored);
        }
      }
      entities = raw.allEntities.map(projectStoredEntity);
      relationships = raw.allRelationships.map((r) => projectStoredRelationship(r));
    } else {
      // 'path' — emit one TraversalPath per Gremlin path row, with per-edge
      // walk direction. The outer `relationships` array dedups by rel id and
      // stamps the first-seen direction (first-writer-wins) — this matches
      // the observable contract that callers depend on for path rendering.
      paths = raw.pathRows.map((row) => ({
        length: Math.max(row.entityIds.length - 1, 0),
        entities: row.entityIds.map((id) => {
          const stored = raw.entityMap.get(id);
          if (!stored) {
            throw new ProviderError(
              'Unpacking Gremlin path: entity referenced by path is missing from the result',
              'This indicates a Gremlin response shape mismatch — inspect compiledQuery.',
            );
          }
          return projectStoredEntity(stored);
        }),
        relationships: row.relationshipIds.map((id, i) => {
          const stored = raw.relationshipMap.get(id);
          if (!stored) {
            throw new ProviderError(
              'Unpacking Gremlin path: relationship referenced by path is missing from the result',
              'This indicates a Gremlin response shape mismatch — inspect compiledQuery.',
            );
          }
          return projectStoredRelationship(stored, row.relationshipDirections[i]!);
        }),
      }));
      relationships = Array.from(raw.relationshipMap.values()).map((rel) =>
        projectStoredRelationship(rel, raw.pathRelFirstDirection.get(rel.id) ?? 'out'),
      );
    }

    const limit = spec.limit ?? 50;
    // 'all' mode returns an interleaved entity+edge union — total must count
    // both so callers see the true page size (including any greedy-expanded
    // endpoint vertices).
    let total: number;
    if (spec.returnMode === 'path') {
      total = paths?.length ?? 0;
    } else if (spec.returnMode === 'all') {
      total = entities.length + (relationships?.length ?? 0);
    } else {
      total = entities.length;
    }

    // hasMore / truncated anchor to the request's pagination signal, not the
    // post-expand visible page size. 'all' mode uses the pre-expand row count
    // from the server-side .range() — greedy-expand can only inflate the page
    // and would otherwise spuriously trip the >= limit heuristic when the
    // server-side slice was actually short of `limit`.
    const paginationSignal =
      spec.returnMode === 'all' ? rangeRowCount : total;
    const truncated = paginationSignal >= limit;

    const queryMetadata: QueryMetadata = {
      executionTimeMs: raw.executionTimeMs,
      resourceCost: raw.requestCharge != null
        ? { units: 'RU', value: raw.requestCharge }
        : undefined,
      compiledQuery: raw.compiledQuery,
      compiledQueryLanguage: 'gremlin',
      appliedLimits: {
        maxResults: limit,
        maxDepth: spec.steps?.length,
      },
      truncated,
      truncationReason: truncated ? 'result_limit' : undefined,
    };

    return {
      entities,
      relationships,
      paths,
      total,
      returned: total,
      hasMore: truncated,
      queryMetadata,
    };
  }

  /**
   * Lower-level traversal helper: compiles a spec, submits to Gremlin, and
   * parses the rows into raw {@link StoredEntity} / {@link StoredRelationship}
   * objects (no detail-level projection, no provenance stripping). Used by
   * `traverseInternal` and by the storage-layer rewrites of
   * `exploreNeighborhood` / `findPaths` that need the full stored shape to
   * rebuild `StorageNeighborhood` / `StoragePathResult`.
   *
   * Returns a discriminated bag — only the fields relevant to `spec.returnMode`
   * are populated:
   * - `'terminal'`: `terminalEntities` (in row order, no dedup beyond what the
   *    server emitted).
   * - `'all'`: `allEntities` and `allRelationships`, already server-deduped.
   * - `'path'`: `pathRows` plus the `entityMap` / `relationshipMap` lookup
   *    tables and `pathRelFirstDirection` for the first-seen direction per
   *    deduped edge id.
   */
  private async executeTraversal(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<RawTraversalResult> {
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

    let result;
    try {
      result = await this.conn.submit(scopedQuery, scopedParams);
    } catch (err: unknown) {
      throw new ProviderError(
        `Gremlin traversal failed: ${err instanceof Error ? err.message : String(err)}`,
        'Check the traversal spec and ensure the CosmosDB connection is healthy.',
      );
    }
    const executionTimeMs = Date.now() - startTime;

    const raw: RawTraversalResult = {
      terminalEntities: [],
      allEntities: [],
      allRelationships: [],
      pathRows: [],
      entityMap: new Map(),
      relationshipMap: new Map(),
      pathRelFirstDirection: new Map(),
      executionTimeMs,
      requestCharge: result.requestCharge,
      compiledQuery: scopedQuery,
    };

    if (spec.returnMode === 'terminal') {
      // Flat projected vertex rows — one per row.
      for (const item of result.items) {
        const stored = entityFromGremlin(item as Record<string, unknown>);
        raw.terminalEntities.push(stored);
      }
    } else if (spec.returnMode === 'all') {
      // Flat stream of vertex AND edge projected Maps, already server-deduped
      // by id. Each row carries the synthetic `__kind` discriminator from the
      // compiler's per-branch project chain ('v' = vertex, 'e' = edge).
      for (const item of result.items) {
        const props = item as Record<string, unknown>;
        const kind = props['__kind'];
        if (kind === 'v') {
          const stored = entityFromGremlin(props);
          raw.allEntities.push(stored);
          raw.entityMap.set(stored.id, stored);
        } else if (kind === 'e') {
          const stored = relationshipFromGremlin(props);
          raw.allRelationships.push(stored);
          raw.relationshipMap.set(stored.id, stored);
        }
        // Rows without a recognised marker are skipped defensively.
      }
    } else {
      // 'path' — Gremlin Path objects: { objects: [vertex|edge, ...] }
      // where each object is a projected Map with a `__kind` discriminator.
      //
      // Direction per edge is computed during the walk using a lastVertexId
      // cursor: 'out' when the walk crossed source → target, 'in'
      // when it crossed target → source.
      for (const item of result.items) {
        const pathData = item as { objects?: unknown[] };
        if (!pathData.objects) continue;

        const pathEntityIds: string[] = [];
        const pathRelIds: string[] = [];
        const pathRelDirections: Array<'out' | 'in'> = [];
        let lastVertexId: string | null = null;

        for (const obj of pathData.objects) {
          const props = obj as Record<string, unknown>;
          const kind = props['__kind'];
          if (kind === 'v') {
            const stored = entityFromGremlin(props);
            raw.entityMap.set(stored.id, stored);
            pathEntityIds.push(stored.id);
            lastVertexId = stored.id;
          } else if (kind === 'e') {
            const stored = relationshipFromGremlin(props);
            raw.relationshipMap.set(stored.id, stored);
            pathRelIds.push(stored.id);
            const direction: 'out' | 'in' =
              lastVertexId === stored.sourceEntityId ? 'out' : 'in';
            pathRelDirections.push(direction);
            if (!raw.pathRelFirstDirection.has(stored.id)) {
              raw.pathRelFirstDirection.set(stored.id, direction);
            }
          }
          // Objects without a recognised marker are skipped defensively.
        }

        raw.pathRows.push({
          entityIds: pathEntityIds,
          relationshipIds: pathRelIds,
          relationshipDirections: pathRelDirections,
        });
      }
    }

    return raw;
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

/**
 * Build the per-step TraversalSpec steps for exploreNeighborhood at a given
 * cumulative depth.
 *
 * Server-side step direction is fixed to `'both'` (catches every edge in
 * either direction). The directional + bidirectional filter and entity-type
 * filter run client-side during layer reconstruction — both because the
 * compiler does not express the `union(outE, inE.has(bidirectional))` shape
 * and because entity-type filtering at intermediate hops is non-propagating
 * in the compiler's `'all'` emission (the prefix walks unfiltered vertices).
 *
 * relationshipTypes IS pushed to the server because the compiler emits it as
 * `bothE(t1, t2, ...)`, which IS part of the prefix walk at every depth.
 */
function buildExploreSteps(depth: number, options: StorageExploreOptions): TraversalStep[] {
  const base: TraversalStep = { direction: 'both' };
  if (options.relationshipTypes && options.relationshipTypes.length > 0) {
    base.relationshipTypes = options.relationshipTypes;
  }
  const steps: TraversalStep[] = [];
  for (let i = 0; i < depth; i++) {
    steps.push({ ...base });
  }
  return steps;
}

