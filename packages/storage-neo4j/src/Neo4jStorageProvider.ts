// Neo4jStorageProvider — Neo4j implementation of @utaba/deep-memory's
// StorageProvider. CRUD methods are added incrementally; the `implements
// StorageProvider` declaration is added once the surface is complete.

import type { EnsureSchemaResult, EntityReadOptions } from '@utaba/deep-memory/providers';
import type {
  DeleteProgressCallback,
  MemoryVocabulary,
  PaginatedResult,
  PaginationOptions,
  RepositoryFilter,
  RepositoryUpdate,
  StorageRepositoryConfig,
  StoredEntity,
  StoredEntityUpdate,
  StoredRepository,
  StoredRepositorySummary,
  UsageSink,
  VocabularyChangeRecord,
} from '@utaba/deep-memory/types';
import {
  ProviderError,
  RepositoryNotFoundError,
  createSafeSink,
} from '@utaba/deep-memory';
import { Neo4jConnection, type Neo4jConnectionConfig } from './Neo4jConnection.js';
import { mapDriverError } from './errors.js';
import {
  bigintToSafeNumber,
  repositoryCreateParams,
  repositoryFromRecord,
  repositorySummaryFromRecord,
} from './mapping.js';
import * as entityQueries from './queries/entity.js';
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
}

/**
 * Schema-version row stored on the singleton `_Meta` node. Written by
 * `ensureSchema` and only read by `ensureSchema` — no other code path
 * touches it.
 */
const META_KEY = 'schema';

export class Neo4jStorageProvider {
  private readonly connection: Neo4jConnection;
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
   * Create a new entity. Strategy A (`CREATE` + catch constraint violation)
   * per probe P4 — `MERGE`-with-discriminator is marginally faster on the
   * happy path but mutates the existing node on collisions, polluting the
   * durable graph with a discriminator property.
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
}
