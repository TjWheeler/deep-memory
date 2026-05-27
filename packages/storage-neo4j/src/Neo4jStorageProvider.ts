// Neo4jStorageProvider — Neo4j implementation of @utaba/deep-memory's
// StorageProvider. CRUD methods are added incrementally; the `implements
// StorageProvider` declaration is added once the surface is complete.

import type {
  EnsureSchemaResult,
  EntityReadOptions,
  GraphTraversalCapabilities,
} from '@utaba/deep-memory/providers';
import type {
  DeleteProgressCallback,
  MemoryVocabulary,
  PaginatedResult,
  PaginationOptions,
  QueryMetadata,
  RelationshipQueryOptions,
  RepositoryFilter,
  RepositoryStats,
  RepositoryUpdate,
  StorageExploreOptions,
  StorageFindQuery,
  StorageNeighborhood,
  StorageNeighborhoodLayer,
  StoragePath,
  StoragePathOptions,
  StoragePathResult,
  StorageRepositoryConfig,
  StorageTimelineOptions,
  StorageTimelineResult,
  StoredEntity,
  StoredEntityUpdate,
  StoredRelationship,
  StoredRepository,
  StoredRepositorySummary,
  TraversalResult,
  TraversalSpec,
  TraversalStep,
  UsageSink,
  VocabularyChangeRecord,
} from '@utaba/deep-memory/types';
import {
  ProviderError,
  RepositoryNotFoundError,
  createSafeSink,
  matchesPropertyFilters,
  projectEntity,
} from '@utaba/deep-memory';
import { Neo4jTraversalExecutor } from './Neo4jTraversalExecutor.js';
import type { RawTraversalResult } from './Neo4jTraversalExecutor.js';
import { Neo4jConnection, type Neo4jConnectionConfig } from './Neo4jConnection.js';
import { mapDriverError } from './errors.js';
import {
  bigintToSafeNumber,
  repositoryCreateParams,
  repositoryFromRecord,
  repositorySummaryFromRecord,
} from './mapping.js';
import * as entityQueries from './queries/entity.js';
import * as relationshipQueries from './queries/relationship.js';
import * as repositoryQueries from './queries/repository.js';
import * as timelineQueries from './queries/timeline.js';
import * as vocabQueries from './queries/vocabulary.js';
import { getSchemaCypher, SCHEMA_VERSION } from './schema.js';
import {
  buildUsageDetails,
  createUsageScope,
  runInUsageScope,
} from './usageScope.js';

const PROVIDER_NAME = 'neo4j';
const DELETE_BATCH_SIZE = 500;

/**
 * Lifetime of an entry in the per-process vocabulary cache. The vocabulary is
 * compile-time context for traversal — it changes on the order of once per
 * session, but a naïve read pays one round-trip per call on the hot path.
 * 60 s bounds cross-process staleness; writes inside this process invalidate
 * immediately via `invalidateVocabularyCache`. Direct port of the Cosmos
 * `VOCABULARY_CACHE_TTL_MS` constant.
 */
const VOCABULARY_CACHE_TTL_MS = 60_000;

/**
 * Public methods that emit a usage record per call. The value extracts the
 * `repositoryId` from the method's argument list — `undefined` when the
 * operation is not scoped to a single repository (e.g. `ensureSchema`,
 * `listRepositories`).
 *
 * The map mirrors the SQL Server precedent: methods on `StorageProvider`
 * mostly take the `repositoryId` as their first positional argument, so the
 * canonical extractor is `(args) => args[0] as string`. Methods that operate
 * across repositories (e.g. `ensureSchema`, `listRepositories`) return
 * `undefined` so the sink record omits `repositoryId`.
 */
const TRACKED_METHODS: Record<string, (args: unknown[]) => string | undefined> = {
  ensureSchema: () => undefined,
  createRepository: (args) => {
    const cfg = args[0] as { repositoryId?: string } | undefined;
    return cfg?.repositoryId;
  },
  getRepository: (args) => args[0] as string,
  listRepositories: () => undefined,
  updateRepository: (args) => args[0] as string,
  deleteRepository: (args) => args[0] as string,
  deleteAllContents: (args) => args[0] as string,
  getVocabulary: (args) => args[0] as string,
  saveVocabulary: (args) => args[0] as string,
  getVocabularyChangeLog: (args) => args[0] as string,
  createEntity: (args) => args[0] as string,
  getEntity: (args) => args[0] as string,
  getEntityBySlug: (args) => args[0] as string,
  getEntities: (args) => args[0] as string,
  updateEntity: (args) => args[0] as string,
  deleteEntity: (args) => args[0] as string,
  deleteEntities: (args) => args[0] as string,
  deleteEntitiesByType: (args) => args[0] as string,
  findEntities: (args) => args[0] as string,
  createRelationship: (args) => args[0] as string,
  getRelationship: (args) => args[0] as string,
  getEntityRelationships: (args) => args[0] as string,
  deleteRelationship: (args) => args[0] as string,
  deleteRelationships: (args) => args[0] as string,
  deleteRelationshipsByType: (args) => args[0] as string,
  traverse: (args) => args[0] as string,
  exploreNeighborhood: (args) => args[0] as string,
  findPaths: (args) => args[0] as string,
  getTimeline: (args) => args[0] as string,
  getRepositoryStats: (args) => args[0] as string,
};

/** Configuration for `Neo4jStorageProvider`. */
export interface Neo4jStorageProviderConfig extends Neo4jConnectionConfig {
  /**
   * Optional usage sink. When provided, the provider emits one
   * `OperationUsage` record per public method call. The record's `value` is
   * the aggregated `summary.resultConsumedAfter` (server-side ms) across
   * every Bolt round-trip the operation produced; `unit` is `'server_ms'`.
   *
   * The sink is **never** plumbed through to AI-agent-facing surfaces — MCP
   * tools must not expose RU / server-time figures to model responses.
   */
  reportUsage?: UsageSink;
  /**
   * When `true`, prepend `PROFILE` to every compiled traversal query and
   * surface the resulting plan summary under `details.profile` on the sink
   * record. Defaults to `false` — `PROFILE` more than doubles wall-clock on
   * short traversals (see plan §D14 and the Phase 9 probe results), so the
   * cost is worth paying only when an operator is actively investigating
   * planner behaviour.
   */
  profileTraversals?: boolean;
}

/**
 * Schema-version row stored on the singleton `_Meta` node. Written by
 * `ensureSchema` and only read by `ensureSchema` — no other code path
 * touches it.
 */
const META_KEY = 'schema';

export class Neo4jStorageProvider {
  private readonly connection: Neo4jConnection;
  private readonly traversalExecutor: Neo4jTraversalExecutor;
  private initialized = false;
  /**
   * In-process vocabulary cache. Reads hit this map first; writes inside this
   * process invalidate the entry so cache hits stay coherent with the local
   * write. Cross-process staleness is bounded by `VOCABULARY_CACHE_TTL_MS`.
   */
  private readonly vocabularyCache = new Map<
    string,
    { vocab: MemoryVocabulary; expiresAt: number }
  >();

  constructor(config: Neo4jStorageProviderConfig) {
    this.connection = new Neo4jConnection(config);
    this.traversalExecutor = new Neo4jTraversalExecutor(this.connection, {
      profileTraversals: config.profileTraversals === true,
    });

    const safeSink = createSafeSink(config.reportUsage);
    if (safeSink) {
      // Wrap the instance in a Proxy that opens a per-operation `UsageScope`
      // before invoking each tracked method, then emits one `OperationUsage`
      // record at completion. The chokepoint (`Neo4jConnection`) writes into
      // the active scope on every round-trip — the Proxy is the only place
      // sink records are constructed.
      //
      // Mirror of the SQL Server precedent, but with the recorded `value`
      // sourced from aggregated `summary.resultConsumedAfter` (`unit:
      // 'server_ms'`) rather than wall-clock `Date.now()`.
      // eslint-disable-next-line no-constructor-return
      return new Proxy(this, {
        get(target, prop, receiver): unknown {
          const value = Reflect.get(target, prop, receiver);
          if (typeof prop !== 'string' || typeof value !== 'function') return value;
          const extractRepoId = TRACKED_METHODS[prop];
          if (!extractRepoId) return value;
          const method = value as (...a: unknown[]) => unknown;
          return (...args: unknown[]): unknown => {
            const scope = createUsageScope();
            const repositoryId = extractRepoId(args);
            const emit = (): void => {
              safeSink({
                provider: PROVIDER_NAME,
                operation: prop,
                unit: 'server_ms',
                value: scope.serverMs,
                ...(repositoryId !== undefined ? { repositoryId } : {}),
                timestamp: new Date(),
                details: buildUsageDetails(scope),
              });
            };
            return runInUsageScope(scope, () => {
              let result: unknown;
              try {
                result = method.apply(target, args);
              } catch (err) {
                emit();
                throw err;
              }
              if (result && typeof (result as { then?: unknown }).then === 'function') {
                return (result as Promise<unknown>).then(
                  (v) => {
                    emit();
                    return v;
                  },
                  (err) => {
                    emit();
                    throw err;
                  },
                );
              }
              emit();
              return result;
            });
          };
        },
      });
    }
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.connection.verifyConnectivity();
    this.initialized = true;
  }

  public async dispose(): Promise<void> {
    await this.connection.close();
    this.initialized = false;
  }

  // ─── Schema ────────────────────────────────────────────────────────

  /**
   * Idempotent constraint / index DDL plus a single `_Meta` schema-version
   * handshake. Safe to call repeatedly — `CREATE ... IF NOT EXISTS` makes
   * each statement a no-op on subsequent runs.
   *
   * Neo4j Community has no per-tenant database concept — `databaseCreated`
   * is always `false`. Operators are responsible for the target database
   * existing before the provider connects.
   */
  public async ensureSchema(): Promise<EnsureSchemaResult> {
    const currentVersion = await this.readSchemaVersion();

    if (currentVersion !== null && currentVersion > SCHEMA_VERSION) {
      throw new ProviderError(
        `Database schema version ${currentVersion} is newer than provider version ${SCHEMA_VERSION}. ` +
          'Update the @utaba/deep-memory-storage-neo4j package.',
      );
    }

    if (currentVersion === SCHEMA_VERSION) {
      return {
        databaseCreated: false,
        schemaCreated: false,
        alreadyUpToDate: true,
        schemaVersion: SCHEMA_VERSION,
      };
    }

    for (const statement of getSchemaCypher()) {
      await this.connection.executeSystemDdl(statement);
    }
    await this.writeSchemaVersion(SCHEMA_VERSION);

    return {
      databaseCreated: false,
      schemaCreated: true,
      alreadyUpToDate: false,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  private async readSchemaVersion(): Promise<number | null> {
    // The _Meta node is global — schema versioning is a property of the
    // database, not a single repository. Cross-repository is correct here.
    const result = await this.connection.executeSystemQuery<{ schemaVersion: bigint | number }>(
      'MATCH (m:_Meta {key: $key}) RETURN m.schemaVersion AS schemaVersion',
      { key: META_KEY },
      { crossRepository: true, routing: 'READ' },
    );
    const record = result.records[0];
    if (record === undefined) return null;
    const raw = record.get('schemaVersion');
    if (typeof raw === 'bigint') {
      if (raw > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new ProviderError(
          `_Meta.schemaVersion (${raw.toString()}) exceeds Number.MAX_SAFE_INTEGER.`,
        );
      }
      return Number(raw);
    }
    if (typeof raw === 'number') return raw;
    if (raw === null) return null;
    throw new ProviderError(
      `_Meta.schemaVersion has unexpected type ${typeof raw}; expected bigint or number.`,
    );
  }

  private async writeSchemaVersion(version: number): Promise<void> {
    // Cross-repository: the _Meta node is global. The MERGE keeps ensureSchema
    // idempotent across invocations.
    await this.connection.executeSystemQuery(
      'MERGE (m:_Meta {key: $key}) SET m.schemaVersion = $version',
      { key: META_KEY, version },
      { crossRepository: true },
    );
  }

  // ─── Repository ────────────────────────────────────────────────────

  /**
   * Create a new repository. Fixed-shape `CREATE` template — every optional
   * field is bound on every call so the server plan-caches one entry across
   * all repository creates. Optional fields bound as `null` are not persisted
   * (Cypher drops null property values on write — symmetric with read).
   *
   * The `(:_Repository) REQUIRE n.repositoryId IS UNIQUE` constraint surfaces
   * duplicates as `Neo.ClientError.Schema.ConstraintValidationFailed`, which
   * `mapDriverError({ kind: 'repository', ... })` routes to
   * `DuplicateRepositoryError`.
   */
  public async createRepository(config: StorageRepositoryConfig): Promise<StoredRepository> {
    try {
      await this.connection.executeQuery(
        `CREATE (r:_Repository {
          repositoryId: $rid,
          type: $type,
          label: $label,
          description: $description,
          legal: $legal,
          owner: $owner,
          governanceConfig: $governanceConfig,
          metadata: $metadata,
          createdAt: $createdAt,
          createdBy: $createdBy
        })`,
        repositoryCreateParams(config),
        { repositoryId: config.repositoryId },
      );
    } catch (err) {
      mapDriverError(err, {
        kind: 'repository',
        repositoryId: config.repositoryId,
        operation: 'createRepository',
      });
    }

    const result: StoredRepository = {
      repositoryId: config.repositoryId,
      label: config.label,
      governanceConfig: config.governanceConfig,
      createdAt: config.createdAt,
      createdBy: config.createdBy,
    };
    if (config.type !== undefined) result.type = config.type;
    if (config.description !== undefined) result.description = config.description;
    if (config.legal !== undefined) result.legal = config.legal;
    if (config.owner !== undefined) result.owner = config.owner;
    if (config.metadata !== undefined) result.metadata = config.metadata;
    return result;
  }

  public async getRepository(repositoryId: string): Promise<StoredRepository | null> {
    const result = await this.connection.executeQuery(
      'MATCH (r:_Repository {repositoryId: $rid}) RETURN r',
      {},
      { repositoryId, routing: 'READ' },
    );
    const record = result.records[0];
    if (record === undefined) return null;
    return repositoryFromRecord(record);
  }

  public async listRepositories(
    filter?: RepositoryFilter,
  ): Promise<PaginatedResult<StoredRepositorySummary>> {
    const limit = filter?.limit ?? 20;
    const offset = filter?.offset ?? 0;
    const typeFilter = filter?.type;

    const wherePredicates: string[] = [];
    // SKIP / LIMIT take Cypher INTEGER; passing a JS number sends a FLOAT and
    // the planner rejects it with `Neo.ClientError.Statement.ArgumentError`.
    // With `useBigInt: true` on the driver, BigInt round-trips as INTEGER.
    const params: Record<string, unknown> = { offset: BigInt(offset), limit: BigInt(limit) };
    if (typeFilter !== undefined) {
      wherePredicates.push('r.type = $filterType');
      params['filterType'] = typeFilter;
    }
    const whereClause = wherePredicates.length > 0 ? `WHERE ${wherePredicates.join(' AND ')}` : '';

    // listRepositories is cross-repository by definition (D18 — no sentinel
    // index, direct scan against the dm_repository_unique constraint's
    // backing index). Both queries route through executeSystemQuery; the
    // composite scan is cheap because there is no partition fan-out cost on
    // Neo4j and the constraint's auto-index covers _Repository lookups.
    const [dataResult, countResult] = await Promise.all([
      this.connection.executeSystemQuery(
        `MATCH (r:_Repository) ${whereClause} RETURN r ORDER BY r.repositoryId SKIP $offset LIMIT $limit`,
        params,
        { crossRepository: true, routing: 'READ' },
      ),
      this.connection.executeSystemQuery(
        `MATCH (r:_Repository) ${whereClause} RETURN count(r) AS total`,
        typeFilter !== undefined ? { filterType: typeFilter } : {},
        { crossRepository: true, routing: 'READ' },
      ),
    ]);

    const items = dataResult.records.map((record) => repositorySummaryFromRecord(record));
    const totalRaw = countResult.records[0]?.get('total');
    const total = totalRaw === undefined ? 0 : bigintToSafeNumber(totalRaw);

    return {
      items,
      total,
      hasMore: offset + items.length < total,
      limit,
      offset,
    };
  }

  /**
   * Variable-shape Cypher (per D23 trade-off — repository writes are rare so
   * the plan-cache cost is negligible). Projection-on-write returns the
   * updated row in one round-trip; empty-rowset → `RepositoryNotFoundError`.
   */
  public async updateRepository(
    repositoryId: string,
    updates: RepositoryUpdate,
  ): Promise<StoredRepository> {
    const setClauses: string[] = [];
    const params: Record<string, unknown> = {};

    if (updates.label !== undefined) {
      setClauses.push('r.label = $label');
      params['label'] = updates.label;
    }
    if (updates.description !== undefined) {
      setClauses.push('r.description = $description');
      params['description'] = updates.description;
    }
    if (updates.type !== undefined) {
      setClauses.push('r.type = $type');
      params['type'] = updates.type;
    }
    if (updates.legal !== undefined) {
      setClauses.push('r.legal = $legal');
      params['legal'] = updates.legal;
    }
    if (updates.owner !== undefined) {
      setClauses.push('r.owner = $owner');
      params['owner'] = updates.owner;
    }
    if (updates.governanceConfig !== undefined) {
      setClauses.push('r.governanceConfig = $governanceConfig');
      params['governanceConfig'] = JSON.stringify(updates.governanceConfig);
    }
    if (updates.metadata !== undefined) {
      // Shallow merge with the existing metadata bag — same contract as the
      // SQL Server and Cosmos providers. Requires reading the current value
      // first so the merge happens server-side via the SET clause.
      const existing = await this.getRepository(repositoryId);
      if (existing === null) throw new RepositoryNotFoundError(repositoryId);
      const merged = { ...existing.metadata, ...updates.metadata };
      setClauses.push('r.metadata = $metadata');
      params['metadata'] = JSON.stringify(merged);
    }

    if (setClauses.length === 0) {
      const existing = await this.getRepository(repositoryId);
      if (existing === null) throw new RepositoryNotFoundError(repositoryId);
      return existing;
    }

    const cypher = `MATCH (r:_Repository {repositoryId: $rid}) SET ${setClauses.join(', ')} RETURN r`;
    const result = await this.connection.executeQuery(cypher, params, { repositoryId });
    const record = result.records[0];
    if (record === undefined) throw new RepositoryNotFoundError(repositoryId);
    return repositoryFromRecord(record);
  }

  /**
   * Drop every node and relationship scoped to `repositoryId`, including the
   * `_Repository` node itself. Two-stage chunked wipe driven by app-side loops
   * so the progress callback fires at a useful cadence:
   *
   *   1. Drain relationships in batches via `CALL ( ) { ... } IN TRANSACTIONS`.
   *   2. Drain nodes (entities + system) in batches via the same form with
   *      `DETACH DELETE` (catches any straggler edges).
   *
   * `IN TRANSACTIONS` can only run on auto-commit sessions — `executeWrite`
   * fails with `Neo.DatabaseError.Transaction.TransactionStartFailed` per
   * probe P13. The chokepoint's `executeImplicitInTransactions` is the only
   * legitimate entry point for this pattern.
   */
  public async deleteRepository(
    repositoryId: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<void> {
    const { totalEntities, totalRelationships } = await this.countRepositoryContents(repositoryId);

    let relationshipsDeleted = 0;
    let entitiesDeleted = 0;

    while (true) {
      const summary = await this.connection.executeImplicitInTransactions(
        `CALL () {
           MATCH ()-[r {repositoryId: $rid}]-()
           WITH r LIMIT $batchSize
           DELETE r
         } IN TRANSACTIONS OF $batchSize ROWS`,
        // BigInt so the Cypher LIMIT clause sees a Cypher INTEGER, not FLOAT.
        { batchSize: BigInt(DELETE_BATCH_SIZE) },
        { repositoryId },
      );
      const stats = summary.counters.updates();
      const deletedThisBatch = stats['relationshipsDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      relationshipsDeleted = Math.min(relationshipsDeleted + deletedThisBatch, totalRelationships);
      await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    }

    while (true) {
      const summary = await this.connection.executeImplicitInTransactions(
        `CALL () {
           MATCH (n {repositoryId: $rid})
           WITH n LIMIT $batchSize
           DETACH DELETE n
         } IN TRANSACTIONS OF $batchSize ROWS`,
        // BigInt so the Cypher LIMIT clause sees a Cypher INTEGER, not FLOAT.
        { batchSize: BigInt(DELETE_BATCH_SIZE) },
        { repositoryId },
      );
      const stats = summary.counters.updates();
      const deletedThisBatch = stats['nodesDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      // The match drains _Entity, _Vocabulary, _VocabularyChangeLog AND the
      // _Repository node itself — system nodes inflate the raw counter past
      // the user-facing entity total. Cap so the callback never reports more
      // than it promised.
      entitiesDeleted = Math.min(entitiesDeleted + deletedThisBatch, totalEntities);
      await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    }
  }

  /**
   * Drop every entity and relationship scoped to `repositoryId` but preserve
   * the `_Repository` and `_Vocabulary` / `_VocabularyChangeLog` system nodes.
   * Same chunked-wipe contract as `deleteRepository`, restricted to the
   * `:_Entity` umbrella label for nodes.
   */
  public async deleteAllContents(
    repositoryId: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const { totalEntities, totalRelationships } = await this.countRepositoryContents(repositoryId);

    let relationshipsDeleted = 0;
    let entitiesDeleted = 0;

    while (true) {
      const summary = await this.connection.executeImplicitInTransactions(
        `CALL () {
           MATCH (:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]-(:_Entity {repositoryId: $rid})
           WITH r LIMIT $batchSize
           DELETE r
         } IN TRANSACTIONS OF $batchSize ROWS`,
        // BigInt so the Cypher LIMIT clause sees a Cypher INTEGER, not FLOAT.
        { batchSize: BigInt(DELETE_BATCH_SIZE) },
        { repositoryId },
      );
      const stats = summary.counters.updates();
      const deletedThisBatch = stats['relationshipsDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      relationshipsDeleted = Math.min(relationshipsDeleted + deletedThisBatch, totalRelationships);
      await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    }

    while (true) {
      const summary = await this.connection.executeImplicitInTransactions(
        `CALL () {
           MATCH (n:_Entity {repositoryId: $rid})
           WITH n LIMIT $batchSize
           DETACH DELETE n
         } IN TRANSACTIONS OF $batchSize ROWS`,
        // BigInt so the Cypher LIMIT clause sees a Cypher INTEGER, not FLOAT.
        { batchSize: BigInt(DELETE_BATCH_SIZE) },
        { repositoryId },
      );
      const stats = summary.counters.updates();
      const deletedThisBatch = stats['nodesDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      entitiesDeleted = Math.min(entitiesDeleted + deletedThisBatch, totalEntities);
      await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    }

    return { deletedEntities: totalEntities, deletedRelationships: totalRelationships };
  }

  /**
   * One-shot pre-count used by `deleteRepository` / `deleteAllContents`. The
   * entity count uses the umbrella `:_Entity` label so system nodes
   * (`_Repository` / `_Vocabulary`) are excluded — that matches the
   * user-facing semantics of the progress callback.
   */
  private async countRepositoryContents(
    repositoryId: string,
  ): Promise<{ totalEntities: number; totalRelationships: number }> {
    const [entitiesResult, relationshipsResult] = await Promise.all([
      this.connection.executeQuery(
        'MATCH (n:_Entity {repositoryId: $rid}) RETURN count(n) AS total',
        {},
        { repositoryId, routing: 'READ' },
      ),
      this.connection.executeQuery(
        'MATCH ()-[r {repositoryId: $rid}]-() RETURN count(r) AS total',
        {},
        { repositoryId, routing: 'READ' },
      ),
    ]);
    const totalEntities = bigintToSafeNumber(entitiesResult.records[0]?.get('total') ?? 0);
    const totalRelationships = bigintToSafeNumber(relationshipsResult.records[0]?.get('total') ?? 0);
    return { totalEntities, totalRelationships };
  }

  // ─── Vocabulary ────────────────────────────────────────────────────

  /**
   * Read the vocabulary for a repository. Cache-aware: cache hits return
   * synchronously with zero Bolt round-trips. The TRACKED_METHODS proxy still
   * fires for every call — the sink record on a cache hit carries
   * `details.calls === 0` and `value === 0`, which is the contract the sink
   * expects to express "this operation ran but did no server work".
   */
  public async getVocabulary(repositoryId: string): Promise<MemoryVocabulary> {
    return this.getVocabularyCached(repositoryId);
  }

  /**
   * Cached vocabulary read used by `getVocabulary` and (in later phases) by
   * traversal compilation. The vocabulary is compile-time context for the
   * Cypher compiler — it changes on the order of once per session, but the
   * traversal hot path would otherwise pay one round-trip per call. The cache
   * flips that to one round-trip per TTL window.
   *
   * Reads inside an active usage scope still record a round-trip when a fetch
   * actually happens (cache miss); cache hits emit no round-trip and therefore
   * contribute nothing to the scope.
   */
  private async getVocabularyCached(repositoryId: string): Promise<MemoryVocabulary> {
    const now = Date.now();
    const cached = this.vocabularyCache.get(repositoryId);
    if (cached && cached.expiresAt > now) {
      return cached.vocab;
    }
    const vocab = await vocabQueries.getVocabulary(this.connection, repositoryId);
    this.vocabularyCache.set(repositoryId, {
      vocab,
      expiresAt: now + VOCABULARY_CACHE_TTL_MS,
    });
    return vocab;
  }

  /** Drop the cache entry for a repository — call after every vocabulary write. */
  private invalidateVocabularyCache(repositoryId: string): void {
    this.vocabularyCache.delete(repositoryId);
  }

  /**
   * Upsert the vocabulary for a repository. Invalidates the in-process cache
   * on success so subsequent reads observe the new state immediately within
   * this process (cross-process staleness is bounded by the 60 s TTL).
   */
  public async saveVocabulary(
    repositoryId: string,
    vocabulary: MemoryVocabulary,
  ): Promise<void> {
    await vocabQueries.saveVocabulary(this.connection, repositoryId, vocabulary);
    this.invalidateVocabularyCache(repositoryId);
  }

  /**
   * Page the vocabulary change-log newest first. Writes land in
   * `proposeVocabularyExtension` (out of scope here) — this method only reads
   * the `_VocabularyChangeLog` nodes back, ordered by `proposedAt` to match
   * the audit semantic on `VocabularyChangeRecord`.
   */
  public async getVocabularyChangeLog(
    repositoryId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<VocabularyChangeRecord>> {
    return vocabQueries.getVocabularyChangeLog(this.connection, repositoryId, options);
  }

  // ─── Entities ──────────────────────────────────────────────────────

  /**
   * Create a new entity via fixed-shape `CREATE` + catch on the uniqueness
   * constraint. A `MERGE`-with-discriminator alternative is marginally faster
   * on the happy path but mutates the existing node on collisions, writing
   * a discriminator property onto durable graph state the caller never
   * requested — correctness wins over the marginal perf delta.
   */
  public async createEntity(
    repositoryId: string,
    entity: StoredEntity,
  ): Promise<StoredEntity> {
    return entityQueries.createEntity(this.connection, repositoryId, entity);
  }

  /** Read a single entity by id; `null` when not found. */
  public async getEntity(
    repositoryId: string,
    entityId: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null> {
    return entityQueries.getEntity(this.connection, repositoryId, entityId, options);
  }

  /** Read a single entity by slug; `null` when not found. */
  public async getEntityBySlug(
    repositoryId: string,
    slug: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null> {
    return entityQueries.getEntityBySlug(this.connection, repositoryId, slug, options);
  }

  /**
   * Batch read by ids. Absent ids do not appear in the returned `Map`; empty
   * input returns an empty map without a round-trip.
   */
  public async getEntities(
    repositoryId: string,
    entityIds: string[],
    options?: EntityReadOptions,
  ): Promise<Map<string, StoredEntity>> {
    return entityQueries.getEntities(this.connection, repositoryId, entityIds, options);
  }

  /**
   * Variable-shape projection-on-write update (D23) — single round-trip
   * MATCH+SET+RETURN. Empty record array → `EntityNotFoundError`.
   */
  public async updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity> {
    return entityQueries.updateEntity(this.connection, repositoryId, entityId, updates);
  }

  /**
   * Delete a single entity (and its incident relationships via `DETACH
   * DELETE`). Throws `EntityNotFoundError` when the match returns zero rows.
   */
  public async deleteEntity(
    repositoryId: string,
    entityId: string,
  ): Promise<void> {
    return entityQueries.deleteEntity(this.connection, repositoryId, entityId);
  }

  /**
   * Bulk delete by ids — single round-trip. Returns the ids actually
   * deleted; missing ids land in `notFound`.
   */
  public async deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    return entityQueries.deleteEntities(this.connection, repositoryId, ids);
  }

  /**
   * Delete every entity of a type plus their incident relationships, with
   * exact counts (entity + relationship) returned in one round-trip — a
   * strict improvement over Cosmos's `deletedRelationships: undefined` path
   * (Gremlin would fan out across every partition the type touches).
   */
  public async deleteEntitiesByType(
    repositoryId: string,
    entityType: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
    return entityQueries.deleteEntitiesByType(this.connection, repositoryId, entityType);
  }

  /**
   * Page entities matching a `StorageFindQuery`. Parallel data + count Cypher
   * pair; `total` is always exact because every filter (entity-type, property
   * equality, search term, provenance) is server-side via either a typed
   * predicate or the `dm_entity_text` fulltext index. Search-term queries
   * order by Lucene score descending; non-search queries order by `n.id` to
   * pin pagination determinism across slices.
   */
  public async findEntities(
    repositoryId: string,
    query: StorageFindQuery,
    options?: EntityReadOptions,
  ): Promise<PaginatedResult<StoredEntity>> {
    return entityQueries.findEntities(this.connection, repositoryId, query, options);
  }

  // ─── Relationships ─────────────────────────────────────────────────

  /**
   * Create a relationship. Both endpoint entities are matched under the
   * repository scope before the edge is created, so cross-repository edges
   * are structurally impossible to write (D3b layer 3). A missing endpoint
   * surfaces as `EntityNotFoundError` carrying the absent id.
   */
  public async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
  ): Promise<StoredRelationship> {
    return relationshipQueries.createRelationship(this.connection, repositoryId, relationship);
  }

  /** Read a single relationship by id; `null` when not found. */
  public async getRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<StoredRelationship | null> {
    return relationshipQueries.getRelationship(this.connection, repositoryId, relationshipId);
  }

  /**
   * Page an entity's incident relationships. `direction: 'out' | 'in'`
   * additionally surfaces edges flagged `bidirectional: true` from the
   * opposite endpoint, mirroring the Cosmos read-time duplication of bidir
   * edges. `propertyFilters` is applied client-side and reports
   * `total: undefined` in that branch — same trade-off as the Cosmos
   * provider, because relationship `properties` is a JSON blob with no
   * per-key index.
   */
  public async getEntityRelationships(
    repositoryId: string,
    entityId: string,
    options?: RelationshipQueryOptions,
  ): Promise<PaginatedResult<StoredRelationship>> {
    return relationshipQueries.getEntityRelationships(
      this.connection,
      repositoryId,
      entityId,
      options,
    );
  }

  /** Drop a single relationship by id. No-op when the id does not match. */
  public async deleteRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<void> {
    return relationshipQueries.deleteRelationship(this.connection, repositoryId, relationshipId);
  }

  /**
   * Bulk drop by ids — single round-trip. Returns the ids actually deleted;
   * missing ids land in `notFound`.
   */
  public async deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    return relationshipQueries.deleteRelationships(this.connection, repositoryId, ids);
  }

  /**
   * Drop every relationship of a type in the repository. Returns an exact
   * delete count in a single round-trip.
   */
  public async deleteRelationshipsByType(
    repositoryId: string,
    relationshipType: string,
  ): Promise<{ deletedRelationships: number }> {
    return relationshipQueries.deleteRelationshipsByType(
      this.connection,
      repositoryId,
      relationshipType,
    );
  }

  // ─── Graph Traversal ───────────────────────────────────────────────

  /**
   * Capabilities surface used by the dispatcher to decide whether a given
   * `TraversalSpec` shape is supported natively. Strict improvement over the
   * Cosmos provider in two cells: `supportsAggregation` is `true` (Cypher's
   * native aggregation makes `count` / per-key projection a one-statement
   * shape) and the runtime supports every other traversal lever.
   */
  public getCapabilities(): GraphTraversalCapabilities {
    return {
      supportsNativeQuery: true,
      nativeQueryLanguage: 'cypher',
      maxTraversalDepth: 10,
      supportsRelationshipPropertyFilters: true,
      supportsEntityPropertyFilters: true,
      supportsAggregation: true,
      supportsRepeat: true,
      supportsDedup: true,
      supportsRelationshipSummary: false,
    };
  }

  /**
   * Execute a `TraversalSpec` against this repository's subgraph. The
   * provider owns Cypher compilation; the spec stays language-agnostic.
   * `track('traverse')` opens the per-operation usage scope so every
   * `executeQuery` round-trip the executor performs aggregates into a single
   * `OperationUsage` record.
   */
  public async traverse(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<TraversalResult> {
    return this.traverseInternal(repositoryId, spec);
  }

  /**
   * Internal compile → submit → project pipeline. Shared by the public
   * `traverse` method and by the compiler-model rewrites of
   * `exploreNeighborhood` / `findPaths`, which both consume the raw stored
   * shape to rebuild their storage-level outputs.
   */
  private async traverseInternal(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<TraversalResult> {
    const raw = await this.executeRawTraversal(repositoryId, spec);

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

    // Walk direction stamping is mode-specific:
    //   'all'  — relationships have no walk context (the row tuple has no
    //            anchor), so the stored topology direction is reported as
    //            `'out'` and callers derive walk direction relative to any
    //            anchor via sourceEntityId / targetEntityId.
    //   'path' — per-segment, computed inside the executor.
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

    if (spec.returnMode === 'terminal') {
      entities = raw.terminalEntities.map(projectStoredEntity);
      relationships = undefined;
    } else if (spec.returnMode === 'all') {
      // Greedy-expand is unnecessary on Cypher: each row of the 'all' emission
      // is a (n0, ..., nD, r0, ..., r(D-1)) tuple binding every relationship
      // to its endpoint nodes at MATCH time. A `LIMIT` slices whole rows; it
      // cannot orphan a relationship's endpoint within a row. The Cosmos
      // provider needs the back-fill because Gremlin's union-of-vertices-and-
      // edges stream can drop an edge's endpoint via `.range()`.
      entities = raw.allEntities.map(projectStoredEntity);
      relationships = raw.allRelationships.map((r) => projectStoredRelationship(r));
    } else {
      paths = raw.pathRows.map((row) => ({
        length: Math.max(row.entityIds.length - 1, 0),
        entities: row.entityIds.map((id) => {
          const stored = raw.entityMap.get(id);
          if (!stored) {
            throw new ProviderError(
              'Unpacking Cypher path: entity referenced by path is missing from the result.',
              'Inspect compiledQuery — this indicates a path emission shape mismatch.',
            );
          }
          return projectStoredEntity(stored);
        }),
        relationships: row.relationshipIds.map((id, i) => {
          const stored = raw.relationshipMap.get(id);
          if (!stored) {
            throw new ProviderError(
              'Unpacking Cypher path: relationship referenced by path is missing from the result.',
              'Inspect compiledQuery — this indicates a path emission shape mismatch.',
            );
          }
          return projectStoredRelationship(stored, row.relationshipDirections[i] ?? 'out');
        }),
      }));
      relationships = Array.from(raw.relationshipMap.values()).map((rel) =>
        projectStoredRelationship(rel, raw.pathRelFirstDirection.get(rel.id) ?? 'out'),
      );
    }

    const limit = spec.limit ?? 50;
    let total: number;
    if (spec.returnMode === 'path') {
      total = paths?.length ?? 0;
    } else if (spec.returnMode === 'all') {
      // 'all' mode returns an interleaved entity+edge union — total counts both
      // arrays so callers see the true page size.
      total = entities.length + (relationships?.length ?? 0);
    } else {
      total = entities.length;
    }

    const truncated = total >= limit;

    const queryMetadata: QueryMetadata = {
      executionTimeMs: raw.executionTimeMs,
      resourceCost: { units: 'server_ms', value: raw.serverMs },
      compiledQuery: raw.compiledQuery,
      compiledQueryLanguage: 'cypher',
      appliedLimits: {
        maxResults: limit,
        ...(spec.steps !== undefined ? { maxDepth: spec.steps.length } : {}),
      },
      truncated,
      ...(truncated ? { truncationReason: 'result_limit' as const } : {}),
    };

    return {
      entities,
      ...(relationships !== undefined ? { relationships } : {}),
      ...(paths !== undefined ? { paths } : {}),
      total,
      returned: total,
      hasMore: truncated,
      queryMetadata,
    };
  }

  /**
   * Lower-level compile + submit + parse helper. Fetches the cached
   * vocabulary once (D16) and hands it to the executor; the executor handles
   * the repositoryId-scope rewrite, optional PROFILE prefix, and Path-object
   * parsing.
   */
  private async executeRawTraversal(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<RawTraversalResult> {
    const vocabulary = await this.getVocabularyCached(repositoryId);
    return this.traversalExecutor.execute(repositoryId, spec, vocabulary);
  }

  /**
   * BFS-like neighbourhood exploration. For each depth `d` from 1 to
   * `options.depth`, compile a cumulative `'all'`-mode spec with `d` discrete
   * `'both'`-direction steps, run it through the executor, and walk one BFS
   * layer client-side from the previous frontier using the returned edges.
   *
   * Round-trips per call: `options.depth`. Server-side step direction is
   * fixed to `'both'` (catches every edge in either direction); the
   * directional + bidirectional filter and entity-type filter run client-side
   * during layer reconstruction — both to preserve the observable contract
   * shared with the Cosmos provider and because the compiler's prefix walk at
   * each depth is intentionally unfiltered so deeper layers stay reachable
   * through any intermediate.
   */
  public async exploreNeighborhood(
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
        // The cumulative-d query fetches every node and edge reachable in ≤d
        // hops in either direction. Size the limit generously so a single
        // round-trip can hold the layer's full graph regardless of fan-out.
        limit: 10_000,
        detailLevel: 'full',
        includeProvenance: true,
      };
      const raw = await this.executeRawTraversal(repositoryId, spec);

      const edgesByVertex = new Map<string, StoredRelationship[]>();
      for (const rel of raw.allRelationships) {
        const a = edgesByVertex.get(rel.sourceEntityId);
        if (a) a.push(rel);
        else edgesByVertex.set(rel.sourceEntityId, [rel]);
        const b = edgesByVertex.get(rel.targetEntityId);
        if (b) b.push(rel);
        else edgesByVertex.set(rel.targetEntityId, [rel]);
      }

      const layer: StorageNeighborhoodLayer = {};
      const nextFrontier = new Set<string>();
      // Dedup the (vertex-pair, edge) within a single layer — the cumulative
      // 'all' response can include the same edge under multiple rows when
      // both endpoints sit on the frontier.
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
            // bidirectional flag exposes the edge in the opposite direction
            // without doubling the stored topology.
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

          if (
            options.relationshipPropertyFilters &&
            options.relationshipPropertyFilters.length > 0
          ) {
            if (!matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters))
              continue;
          }

          const connectedEntity = raw.entityMap.get(connectedId);
          if (!connectedEntity) continue;

          if (
            options.entityTypes &&
            options.entityTypes.length > 0 &&
            !options.entityTypes.includes(connectedEntity.entityType)
          ) {
            continue;
          }

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

      // Per-type pagination — `total` reflects the full pre-slice count so
      // callers can page later without re-issuing the traversal.
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

      // Promote the next frontier into `visited` only after the whole layer is
      // processed — keeps a single entity available under multiple relationship
      // types within the same layer (same semantic as the Cosmos provider).
      for (const id of nextFrontier) visited.add(id);
      frontier = nextFrontier;
    }

    return { centerId: entityId, layers };
  }

  /**
   * Path finding between two entities. Single round-trip via a variable-length
   * `MATCH p = (s)-[*1..N]-(t)` pattern; the compiler's path-binding emission
   * lets the executor recover ordered nodes and relationships via `nodes(p)`
   * / `relationships(p)`. The default `DIFFERENT RELATIONSHIPS` match mode in
   * Cypher 25 prevents edge reuse within a single path — no explicit dedup
   * filter is needed.
   *
   * The traversal walks the graph topologically regardless of relationship
   * directionality (a path is defined by reachability, not semantic
   * direction); entity-type and relationship-property filters apply during
   * compilation, target filtering happens post-fetch.
   */
  public async findPaths(
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
      // Pull a generous candidate pool so the post-fetch filter (paths ending
      // at targetId) has enough rows to paginate from. The variable-length
      // pattern returns every walk of length ≤ maxDepth in one round-trip.
      limit: Math.max(options.limit + options.offset, options.limit) * 10,
      detailLevel: 'full',
      includeProvenance: true,
    };

    const raw = await this.executeRawTraversal(repositoryId, spec);

    const matchingPaths: StoragePath[] = [];
    for (const row of raw.pathRows) {
      const last = row.entityIds[row.entityIds.length - 1];
      if (last !== targetId) continue;
      if (options.entityTypes && options.entityTypes.length > 0) {
        // Entity-type filter applies only to intermediate vertices — source
        // and target are always allowed regardless of the filter, mirroring
        // the Cosmos contract.
        let rejected = false;
        for (let i = 1; i < row.entityIds.length - 1; i++) {
          const intermediate = raw.entityMap.get(row.entityIds[i]!);
          if (!intermediate) {
            rejected = true;
            break;
          }
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

    const paginated = matchingPaths.slice(options.offset, options.offset + options.limit);

    return {
      paths: paginated,
      totalPaths: matchingPaths.length,
    };
  }

  // ─── Timeline ──────────────────────────────────────────────────────

  /**
   * Reconstruct the timeline event stream for an entity. One server
   * round-trip: the centre entity's provenance scalars plus every incident
   * edge's id + createdAt arrive in a single tuple via `OPTIONAL MATCH +
   * collect()`. The provider walks the row client-side to emit
   * `entity:created` / `entity:updated` / `relationship:created` events.
   *
   * Cosmos pays two round-trips for the same information because Gremlin
   * cannot bind an aggregated edge list to a vertex projection in one shot —
   * a platform divergence, not an inherent trade-off.
   */
  public async getTimeline(
    repositoryId: string,
    entityId: string,
    options: StorageTimelineOptions,
  ): Promise<StorageTimelineResult> {
    return timelineQueries.getTimeline(this.connection, repositoryId, entityId, options);
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  /**
   * Aggregate repository statistics — entity / relationship totals, per-type
   * breakdowns, vocabulary version. Two parallel native-aggregation round-
   * trips (`count(n)` per `entityType`, `count(r)` per `type(r)`); the
   * vocabulary version comes from the cached `_Vocabulary` node so a warm
   * cache costs exactly two round-trips total.
   *
   * Strict improvement over Cosmos's Gremlin `.group().by().by(count())`
   * shape — Cypher's native aggregation collapses each metric to a one-
   * statement plan that hits the `(repositoryId, entityType)` and
   * relationship-property indexes directly.
   */
  public async getRepositoryStats(repositoryId: string): Promise<RepositoryStats> {
    const vocabulary = await this.getVocabularyCached(repositoryId);
    return repositoryQueries.getRepositoryStats(this.connection, repositoryId, vocabulary);
  }
}

/**
 * Build the per-step `TraversalSpec` steps for `exploreNeighborhood` at a
 * given cumulative depth. Server-side step direction is fixed to `'both'`;
 * the directional + bidirectional filter and entity-type filter are applied
 * client-side during layer reconstruction to preserve the observable
 * contract (deeper layers stay reachable through any intermediate).
 *
 * `relationshipTypes` is pushed to the server — the compiler emits it as
 * `-[r:TYPE1|TYPE2]-` which IS part of the prefix walk at every depth.
 */
function buildExploreSteps(
  depth: number,
  options: StorageExploreOptions,
): TraversalStep[] {
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
