// Neo4jStorageProvider — Neo4j implementation of @utaba/deep-memory's
// StorageProvider. CRUD methods are added incrementally; the `implements
// StorageProvider` declaration is added once the surface is complete.

import { randomUUID } from 'node:crypto';
import type {
  EnsureSchemaResult,
  EntityReadOptions,
  GraphTraversalCapabilities,
  RelationshipCreateOptions,
  VocabularyReadOptions,
} from '@utaba/deep-memory/providers';
import type {
  BulkImportOptions,
  BulkImportResult,
  DeleteProgressCallback,
  ExportChunk,
  ImportChunk,
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
  DuplicateRepositoryError,
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
  createEmptyVocabulary,
  createSafeSink,
  matchesPropertyFilters,
  projectEntity,
} from '@utaba/deep-memory';
import { Neo4jTraversalExecutor } from './Neo4jTraversalExecutor.js';
import type { RawTraversalResult } from './Neo4jTraversalExecutor.js';
import { Neo4jConnection, type CypherParams, type Neo4jConnectionConfig } from './Neo4jConnection.js';
import { mapDriverError, toTypedError } from './errors.js';
import {
  bigintToSafeNumber,
  repositoryCreateParams,
  repositoryFromRecord,
  repositorySummaryFromRecord,
  WRITE_ATTEMPT_PROPERTY,
} from './mapping.js';
import * as bulkQueries from './queries/bulk.js';
import * as entityQueries from './queries/entity.js';
import { resolveSearchScoring, type Neo4jSearchScoring } from './queries/entity.js';
import * as relationshipQueries from './queries/relationship.js';
import * as repositoryQueries from './queries/repository.js';
import {
  ENTITY_DRAIN_QUERY,
  RELATIONSHIP_DRAIN_QUERY,
  REPOSITORY_MARKER_EXISTS_QUERY,
} from './queries/repositoryDrain.js';
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
 * Most edges one relationship-drain statement buffers and deletes (see
 * `RELATIONSHIP_DRAIN_QUERY`). Twenty inner transactions' worth at
 * `DELETE_BATCH_SIZE`: enough that an ordinary batch of entities finishes in
 * one statement, small enough that a hub entity's edges cannot exhaust the
 * transaction memory limit.
 */
const DELETE_EDGE_CAP = 10_000;

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
  importBulk: (args) => args[0] as string,
  // `executeNativeQuery` is cross-repository by design. The first positional
  // argument is `repositoryId` for interface symmetry but is intentionally
  // not stamped on the sink record — the call is not scoped to one repository.
  executeNativeQuery: () => undefined,
  // `exportAll` is intentionally omitted from this map. The Proxy emits one
  // sink record at promise resolution; an `AsyncIterable` returns
  // synchronously and is consumed across an arbitrary number of awaits, so
  // a single emit at method-return would fire BEFORE any chunk had streamed
  // and the sink would carry zero round-trips. `exportAll` opens its own
  // usage scope via `trackIterable` and emits when the iterator drains.
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
   * record. Defaults to `false` — `PROFILE` records per-operator row counts
   * and db hits while the query runs, which more than doubles wall-clock on
   * short traversals, so the cost is worth paying only when an operator is
   * actively investigating planner behaviour.
   */
  profileTraversals?: boolean;
  /**
   * How `findEntities` orders the hits of a `searchTerm` query. Defaults to
   * `'relevance'`: full-text score, descending. The score's term statistics
   * are computed over every repository in the database, so in a store shared
   * by several tenants the order of one repository's hits can reflect how
   * common the search words are in other repositories. `'isolated'` orders
   * by `label`, then `id`, so nothing computed from other repositories
   * reaches the order. Either way matching runs against the whole index, so a
   * search's cost grows with the database; a database per tenant is the full
   * isolation option. See `Neo4jSearchScoring`.
   */
  searchScoring?: Neo4jSearchScoring;
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
  private readonly searchScoring: Neo4jSearchScoring;
  /**
   * In-process vocabulary cache. Reads hit this map first; writes inside this
   * process invalidate the entry so cache hits stay coherent with the local
   * write. Cross-process staleness is bounded by `VOCABULARY_CACHE_TTL_MS`.
   */
  private readonly vocabularyCache = new Map<
    string,
    { vocab: MemoryVocabulary; expiresAt: number }
  >();
  /**
   * Captured at construction so `exportAll`'s `trackIterable` can emit
   * outside the Proxy's promise-resolution path. The Proxy itself relies on
   * the same `safeSink` captured by closure; this field exists for the
   * streaming-iterator case only.
   */
  private readonly reportUsage: UsageSink | undefined;
  /**
   * Most edges one relationship-drain statement takes; see
   * `DELETE_EDGE_CAP`. Not configuration: a subclass lowers it only to drive
   * the repeat-at-cap path with a small repository.
   */
  protected readonly relationshipDrainEdgeCap: number = DELETE_EDGE_CAP;

  constructor(config: Neo4jStorageProviderConfig) {
    // Validated before the driver is created, so a refused config opens nothing.
    this.searchScoring = resolveSearchScoring(config.searchScoring);
    this.connection = new Neo4jConnection(config);
    this.traversalExecutor = new Neo4jTraversalExecutor(this.connection, {
      profileTraversals: config.profileTraversals === true,
    });

    const safeSink = createSafeSink(config.reportUsage);
    this.reportUsage = safeSink;
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
   *
   * Also repairs the `version` property on `_Vocabulary` nodes — missing on
   * nodes written by earlier releases, or stale where an earlier release
   * rewrote the blob — which compare-and-set in `saveVocabulary` depends on.
   * The repair runs on every call, including when the DDL is already up to
   * date, because it fixes data rather than schema and databases already at
   * the current schema version can still hold such nodes. It reads one node
   * per repository and writes only the inconsistent ones, so a database with
   * nothing to repair costs a single read.
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
      await vocabQueries.backfillVocabularyVersions(this.connection);
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
    await vocabQueries.backfillVocabularyVersions(this.connection);

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
   * The same statement creates the repository's `_Vocabulary` node, seeded
   * from `config.vocabulary` or an empty vocabulary. `saveVocabulary` only
   * ever updates that node, so this is where the first stored version comes
   * from; creating both in one statement means a repository never exists
   * without its vocabulary.
   *
   * Both nodes are created only when no `_Repository`, `_Vocabulary` or
   * `_Entity` node exists for the id:
   *
   *   - an existing `_Repository` → `DuplicateRepositoryError`;
   *   - a `_Vocabulary` or any `_Entity` with no `_Repository` →
   *     `ProviderError`. That state means a `deleteRepository` removed the
   *     marker but did not finish its chunked wipe; creating on top of it
   *     would leave two vocabularies or the old repository's data under the
   *     new one. Re-running `deleteRepository` finishes the wipe, and the
   *     message says so because tool surfaces may drop the suggestion. The
   *     entity check is an `EXISTS` subquery, which stops at the first match.
   *
   * Two concurrent creates can both pass the existence check; the
   * `(:_Repository) REQUIRE n.repositoryId IS UNIQUE` constraint then fails
   * the second with `Neo.ClientError.Schema.ConstraintValidationFailed`,
   * which `mapDriverError({ kind: 'repository', ... })` routes to
   * `DuplicateRepositoryError`, rolling back both of its nodes.
   *
   * The marker carries the call's write token. When the driver re-runs the
   * statement after a commit whose acknowledgement was lost, the re-run
   * finds that marker; its token being this call's proves the create
   * succeeded, so the call returns the repository instead of
   * `DuplicateRepositoryError`.
   */
  public async createRepository(config: StorageRepositoryConfig): Promise<StoredRepository> {
    const initialVocabulary = config.vocabulary ?? createEmptyVocabulary(config.createdBy);
    const writeAttempt = randomUUID();
    let alreadyExists = false;
    let createdByThisCall = false;
    let staleVocabularies = 0;
    let leftoverEntities = false;
    try {
      const result = await this.connection.executeQuery(
        `OPTIONAL MATCH (live:_Repository {repositoryId: $rid})
        OPTIONAL MATCH (stale:_Vocabulary {repositoryId: $rid})
        WITH live, count(stale) AS vocabularies
        WITH live, vocabularies,
          EXISTS { MATCH (:_Entity {repositoryId: $rid}) } AS leftoverEntities
        FOREACH (_ IN CASE WHEN live IS NULL AND vocabularies = 0 AND NOT leftoverEntities THEN [1] ELSE [] END |
          CREATE (:_Repository {
            repositoryId: $rid,
            type: $type,
            label: $label,
            description: $description,
            legal: $legal,
            owner: $owner,
            governanceConfig: $governanceConfig,
            metadata: $metadata,
            createdAt: $createdAt,
            createdBy: $createdBy,
            ${WRITE_ATTEMPT_PROPERTY}: $writeAttempt
          })
          CREATE (:_Vocabulary {
            repositoryId: $rid,
            vocabulary: $vocabularyJson,
            version: $vocabularyVersion
          })
        )
        RETURN live IS NOT NULL AS alreadyExists, live.${WRITE_ATTEMPT_PROPERTY} AS liveWriteAttempt,
          vocabularies, leftoverEntities`,
        {
          ...repositoryCreateParams(config),
          vocabularyJson: JSON.stringify(initialVocabulary),
          vocabularyVersion: initialVocabulary.version,
          writeAttempt,
        },
        { repositoryId: config.repositoryId },
      );
      const record = result.records[0];
      alreadyExists = record?.get('alreadyExists') === true;
      const storedWriteAttempt: unknown = record?.get('liveWriteAttempt');
      // The driver re-runs a statement whose commit acknowledgement was lost;
      // the re-run then finds the marker its own first run committed (and the
      // vocabulary seeded with it). The marker carrying this call's token
      // proves that, and the create succeeded.
      createdByThisCall = alreadyExists && storedWriteAttempt === writeAttempt;
      // `count()` is a Cypher INTEGER — a BigInt under `useBigInt: true`.
      staleVocabularies = bigintToSafeNumber(record?.get('vocabularies') ?? 0);
      leftoverEntities = record?.get('leftoverEntities') === true;
    } catch (err) {
      // A uniqueness refusal means another transaction committed the marker
      // after this statement's existence check. The marker carrying this
      // call's token would mean that transaction was this call's own first
      // run; every other refusal propagates as mapped. A concurrent
      // deleteRepository between the refusal and the read-back leaves no
      // marker to read, so the refusal stands.
      const refusal = toTypedError(err, {
        kind: 'repository',
        repositoryId: config.repositoryId,
        operation: 'createRepository',
      });
      if (
        !(refusal instanceof DuplicateRepositoryError) ||
        (await this.readRepositoryWriteAttempt(config.repositoryId)) !== writeAttempt
      ) {
        throw refusal;
      }
      createdByThisCall = true;
    }
    if (alreadyExists && !createdByThisCall) {
      throw new DuplicateRepositoryError(config.repositoryId);
    }
    if (!createdByThisCall && (staleVocabularies > 0 || leftoverEntities)) {
      throw new ProviderError(
        `Repository "${config.repositoryId}" still holds data from a delete that did not finish; call deleteRepository("${config.repositoryId}") to finish it, then create it again`,
        `Call deleteRepository("${config.repositoryId}") to finish the interrupted delete, then retry createRepository.`,
      );
    }
    // Drop any entry cached for an earlier repository with the same id that
    // another process deleted; the stored vocabulary is now the one just seeded.
    this.invalidateVocabularyCache(config.repositoryId);

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

  /**
   * The write token on the repository marker, or `null` when there is no
   * marker or it carries no token. Runs on the write route so it sees the
   * commit that refused the create.
   */
  private async readRepositoryWriteAttempt(repositoryId: string): Promise<string | null> {
    let result: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
    try {
      result = await this.connection.executeQuery(
        `MATCH (r:_Repository {repositoryId: $rid}) RETURN r.${WRITE_ATTEMPT_PROPERTY} AS writeAttempt`,
        {},
        { repositoryId },
      );
    } catch (err) {
      mapDriverError(err, { repositoryId, operation: 'createRepository' });
    }
    const value: unknown = result.records[0]?.get('writeAttempt');
    return typeof value === 'string' ? value : null;
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

    // listRepositories is cross-repository by definition (no sentinel
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
   * Variable-shape Cypher (repository writes are rare, so the plan-cache cost
   * of one statement shape per set of updated fields is negligible).
   * Projection-on-write returns the updated row in one round-trip;
   * empty-rowset → `RepositoryNotFoundError`.
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
   * `_Repository` node itself:
   *
   *   1. Delete the `_Repository` marker node in its own statement. The
   *      chunked wipe below spans many transactions, so the marker is what
   *      keeps new data out of it. Entity and relationship creates and bulk
   *      import chunks write-lock the marker in the same statement as their
   *      write and go on only while it still exists. Deleting the marker
   *      takes the same lock, so this step waits for any create already
   *      holding it to commit (the drains below then remove what it wrote),
   *      and every create after it fails with `RepositoryNotFoundError`. No
   *      create can commit after the drains.
   *   2. Drain relationships in batches via `CALL ( ) { ... } IN TRANSACTIONS`
   *      (`RELATIONSHIP_DRAIN_QUERY`, anchored on the repository's entities).
   *   3. Drain `_Entity` nodes in batches via the same form with
   *      `DETACH DELETE` (`ENTITY_DRAIN_QUERY`; catches any straggler edges).
   *   4. Drain `_VocabularyChangeLog` nodes in batches.
   *   5. Drain any other node carrying the `repositoryId`, excluding
   *      `_Repository` and `_Vocabulary`. `executeNativeQuery` can write
   *      nodes under any label; this sweep keeps the delete complete.
   *   6. Delete the `_Vocabulary` node last, in one statement guarded on the
   *      marker still being absent, so a repository re-created under the id
   *      in the meantime keeps its vocabulary.
   *
   * `_Entity`, `_VocabularyChangeLog` and `_Vocabulary` (plus the
   * `_Repository` marker) are the only node labels this provider writes with
   * a `repositoryId`, so they get labelled drains. After stage 1 no stage
   * matches a `_Repository`, and only the marker-guarded stage 6 matches a
   * `_Vocabulary`, so a concurrently re-created repository keeps its system
   * nodes.
   *
   * Because the vocabulary is deleted last, a `_Vocabulary` node with no
   * `_Repository` marker means a delete is in progress or was interrupted;
   * `createRepository` relies on that (together with leftover `_Entity`
   * nodes) and refuses to create over it. A retry after an interruption at
   * any point still finds something to delete and finishes the wipe. Only
   * when the marker and every drain removed nothing does the repository
   * count as missing: `RepositoryNotFoundError`.
   *
   * Stages 2 and 3 are app-side loops so the progress callback fires at a
   * useful cadence. Nothing counts the repository first: progress and the
   * returned counts are the running totals of the batches' update counters,
   * so no step reads the whole repository in one transaction.
   *
   * `IN TRANSACTIONS` can only run on auto-commit sessions — `executeWrite`
   * fails with `Neo.DatabaseError.Transaction.TransactionStartFailed`. The
   * chokepoint's `executeImplicitInTransactions` is the only legitimate entry
   * point for this pattern. A statement that fails surfaces as a typed error
   * through `mapDriverError`; the batches it already committed stay deleted,
   * and a re-run of the delete resumes from what is left.
   */
  public async deleteRepository(
    repositoryId: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const operation = 'deleteRepository';
    let marker: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
    try {
      marker = await this.connection.executeQuery(
        'MATCH (r:_Repository {repositoryId: $rid}) DETACH DELETE r',
        {},
        { repositoryId },
      );
    } catch (err) {
      mapDriverError(err, { repositoryId, operation });
    }
    // The cached vocabulary belongs to the repository being removed; a
    // repository later re-created under the same id must not be served it.
    this.invalidateVocabularyCache(repositoryId);
    // Raw count of everything this call removed, system nodes included —
    // zero means there was no repository to delete.
    let rawDeleted = marker.summary.counters.updates()['nodesDeleted'] ?? 0;

    const drained = await this.drainEntitiesAndRelationships(repositoryId, operation, onProgress);
    rawDeleted += drained.deletedEntities + drained.deletedRelationships;

    while (true) {
      const { summary } = await this.runDrainStatement(
        `CALL () {
           MATCH (n:_VocabularyChangeLog {repositoryId: $rid})
           WITH n LIMIT $batchSize
           DETACH DELETE n
         } IN TRANSACTIONS OF $batchSize ROWS`,
        // BigInt so the Cypher LIMIT clause sees a Cypher INTEGER, not FLOAT.
        { batchSize: BigInt(DELETE_BATCH_SIZE) },
        repositoryId,
        operation,
      );
      const deletedThisBatch = summary.counters.updates()['nodesDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      rawDeleted += deletedThisBatch;
    }

    // Anything else carrying this repositoryId — nodes written through
    // executeNativeQuery can have any label. The marker and the vocabulary
    // are excluded, so a repository re-created under this id in the meantime
    // keeps both. This pattern has no label to seek on, so each batch scans
    // every node in the database; it runs once per delete after the labelled
    // drains have removed the bulk of the data.
    while (true) {
      const { summary } = await this.runDrainStatement(
        `CALL () {
           MATCH (n {repositoryId: $rid})
           WHERE NOT n:_Repository AND NOT n:_Vocabulary
           WITH n LIMIT $batchSize
           DETACH DELETE n
         } IN TRANSACTIONS OF $batchSize ROWS`,
        // BigInt so the Cypher LIMIT clause sees a Cypher INTEGER, not FLOAT.
        { batchSize: BigInt(DELETE_BATCH_SIZE) },
        repositoryId,
        operation,
      );
      const deletedThisBatch = summary.counters.updates()['nodesDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      rawDeleted += deletedThisBatch;
    }

    // The vocabulary goes last and only while no marker exists: once it is
    // gone createRepository may run again, and a repository re-created under
    // this id must not lose its fresh vocabulary to a straggling delete.
    let vocabulary: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
    try {
      vocabulary = await this.connection.executeQuery(
        `MATCH (v:_Vocabulary {repositoryId: $rid})
         WHERE NOT EXISTS { MATCH (:_Repository {repositoryId: $rid}) }
         DETACH DELETE v`,
        {},
        { repositoryId },
      );
    } catch (err) {
      mapDriverError(err, { repositoryId, operation });
    }
    rawDeleted += vocabulary.summary.counters.updates()['nodesDeleted'] ?? 0;

    if (rawDeleted === 0) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    return drained;
  }

  /**
   * Drop every entity and relationship scoped to `repositoryId` but preserve
   * the `_Repository` and `_Vocabulary` / `_VocabularyChangeLog` system nodes.
   * Same chunked-wipe contract as `deleteRepository`, restricted to the
   * `:_Entity` umbrella label for nodes. A repository with no marker throws
   * `RepositoryNotFoundError`; the check is a seek of the marker's unique
   * constraint index, not a read of the repository's contents.
   */
  public async deleteAllContents(
    repositoryId: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const operation = 'deleteAllContents';
    let marker: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
    try {
      marker = await this.connection.executeQuery(REPOSITORY_MARKER_EXISTS_QUERY, {}, { repositoryId });
    } catch (err) {
      mapDriverError(err, { repositoryId, operation });
    }
    if (marker.records[0]?.get('repositoryExists') !== true) {
      this.invalidateVocabularyCache(repositoryId);
      throw new RepositoryNotFoundError(repositoryId);
    }
    return this.drainEntitiesAndRelationships(repositoryId, operation, onProgress);
  }

  /**
   * Drain the repository's relationships, then its entities, in batches
   * (`RELATIONSHIP_DRAIN_QUERY`, `ENTITY_DRAIN_QUERY`), reporting the running
   * counts after each batch that removed something and returning the totals
   * removed. The relationship drain is a keyset cursor over the repository's
   * entities: each batch returns the last entity id it visited, and the next
   * resumes after it once the batch's edges are gone, until no entity
   * remains past the cursor. A batch that took `relationshipDrainEdgeCap`
   * edges may have left more, so it runs again from the same cursor. The
   * counts come from each batch's update counters; edges the entity drain
   * detaches count as relationships.
   */
  private async drainEntitiesAndRelationships(
    repositoryId: string,
    operation: string,
    onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const batch = { batchSize: BigInt(DELETE_BATCH_SIZE) };
    const edgeCap = this.relationshipDrainEdgeCap;
    let relationshipsDeleted = 0;
    let entitiesDeleted = 0;

    let after = '';
    while (true) {
      const { records, summary } = await this.runDrainStatement(
        RELATIONSHIP_DRAIN_QUERY,
        { ...batch, edgeCap: BigInt(edgeCap), after },
        repositoryId,
        operation,
      );
      const deletedThisBatch = summary.counters.updates()['relationshipsDeleted'] ?? 0;
      if (deletedThisBatch > 0) {
        relationshipsDeleted += deletedThisBatch;
        await onProgress?.({ entitiesDeleted, relationshipsDeleted });
      }
      // At the cap, the batch's entities may still have edges: run it again.
      if (bigintToSafeNumber(records[0]?.get('edges') ?? 0n) >= edgeCap) continue;
      const lastId: unknown = records[0]?.get('lastId');
      if (typeof lastId !== 'string') break;
      after = lastId;
    }

    while (true) {
      const { summary } = await this.runDrainStatement(ENTITY_DRAIN_QUERY, batch, repositoryId, operation);
      const stats = summary.counters.updates();
      const deletedThisBatch = stats['nodesDeleted'] ?? 0;
      if (deletedThisBatch === 0) break;
      entitiesDeleted += deletedThisBatch;
      relationshipsDeleted += stats['relationshipsDeleted'] ?? 0;
      await onProgress?.({ entitiesDeleted, relationshipsDeleted });
    }

    return { deletedEntities: entitiesDeleted, deletedRelationships: relationshipsDeleted };
  }

  /**
   * Run one batched drain statement on an auto-commit session, raising a
   * driver failure as the project's typed error. The driver does not retry
   * these statements and neither does this method: the batches already
   * committed stay deleted, so a re-run of the delete picks up the rest.
   */
  private async runDrainStatement(
    cypher: string,
    params: CypherParams,
    repositoryId: string,
    operation: string,
  ): Promise<Awaited<ReturnType<Neo4jConnection['executeImplicitInTransactions']>>> {
    try {
      return await this.connection.executeImplicitInTransactions(cypher, params, { repositoryId });
    } catch (err) {
      mapDriverError(err, { repositoryId, operation });
    }
  }

  // ─── Vocabulary ────────────────────────────────────────────────────

  /**
   * Read the vocabulary for a repository. Cache-aware: cache hits return
   * synchronously with zero Bolt round-trips. The TRACKED_METHODS proxy still
   * fires for every call — the sink record on a cache hit carries
   * `details.calls === 0` and `value === 0`, which is the contract the sink
   * expects to express "this operation ran but did no server work".
   *
   * `{ fresh: true }` skips the cache lookup and always reads the stored
   * node (one round-trip). Callers about to modify the vocabulary need this:
   * the version they pass to `saveVocabulary` must be the stored one, and a
   * cached copy can be up to the TTL behind another process's write. The
   * fresh result replaces the cache entry so later cached reads see it too.
   *
   * A read that goes to the database throws `RepositoryNotFoundError` when
   * the repository marker is absent, and so does every other call here that
   * finds the marker gone; each drops the repository's cache entry as it
   * throws, and this provider's own `deleteRepository` drops it too. A cache
   * hit is not checked against the database: within the TTL it can still
   * return the vocabulary of a repository another process has deleted.
   * Closing that window would cost a round trip on every cached read, which
   * is what the cache exists to avoid; pass `{ fresh: true }` when the
   * answer must reflect the stored state.
   */
  public async getVocabulary(
    repositoryId: string,
    options?: VocabularyReadOptions,
  ): Promise<MemoryVocabulary> {
    if (options?.fresh === true) {
      const vocab = await this.forgetMissingRepository(repositoryId, () =>
        vocabQueries.getVocabulary(this.connection, repositoryId),
      );
      this.vocabularyCache.set(repositoryId, {
        vocab,
        expiresAt: Date.now() + VOCABULARY_CACHE_TTL_MS,
      });
      return vocab;
    }
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
    const vocab = await this.forgetMissingRepository(repositoryId, () =>
      vocabQueries.getVocabulary(this.connection, repositoryId),
    );
    this.vocabularyCache.set(repositoryId, {
      vocab,
      expiresAt: now + VOCABULARY_CACHE_TTL_MS,
    });
    return vocab;
  }

  /**
   * Drop the cache entry for a repository — call after every vocabulary
   * write, and whenever the repository turns out to be missing.
   */
  private invalidateVocabularyCache(repositoryId: string): void {
    this.vocabularyCache.delete(repositoryId);
  }

  /**
   * Run a repository-scoped call, dropping the repository's cached vocabulary
   * when the call reports the repository missing: the repository was
   * deleted, so a later cached read must go to the database (and throw)
   * rather than serve its old vocabulary.
   */
  private async forgetMissingRepository<T>(repositoryId: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (err) {
      if (err instanceof RepositoryNotFoundError) this.invalidateVocabularyCache(repositoryId);
      throw err;
    }
  }

  /**
   * Compare-and-set write of the vocabulary — lands only when the stored
   * version equals `expectedVersion`. Throws `VocabularyVersionConflictError`
   * on a mismatch and `RepositoryNotFoundError` when the repository's
   * vocabulary node does not exist; never creates the node.
   *
   * Invalidates the in-process cache on success, so subsequent reads observe
   * the new state immediately within this process, and on a conflict, because
   * the conflict proves the cached copy is stale (cross-process staleness is
   * otherwise bounded by the 60 s TTL).
   */
  public async saveVocabulary(
    repositoryId: string,
    vocabulary: MemoryVocabulary,
    expectedVersion: string,
  ): Promise<void> {
    try {
      await vocabQueries.saveVocabulary(this.connection, repositoryId, vocabulary, expectedVersion);
    } catch (err) {
      if (err instanceof VocabularyVersionConflictError || err instanceof RepositoryNotFoundError) {
        this.invalidateVocabularyCache(repositoryId);
      }
      throw err;
    }
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
   * requested — correctness wins over the marginal perf delta. The create is
   * guarded on the `_Repository` node in the same statement and throws
   * `RepositoryNotFoundError` once the repository is deleted.
   */
  public async createEntity(
    repositoryId: string,
    entity: StoredEntity,
  ): Promise<StoredEntity> {
    return this.forgetMissingRepository(repositoryId, () =>
      entityQueries.createEntity(this.connection, repositoryId, entity),
    );
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
   * Variable-shape projection-on-write update: one MATCH+SET+RETURN round
   * trip, at the cost of one statement shape per set of updated fields.
   * A missing repository marker → `RepositoryNotFoundError` (ahead of the
   * entity check); a missing entity → `EntityNotFoundError`.
   */
  public async updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity> {
    return this.forgetMissingRepository(repositoryId, () =>
      entityQueries.updateEntity(this.connection, repositoryId, entityId, updates),
    );
  }

  /**
   * Delete a single entity (and its incident relationships via `DETACH
   * DELETE`). Throws `RepositoryNotFoundError` when the repository marker is
   * absent, otherwise `EntityNotFoundError` when no entity has the id.
   */
  public async deleteEntity(
    repositoryId: string,
    entityId: string,
  ): Promise<void> {
    return this.forgetMissingRepository(repositoryId, () =>
      entityQueries.deleteEntity(this.connection, repositoryId, entityId),
    );
  }

  /**
   * Bulk delete by ids — single round-trip. Returns the ids actually
   * deleted; missing ids land in `notFound`. A missing repository marker →
   * `RepositoryNotFoundError`, and nothing is deleted.
   */
  public async deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    return this.forgetMissingRepository(repositoryId, () =>
      entityQueries.deleteEntities(this.connection, repositoryId, ids),
    );
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
   * order as `searchScoring` says (Lucene score descending by default, or
   * `label, id`); non-search queries order by `n.id` to pin pagination
   * determinism across slices.
   */
  public async findEntities(
    repositoryId: string,
    query: StorageFindQuery,
    options?: EntityReadOptions,
  ): Promise<PaginatedResult<StoredEntity>> {
    return entityQueries.findEntities(this.connection, repositoryId, query, options, this.searchScoring);
  }

  // ─── Relationships ─────────────────────────────────────────────────

  /**
   * Create a relationship. The statement write-locks the `_Repository` node,
   * then matches both endpoint entities under the repository scope before
   * the edge is created. The scope check lives in the statement itself, so
   * no caller can write a cross-repository edge, and nothing lands once the
   * repository is deleted. A missing repository surfaces as `RepositoryNotFoundError`;
   * a missing endpoint as `EntityNotFoundError` carrying the absent id; an
   * id already used by any relationship in the repository, whatever its
   * type, as `DuplicateRelationshipError`. That id check passes over every
   * edge of the repository, so it is skipped when `options.idMinted` says
   * the engine generated the id (see `buildCreateMintedRelationshipQuery`).
   */
  public async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
    options?: RelationshipCreateOptions,
  ): Promise<StoredRelationship> {
    return this.forgetMissingRepository(repositoryId, () =>
      relationshipQueries.createRelationship(this.connection, repositoryId, relationship, options?.idMinted === true),
    );
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

  /**
   * Drop a single relationship by id. A missing repository marker →
   * `RepositoryNotFoundError`; otherwise `RelationshipNotFoundError` when no
   * relationship has the id.
   */
  public async deleteRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<void> {
    return this.forgetMissingRepository(repositoryId, () =>
      relationshipQueries.deleteRelationship(this.connection, repositoryId, relationshipId),
    );
  }

  /**
   * Bulk drop by ids — single round-trip. Returns the ids actually deleted;
   * missing ids land in `notFound`. A missing repository marker →
   * `RepositoryNotFoundError`, and nothing is deleted.
   */
  public async deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    return this.forgetMissingRepository(repositoryId, () =>
      relationshipQueries.deleteRelationships(this.connection, repositoryId, ids),
    );
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
   * `OperationUsage` record. On a deleted repository it throws
   * `RepositoryNotFoundError` when the vocabulary cache is cold; within the
   * cache TTL it may answer as it does for a missing start entity.
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

    // The compiler emits projection-aware RETURN only when returnMode is
    // terminal (or default). On that path the raw result carries aggregations
    // and no entity rows — bypass the entity/path mapping entirely.
    //
    // `projection.includeEntities: true` is not supported alongside server-side
    // projection: a single grouped/distinct RETURN cannot also stream the
    // un-aggregated Node objects. Callers that need both should issue two
    // queries (one with projection, one without). The flag is documented as
    // returning a lightweight aggregation-only response on this backend.
    const aggregations = raw.aggregations;
    const projectionEmitted = aggregations !== undefined;

    if (projectionEmitted) {
      // entities / relationships / paths stay empty/undefined
    } else if (spec.returnMode === 'terminal') {
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
    if (projectionEmitted) {
      // Projection rows are the visible page — one row per group (count /
      // distinct) or per matched entity (values, non-distinct).
      total = aggregations!.length;
    } else if (spec.returnMode === 'path') {
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
      ...(aggregations !== undefined ? { aggregations } : {}),
      total,
      returned: total,
      hasMore: truncated,
      queryMetadata,
    };
  }

  /**
   * Lower-level compile + submit + parse helper. Fetches the cached
   * vocabulary once (so one call compiles against one vocabulary) and hands
   * it to the executor; the executor handles
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
      // Dedup connected entities per (relationship-type) bucket within a single
      // layer. The same entity can be reached via multiple stored edges of the
      // same type (e.g. a logically-bidirectional relationship modelled as two
      // directed half-edges) — count it once, not once per traversed edge.
      const layerBucketSeen = new Map<string, Set<string>>();

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

          const relType = rel.relationshipType;
          let bucketSeen = layerBucketSeen.get(relType);
          if (!bucketSeen) {
            bucketSeen = new Set<string>();
            layerBucketSeen.set(relType, bucketSeen);
          }
          if (bucketSeen.has(connectedId)) continue;
          bucketSeen.add(connectedId);

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
      // Enforce simple paths — no vertex appears twice. Cypher's variable-
      // length pattern emits every walk of length ≤ maxDepth, and the default
      // `DIFFERENT RELATIONSHIPS` match mode only prevents edge reuse; vertex
      // reuse is still allowed. Without this filter the walk
      //   source → … → target → other → target
      // counts as a valid path to the caller and inflates `totalPaths` with
      // detours that loop back through the destination.
      if (new Set(row.entityIds).size !== row.entityIds.length) continue;
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

  // ─── Bulk Operations ───────────────────────────────────────────────

  /**
   * Stream every entity and every relationship in the repository as
   * cursor-paginated chunks. Entities come first, then relationships; each
   * chunk carries a monotonic `sequence` and an `isLast` flag.
   *
   * The Proxy-based tracking flow does not apply here. Tracked methods emit
   * one sink record at promise resolution; an `AsyncIterable` returns
   * synchronously, before any chunk has streamed. Instead, `trackIterable`
   * wraps the underlying generator in its own `UsageScope` that opens at
   * iterator creation, records each round-trip as the consumer pulls the
   * next chunk, and emits one sink record when the iterator drains — so the
   * resulting record aggregates server time across every chunk fetch.
   */
  public exportAll(repositoryId: string): AsyncIterable<ExportChunk> {
    return this.trackIterable(
      'exportAll',
      repositoryId,
      bulkQueries.exportAll(this.connection, repositoryId),
    );
  }

  /**
   * Run a bulk import: every entity then every relationship from the input
   * chunks lands in the repository. `skipExistenceCheck: true` is the insert
   * path: entities are CREATEd and relationships are MERGEd on their id
   * together with the chunk statement's write token, so a driver re-run
   * matches the edge its first run wrote while an edge from any other call
   * never matches; `false` (default) MERGEs on the id for idempotent
   * re-imports.
   *
   * Returns a single aggregate `BulkImportResult` spanning every chunk.
   * Per-row failures land in `result.errors`; surviving rows still count
   * toward `entitiesImported` / `relationshipsImported`.
   */
  public async importBulk(
    repositoryId: string,
    data: ImportChunk[],
    options?: BulkImportOptions,
  ): Promise<BulkImportResult> {
    return this.forgetMissingRepository(repositoryId, () =>
      bulkQueries.importBulk(this.connection, repositoryId, data, options),
    );
  }

  /**
   * Wrap an `AsyncIterable` so every chunk it produces is generated inside a
   * single shared `UsageScope`. The scope aggregates `summary.resultConsumedAfter`
   * across every round-trip the iterator performs; one sink record fires when
   * the iterator drains (or is closed / thrown into).
   *
   * Implementation mirrors the Cosmos `trackIterable` precedent: each
   * `iter.next()` call re-enters the scope via `runInUsageScope`. The
   * `AsyncLocalStorage` chain links async work performed inside the
   * generator body to the scope for the duration of that step. Between
   * `next()` calls the scope is dormant — the consumer's awaits do not
   * accumulate into it, which is exactly the desired semantics.
   *
   * When the sink is absent the wrap degenerates to a pass-through; the
   * Proxy's `createSafeSink` short-circuit covers the no-sink case at
   * construction time, so this method is only reached when `reportUsage` is
   * present.
   */
  private trackIterable<T>(
    operation: string,
    repositoryId: string,
    source: AsyncIterable<T>,
  ): AsyncIterable<T> {
    // The sink may be undefined when the provider was constructed without
    // `reportUsage`; the Proxy is then absent and this method is reached
    // directly. Pass-through in that case so the streaming consumer pays no
    // wrapper overhead.
    const sink = this.reportUsage;
    if (sink === undefined) return source;
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<T> => {
        const iter = source[Symbol.asyncIterator]();
        const scope = createUsageScope();
        let emitted = false;
        const emit = (): void => {
          if (emitted) return;
          emitted = true;
          sink({
            provider: PROVIDER_NAME,
            operation,
            unit: 'server_ms',
            value: scope.serverMs,
            repositoryId,
            timestamp: new Date(),
            details: buildUsageDetails(scope),
          });
        };
        return {
          async next(): Promise<IteratorResult<T>> {
            const step = await runInUsageScope(scope, () => iter.next());
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
    return this.forgetMissingRepository(repositoryId, () =>
      repositoryQueries.getRepositoryStats(this.connection, repositoryId, vocabulary),
    );
  }

  // ─── Native Query ──────────────────────────────────────────────────

  /**
   * Execute a raw Cypher statement with caller-supplied bindings.
   *
   * ⚠️  ELEVATED PRIVILEGE — SYSTEM-LEVEL OPERATION ⚠️
   *
   * This method is an unscoped pass-through: it does not filter by
   * repository, does not inject the `$rid` binding, and performs no
   * validation on the Cypher string. A single call can read or mutate any
   * node or relationship in the database regardless of which repository it
   * belongs to.
   *
   * DO NOT expose this method to AI agents, end users, or any untrusted
   * caller. It is intended for:
   *   - administrative tooling (migrations, diagnostics, repairs)
   *   - internal library operations that need cross-repository reach
   *
   * `repositoryId` is accepted for interface symmetry but is intentionally
   * ignored here — the caller is trusted to scope the query themselves.
   * Because the call is cross-repository by design, the emitted usage
   * record carries no `repositoryId` (see `TRACKED_METHODS`).
   *
   * For agent-facing graph queries use {@link traverse}, which enforces the
   * repositoryId scope predicate.
   */
  public async executeNativeQuery(
    _repositoryId: string,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]> {
    const result = await this.connection.executeSystemQuery(query, params ?? {}, {
      crossRepository: true,
    });
    // Each driver `Record` is mapped to a plain object keyed by RETURN /
    // YIELD column name. Driver-specific value shapes (Node, Relationship,
    // BigInt) flow through untouched — admin tooling is responsible for
    // interpreting them.
    return result.records.map((record) => record.toObject());
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
