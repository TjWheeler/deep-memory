// SqlServerStorageProvider — SQL Server implementation of StorageProvider

import sql from 'mssql';
import type { IRecordSet, IResult } from 'mssql';
import type {
  StorageProvider,
  EnsureSchemaResult,
  EntityReadOptions,
  RelationshipCreateOptions,
  VocabularyReadOptions,
} from '@utaba/deep-memory/providers';
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
  StorageTimelineEvent,
  BulkImportResult,
  UsageSink,
} from '@utaba/deep-memory/types';
import type {
  BulkImportOptions,
  DeleteProgressCallback,
  ExportChunk,
  ImportChunk,
  ProvenanceFilter,
} from '@utaba/deep-memory/types';
import type { Provenance } from '@utaba/deep-memory/types';
import {
  DeepMemoryError,
  RepositoryNotFoundError,
  DuplicateRepositoryError,
  EntityNotFoundError,
  DuplicateEntityError,
  RelationshipNotFoundError,
  DuplicateRelationshipError,
  ProviderError,
  VocabularyVersionConflictError,
  createEmptyVocabulary,
  matchesPropertyFilters,
  createSafeSink,
} from '@utaba/deep-memory';
import { getSchemaSQL, SCHEMA_VERSION } from './schema.js';
import {
  importFailure,
  isForeignKeyViolation,
  mapUniqueViolation,
  type ImportRow,
  type UniqueViolationContext,
} from './errors.js';

const PROVIDER_NAME = 'sqlserver';

/**
 * Rejection handler for a create's INSERT or an entity UPDATE: a unique-key
 * violation (a concurrent writer took the key after the existence check, or
 * an update moved onto a slug another entity holds) becomes its typed error
 * with the SQL Server error as `cause`; anything else propagates unchanged.
 */
function rethrowUniqueViolation(context: UniqueViolationContext): (err: unknown) => never {
  return (err: unknown): never => {
    throw mapUniqueViolation(err, context) ?? err;
  };
}

/** What a relationship create needs to exist (or not) before its INSERT. */
interface RelationshipCreatePreconditions {
  repositoryExists: boolean;
  relationshipExists: boolean;
  sourceExists: boolean;
  targetExists: boolean;
}

/** Throw `EntityNotFoundError` for the source, then the target, when missing. */
function throwForMissingEndpoint(
  preconditions: RelationshipCreatePreconditions,
  relationship: StoredRelationship,
): void {
  if (!preconditions.sourceExists) throw new EntityNotFoundError(relationship.sourceEntityId);
  if (!preconditions.targetExists) throw new EntityNotFoundError(relationship.targetEntityId);
}

/**
 * Public StorageProvider methods that are tracked for usage reporting.
 * The key is the method name; the value extracts the repositoryId from the
 * method's argument list (returning undefined when the operation is not
 * scoped to a single repository).
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
  getRepositoryStats: (args) => args[0] as string,
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
  exploreNeighborhood: (args) => args[0] as string,
  findPaths: (args) => args[0] as string,
  getTimeline: (args) => args[0] as string,
  importBulk: (args) => args[0] as string,
};

/** Configuration for SqlServerStorageProvider */
export interface SqlServerStorageProviderConfig {
  /** mssql connection config or an existing connection pool */
  connection: sql.config | sql.ConnectionPool;
  /** SQL Server schema name (default: 'dbo') */
  schema?: string;
  /**
   * Optional usage sink. When provided, the provider emits one
   * {@link OperationUsage} record per public method call reporting
   * wall-clock execution time in milliseconds. Never exposed to AI agents.
   */
  reportUsage?: UsageSink;
}

// ─── Column projection constants ───────────────────────────────────

/** All entity columns except embedding — used by graph traversal, timeline, etc. */
const ENTITY_COLS_LIGHT = [
  'entity_id', 'slug', 'repository_id', 'entity_type', 'label', 'summary',
  'properties', 'data', 'data_format',
  'created_by', 'created_by_type', 'created_at',
  'created_in_conversation', 'created_from_message',
  'modified_by', 'modified_by_type', 'modified_at',
  'modified_in_conversation', 'modified_from_message',
].map(c => `[${c}]`).join(', ');

/** All entity columns including embedding — used by getEntity, getEntities, exportAll */
const ENTITY_COLS_FULL = `${ENTITY_COLS_LIGHT}, [embedding]`;

/** The row a batch headed by `repositoryCheckSql` returns first. */
interface RepositoryCheckRow {
  repository_exists: number;
}

/** The calls that read entities through `readEntitiesGuarded`. */
type GuardedEntityReadOperation =
  | 'getEntity'
  | 'getEntityBySlug'
  | 'getEntities'
  | 'exploreNeighborhood'
  | 'findPaths'
  | 'getTimeline';

/** The calls that act on a repository check row (`assertRepositoryChecked`). */
type RepositoryCheckedOperation =
  | GuardedEntityReadOperation
  | 'findEntities'
  | 'getRelationship'
  | 'getEntityRelationships'
  | 'getVocabularyChangeLog'
  | 'exportAll'
  | 'deleteEntities'
  | 'deleteRelationships';

// ─── Row-mapping helpers ────────────────────────────────────────────

function provenanceFromRow(row: sql.IRecordSet<unknown>[number]): Provenance {
  const r = row as Record<string, unknown>;
  return {
    createdBy: r['created_by'] as string,
    createdByType: r['created_by_type'] as 'user' | 'agent',
    createdAt: r['created_at'] as string,
    createdInConversation: (r['created_in_conversation'] as string) || undefined,
    createdFromMessage: (r['created_from_message'] as string) || undefined,
    modifiedBy: r['modified_by'] as string,
    modifiedByType: r['modified_by_type'] as 'user' | 'agent',
    modifiedAt: r['modified_at'] as string,
    modifiedInConversation: (r['modified_in_conversation'] as string) || undefined,
    modifiedFromMessage: (r['modified_from_message'] as string) || undefined,
  };
}

/** Add provenance filter conditions to a SQL query. */
function addProvenanceConditions(
  req: sql.Request,
  prov: ProvenanceFilter,
  conditions: string[],
): void {
  if (prov.conversationIds && prov.conversationIds.length > 0) {
    const placeholders = prov.conversationIds.map((id, i) => {
      req.input(`provConvId${i}`, sql.NVarChar, id);
      return `@provConvId${i}`;
    });
    const inClause = placeholders.join(',');
    conditions.push(`([created_in_conversation] IN (${inClause}) OR [modified_in_conversation] IN (${inClause}))`);
  }
  if (prov.actors && prov.actors.length > 0) {
    const placeholders = prov.actors.map((a, i) => {
      req.input(`provActor${i}`, sql.NVarChar, a);
      return `@provActor${i}`;
    });
    const inClause = placeholders.join(',');
    conditions.push(`([created_by] IN (${inClause}) OR [modified_by] IN (${inClause}))`);
  }
  if (prov.dateRange) {
    req.input('provDateFrom', sql.NVarChar, prov.dateRange.from);
    req.input('provDateTo', sql.NVarChar, prov.dateRange.to);
    conditions.push('([created_at] >= @provDateFrom AND [created_at] <= @provDateTo) OR ([modified_at] >= @provDateFrom AND [modified_at] <= @provDateTo)');
  }
}

function entityFromRow(row: sql.IRecordSet<unknown>[number]): StoredEntity {
  const r = row as Record<string, unknown>;
  return {
    id: r['entity_id'] as string,
    slug: r['slug'] as string,
    entityType: r['entity_type'] as string,
    label: r['label'] as string,
    summary: (r['summary'] as string) || undefined,
    properties: JSON.parse((r['properties'] as string) || '{}') as Record<string, unknown>,
    data: (r['data'] as string) || undefined,
    dataFormat: (r['data_format'] as string) || undefined,
    provenance: provenanceFromRow(row),
    embedding: ('embedding' in r && r['embedding']) ? (JSON.parse(r['embedding'] as string) as number[]) : undefined,
  };
}

function relationshipFromRow(row: sql.IRecordSet<unknown>[number]): StoredRelationship {
  const r = row as Record<string, unknown>;
  return {
    id: r['relationship_id'] as string,
    relationshipType: r['relationship_type'] as string,
    sourceEntityId: r['source_entity_id'] as string,
    targetEntityId: r['target_entity_id'] as string,
    properties: JSON.parse((r['properties'] as string) || '{}') as Record<string, unknown>,
    bidirectional: r['bidirectional'] === true || r['bidirectional'] === 1,
    provenance: provenanceFromRow(row),
  };
}

function changeRecordFromRow(row: sql.IRecordSet<unknown>[number]): VocabularyChangeRecord {
  const r = row as Record<string, unknown>;
  return {
    changeId: r['change_id'] as string,
    changeType: r['change_type'] as VocabularyChangeRecord['changeType'],
    typeName: r['type_name'] as string,
    previousVersion: (r['previous_version'] as string) || undefined,
    newVersion: r['new_version'] as string,
    proposedBy: r['proposed_by'] as string,
    proposedAt: r['proposed_at'] as string,
    approvedBy: (r['approved_by'] as string) || undefined,
    approvedAt: (r['approved_at'] as string) || undefined,
    reason: r['reason'] as string,
  };
}

// ─── Provider ───────────────────────────────────────────────────────

export class SqlServerStorageProvider implements StorageProvider {
  private pool: sql.ConnectionPool | null = null;
  private ownsPool: boolean;
  private readonly config: SqlServerStorageProviderConfig;
  private readonly schema: string;

  constructor(config: SqlServerStorageProviderConfig) {
    this.config = config;
    this.schema = config.schema ?? 'dbo';
    this.ownsPool = !(config.connection instanceof sql.ConnectionPool);

    const safeSink = createSafeSink(config.reportUsage);
    if (safeSink) {
      // Wrap the instance in a Proxy that times every tracked public method
      // and emits a single OperationUsage record per call. Internal calls
      // reach methods via the raw target (not the proxy), so nested methods
      // don't double-count — the outer method owns the emission.
      // eslint-disable-next-line no-constructor-return
      return new Proxy(this, {
        get(target, prop, receiver): unknown {
          const value = Reflect.get(target, prop, receiver);
          if (typeof prop !== 'string' || typeof value !== 'function') return value;
          const extractRepoId = TRACKED_METHODS[prop];
          if (!extractRepoId) return value;
          const method = value as (...a: unknown[]) => unknown;
          return (...args: unknown[]): unknown => {
            const start = Date.now();
            const repositoryId = extractRepoId(args);
            const emit = (): void => {
              safeSink({
                provider: PROVIDER_NAME,
                operation: prop,
                unit: 'ms',
                value: Date.now() - start,
                ...(repositoryId ? { repositoryId } : {}),
                timestamp: new Date(),
              });
            };
            let result: unknown;
            try {
              result = method.apply(target, args);
            } catch (err) {
              emit();
              throw err;
            }
            if (result && typeof (result as { then?: unknown }).then === 'function') {
              return (result as Promise<unknown>).then(
                (v) => { emit(); return v; },
                (err) => { emit(); throw err; },
              );
            }
            emit();
            return result;
          };
        },
      });
    }
  }

  private t(table: string): string {
    return `[${this.schema}].[${table}]`;
  }

  private getPool(): sql.ConnectionPool {
    if (!this.pool) {
      throw new ProviderError(
        'SqlServerStorageProvider not initialized. Call initialize() first.',
      );
    }
    return this.pool;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.config.connection instanceof sql.ConnectionPool) {
      this.pool = this.config.connection;
      this.ownsPool = false;
      if (!this.pool.connected) {
        await this.pool.connect();
      }
    } else {
      this.pool = new sql.ConnectionPool(this.config.connection);
      this.ownsPool = true;
      await this.pool.connect();
    }

  }

  async dispose(): Promise<void> {
    if (this.ownsPool && this.pool) {
      await this.pool.close();
    }
    this.pool = null;
  }

  /**
   * Ensure the target database exists. If constructed with a sql.config and the
   * database does not yet exist, creates it via a temporary connection to master,
   * then (re)connects the main pool to the newly created database.
   *
   * @returns true if the database was created, false if it already existed.
   */
  private async ensureDatabase(): Promise<boolean> {
    // Only possible when we own the pool and have the raw config
    if (this.config.connection instanceof sql.ConnectionPool) {
      return false; // Pre-existing pool — caller is responsible for DB existence
    }

    const cfg = this.config.connection;
    const dbName = cfg.database;
    if (!dbName) {
      return false; // No database specified — nothing to create
    }

    let created = false;

    // Connect to master to check / create the database
    const masterPool = new sql.ConnectionPool({ ...cfg, database: 'master' });
    try {
      await masterPool.connect();
      const result = await masterPool.request()
        .input('dbName', sql.NVarChar, dbName)
        .query<{ cnt: number }>(
          `SELECT COUNT(*) AS cnt FROM sys.databases WHERE name = @dbName`,
        );
      const exists = (result.recordset[0]?.cnt ?? 0) > 0;

      if (!exists) {
        // Database names cannot be parameterized — validate to prevent injection
        if (!/^[A-Za-z0-9_-]+$/.test(dbName)) {
          throw new ProviderError(
            `Invalid database name '${dbName}'. Only alphanumeric characters, hyphens, and underscores are allowed.`,
          );
        }
        await masterPool.request().query(`CREATE DATABASE [${dbName}]`);
        created = true;
      }
    } finally {
      await masterPool.close();
    }

    // If the main pool isn't connected yet (initialize failed because the DB
    // didn't exist), connect it now that the database exists.
    if (!this.pool || !this.pool.connected) {
      this.pool = new sql.ConnectionPool(cfg);
      this.ownsPool = true;
      await this.pool.connect();
    }

    return created;
  }

  async ensureSchema(): Promise<EnsureSchemaResult> {
    // If constructed with a sql.config (not a pre-existing pool), ensure the
    // target database exists before attempting any schema operations.
    const databaseCreated = await this.ensureDatabase();

    const pool = this.getPool();

    // Check if meta table exists to detect existing schema
    const metaCheck = await pool.request().query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM sys.tables WHERE name = 'dm_meta' AND schema_id = SCHEMA_ID('${this.schema}')`,
    );
    const metaExists = (metaCheck.recordset[0]?.cnt ?? 0) > 0;

    if (metaExists) {
      // Check version
      const versionResult = await pool.request().query<{ value: string }>(
        `SELECT [value] FROM ${this.t('dm_meta')} WHERE [key] = 'schema_version'`,
      );
      const currentVersion = parseInt(versionResult.recordset[0]?.value ?? '0', 10);
      if (currentVersion > SCHEMA_VERSION) {
        throw new ProviderError(
          `Database schema version ${currentVersion} is newer than provider version ${SCHEMA_VERSION}. Update the provider package.`,
        );
      }
      if (currentVersion === SCHEMA_VERSION) {
        return {
          databaseCreated,
          schemaCreated: false,
          alreadyUpToDate: !databaseCreated,
          schemaVersion: SCHEMA_VERSION,
        };
      }
      // Future: run migrations from currentVersion to SCHEMA_VERSION
    }

    // Create all tables (IF NOT EXISTS guards in the SQL handle idempotency)
    const ddl = getSchemaSQL(this.schema);
    // Split on blank-line boundaries (double newline) to keep BEGIN...END blocks intact
    const statements = ddl
      .split(/\n\n+/)
      .map((s) => s.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n').trim())
      .filter((s) => s.length > 0);
    for (const stmt of statements) {
      try {
        await pool.request().query(stmt);
      } catch (err) {
        // Ignore "already exists" errors for indexes (they lack IF NOT EXISTS)
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('already exists')) {
          throw new ProviderError(`Schema creation failed: ${msg}`);
        }
      }
    }

    return {
      databaseCreated,
      schemaCreated: true,
      alreadyUpToDate: false,
      schemaVersion: SCHEMA_VERSION,
    };
  }

  // ─── Repository ──────────────────────────────────────────────────

  public async createRepository(config: StorageRepositoryConfig): Promise<StoredRepository> {
    const pool = this.getPool();

    // Check for duplicate
    const existing = await pool.request()
      .input('id', sql.UniqueIdentifier, config.repositoryId)
      .query<{ repository_id: string }>(
        `SELECT [repository_id] FROM ${this.t('dm_repositories')} WHERE [repository_id] = @id`,
      );

    if (existing.recordset.length > 0) {
      throw new DuplicateRepositoryError(config.repositoryId);
    }

    await pool.request()
      .input('id', sql.UniqueIdentifier, config.repositoryId)
      .input('type', sql.NVarChar, config.type ?? null)
      .input('label', sql.NVarChar, config.label)
      .input('description', sql.NVarChar, config.description ?? null)
      .input('legal', sql.NVarChar, config.legal ?? null)
      .input('owner', sql.NVarChar, config.owner ?? null)
      .input('governanceConfig', sql.NVarChar, JSON.stringify(config.governanceConfig))
      .input('metadata', sql.NVarChar, config.metadata ? JSON.stringify(config.metadata) : null)
      .input('createdAt', sql.NVarChar, config.createdAt)
      .input('createdBy', sql.NVarChar, config.createdBy)
      .query(`
        INSERT INTO ${this.t('dm_repositories')}
          ([repository_id], [type], [label], [description], [legal], [owner], [governance_config], [metadata], [created_at], [created_by])
        VALUES (@id, @type, @label, @description, @legal, @owner, @governanceConfig, @metadata, @createdAt, @createdBy)
      `)
      .catch(rethrowUniqueViolation({ kind: 'repository', repositoryId: config.repositoryId }));

    // Seed the repository's only vocabulary row. saveVocabulary never inserts,
    // so this is where the first stored version comes from.
    const initialVocabulary = config.vocabulary ?? createEmptyVocabulary(config.createdBy);

    await pool.request()
      .input('id', sql.UniqueIdentifier, config.repositoryId)
      .input('vocabulary', sql.NVarChar, JSON.stringify(initialVocabulary))
      .query(`
        INSERT INTO ${this.t('dm_vocabularies')} ([repository_id], [vocabulary])
        VALUES (@id, @vocabulary)
      `);

    return {
      repositoryId: config.repositoryId,
      type: config.type,
      label: config.label,
      description: config.description,
      legal: config.legal,
      owner: config.owner,
      governanceConfig: config.governanceConfig,
      metadata: config.metadata,
      createdAt: config.createdAt,
      createdBy: config.createdBy,
    };
  }

  async getRepository(repositoryId: string): Promise<StoredRepository | null> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query<Record<string, unknown>>(
        `SELECT * FROM ${this.t('dm_repositories')} WHERE [repository_id] = @id`,
      );

    const row = result.recordset[0];
    if (!row) return null;

    const metadataRaw = row['metadata'] as string | null;
    return {
      repositoryId: row['repository_id'] as string,
      type: (row['type'] as string) || undefined,
      label: row['label'] as string,
      description: (row['description'] as string) || undefined,
      legal: (row['legal'] as string) || undefined,
      owner: (row['owner'] as string) || undefined,
      governanceConfig: JSON.parse(row['governance_config'] as string) as StoredRepository['governanceConfig'],
      metadata: metadataRaw ? JSON.parse(metadataRaw) as StoredRepository['metadata'] : undefined,
      createdAt: row['created_at'] as string,
      createdBy: row['created_by'] as string,
    };
  }

  async listRepositories(
    filter?: RepositoryFilter,
  ): Promise<PaginatedResult<StoredRepositorySummary>> {
    const pool = this.getPool();
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 20;

    const countReq = pool.request();
    const dataReq = pool.request();

    let where = '';
    if (filter?.type) {
      countReq.input('type', sql.NVarChar, filter.type);
      dataReq.input('type', sql.NVarChar, filter.type);
      where = 'WHERE [type] = @type';
    }

    // Get total count
    const countResult = await countReq.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS [cnt] FROM ${this.t('dm_repositories')} ${where}`,
    );
    const total = (countResult.recordset[0]?.['cnt'] as number) ?? 0;

    // Fetch paginated results
    dataReq.input('offset', sql.Int, offset);
    dataReq.input('limit', sql.Int, limit);

    const result = await dataReq.query<Record<string, unknown>>(
      `SELECT [repository_id], [type], [label], [description], [governance_config]
       FROM ${this.t('dm_repositories')} ${where}
       ORDER BY [label]
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    );

    const items: StoredRepositorySummary[] = result.recordset.map((row) => ({
      repositoryId: row['repository_id'] as string,
      type: (row['type'] as string) || undefined,
      label: row['label'] as string,
      description: (row['description'] as string) || undefined,
      governanceConfig: JSON.parse(row['governance_config'] as string) as StoredRepository['governanceConfig'],
    }));

    return {
      items,
      total,
      hasMore: offset + items.length < total,
      limit,
      offset,
    };
  }

  async updateRepository(repositoryId: string, updates: RepositoryUpdate): Promise<StoredRepository> {
    const pool = this.getPool();

    // Build dynamic SET clause from provided fields
    const setClauses: string[] = [];
    const request = pool.request().input('id', sql.UniqueIdentifier, repositoryId);

    if (updates.label !== undefined) {
      setClauses.push('[label] = @label');
      request.input('label', sql.NVarChar, updates.label);
    }
    if (updates.description !== undefined) {
      setClauses.push('[description] = @description');
      request.input('description', sql.NVarChar, updates.description);
    }
    if (updates.type !== undefined) {
      setClauses.push('[type] = @type');
      request.input('type', sql.NVarChar, updates.type);
    }
    if (updates.legal !== undefined) {
      setClauses.push('[legal] = @legal');
      request.input('legal', sql.NVarChar, updates.legal);
    }
    if (updates.owner !== undefined) {
      setClauses.push('[owner] = @owner');
      request.input('owner', sql.NVarChar, updates.owner);
    }
    if (updates.governanceConfig !== undefined) {
      setClauses.push('[governance_config] = @governanceConfig');
      request.input('governanceConfig', sql.NVarChar, JSON.stringify(updates.governanceConfig));
    }
    if (updates.metadata !== undefined) {
      // Shallow merge with existing metadata
      const existing = await this.getRepository(repositoryId);
      if (!existing) throw new RepositoryNotFoundError(repositoryId);
      const merged = { ...existing.metadata, ...updates.metadata };
      setClauses.push('[metadata] = @metadata');
      request.input('metadata', sql.NVarChar, JSON.stringify(merged));
    }

    if (setClauses.length === 0) {
      const existing = await this.getRepository(repositoryId);
      if (!existing) throw new RepositoryNotFoundError(repositoryId);
      return existing;
    }

    const result = await request.query(
      `UPDATE ${this.t('dm_repositories')} SET ${setClauses.join(', ')} WHERE [repository_id] = @id`,
    );

    if (result.rowsAffected[0] === 0) {
      throw new RepositoryNotFoundError(repositoryId);
    }

    const updated = await this.getRepository(repositoryId);
    if (!updated) throw new RepositoryNotFoundError(repositoryId);
    return updated;
  }

  /**
   * Delete the repository row and everything under it in one transaction.
   * The repository row is locked first, so a missing repository rolls back
   * before anything else is touched. Relationships and entities are then
   * deleted explicitly, ahead of the repository row whose `ON DELETE
   * CASCADE` covers the rest (vocabulary, change log), so the call can
   * report how many of each it removed without counting first. A missing
   * repository throws `RepositoryNotFoundError`. The delete is one statement
   * batch, so `onProgress` is not called.
   *
   * Creates take no lock on the repository row of their own. A create whose
   * INSERT runs while the delete holds that row can lock its new row first
   * and then wait on the row for its foreign-key check, while the delete
   * waits on the new row: a deadlock (error 1205). The batch runs at
   * `DEADLOCK_PRIORITY HIGH` so SQL Server picks the create as the victim
   * and the delete completes; the create fails, and a retry of it finds the
   * repository gone.
   */
  public async deleteRepository(
    repositoryId: string,
    _onProgress?: DeleteProgressCallback,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const pool = this.getPool();
    let counts: { relationships: number; entities: number; repositories: number } | undefined;
    try {
      // A parameterised query runs through sp_executesql, so the SET options
      // apply to this request only and revert when the batch ends; they do
      // not carry over to the pooled connection. With XACT_ABORT on, any
      // error in the batch rolls the whole transaction back.
      const result = await pool.request()
        .input('id', sql.UniqueIdentifier, repositoryId)
        .query<{ relationships: number; entities: number; repositories: number }>(`
          SET XACT_ABORT ON;
          SET DEADLOCK_PRIORITY HIGH;
          DECLARE @relationships INT = 0, @entities INT = 0, @repositories INT = 0;
          BEGIN TRANSACTION;
          SELECT @repositories = 1
            FROM ${this.t('dm_repositories')} WITH (XLOCK, HOLDLOCK, ROWLOCK)
            WHERE [repository_id] = @id;
          IF @repositories = 0
            ROLLBACK TRANSACTION;
          ELSE
          BEGIN
            DELETE FROM ${this.t('dm_relationships')} WHERE [repository_id] = @id;
            SET @relationships = @@ROWCOUNT;
            DELETE FROM ${this.t('dm_entities')} WHERE [repository_id] = @id;
            SET @entities = @@ROWCOUNT;
            DELETE FROM ${this.t('dm_repositories')} WHERE [repository_id] = @id;
            COMMIT TRANSACTION;
          END
          SELECT @relationships AS relationships, @entities AS entities, @repositories AS repositories;
        `);
      counts = result.recordset[0];
    } catch (err) {
      throw new ProviderError(
        `SQL Server deleteRepository failed: ${err instanceof Error ? err.message : String(err)}`,
        'An error inside the batch rolls the whole delete back. Re-run the delete; a repository that is already gone reports not found.',
        { cause: err },
      );
    }

    if (counts === undefined) {
      throw new ProviderError('SQL Server deleteRepository returned no result row.');
    }
    if (counts.repositories === 0) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    return { deletedEntities: counts.entities, deletedRelationships: counts.relationships };
  }

  public async deleteAllContents(repositoryId: string, _onProgress?: DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    // Delete relationships first (FK constraint), then entities
    const relResult = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query(`DELETE FROM ${this.t('dm_relationships')} WHERE [repository_id] = @id`);

    const entityResult = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query(`DELETE FROM ${this.t('dm_entities')} WHERE [repository_id] = @id`);

    return {
      deletedEntities: entityResult.rowsAffected[0] ?? 0,
      deletedRelationships: relResult.rowsAffected[0] ?? 0,
    };
  }

  /**
   * Entity and relationship counts per type, plus the vocabulary version. The
   * counts and the vocabulary read run in parallel; the vocabulary read
   * checks the repository row, so a missing repository throws
   * `RepositoryNotFoundError` rather than reporting zero counts.
   */
  public async getRepositoryStats(repositoryId: string): Promise<RepositoryStats> {
    const pool = this.getPool();

    const [entityStats, relStats, vocab] = await Promise.all([
      pool.request()
        .input('id', sql.UniqueIdentifier, repositoryId)
        .query<{ entity_type: string; cnt: number }>(
          `SELECT [entity_type], COUNT(*) AS cnt
           FROM ${this.t('dm_entities')} WHERE [repository_id] = @id
           GROUP BY [entity_type]`,
        ),
      pool.request()
        .input('id', sql.UniqueIdentifier, repositoryId)
        .query<{ relationship_type: string; cnt: number }>(
          `SELECT [relationship_type], COUNT(*) AS cnt
           FROM ${this.t('dm_relationships')} WHERE [repository_id] = @id
           GROUP BY [relationship_type]`,
        ),
      this.getVocabulary(repositoryId),
    ]);

    const entityTypeBreakdown: Record<string, number> = {};
    let entityCount = 0;
    for (const row of entityStats.recordset) {
      entityTypeBreakdown[row.entity_type] = row.cnt;
      entityCount += row.cnt;
    }

    const relationshipTypeBreakdown: Record<string, number> = {};
    let relationshipCount = 0;
    for (const row of relStats.recordset) {
      relationshipTypeBreakdown[row.relationship_type] = row.cnt;
      relationshipCount += row.cnt;
    }

    return {
      entityCount,
      relationshipCount,
      vocabularyVersion: vocab.version,
      entityTypeBreakdown,
      relationshipTypeBreakdown,
    };
  }

  // ─── Vocabulary ──────────────────────────────────────────────────

  /**
   * Read the stored vocabulary. This provider keeps no vocabulary cache, so
   * every read already goes to the database and `fresh` needs no handling.
   * One query reads the repository row and its vocabulary together: no
   * repository row → `RepositoryNotFoundError`.
   */
  public async getVocabulary(
    repositoryId: string,
    _options?: VocabularyReadOptions,
  ): Promise<MemoryVocabulary> {
    const pool = this.getPool();

    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query<{ vocabulary: string | null }>(
        `SELECT v.[vocabulary]
         FROM ${this.t('dm_repositories')} r
         LEFT JOIN ${this.t('dm_vocabularies')} v ON v.[repository_id] = r.[repository_id]
         WHERE r.[repository_id] = @id`,
      );

    const row = result.recordset[0];
    if (!row) throw new RepositoryNotFoundError(repositoryId);
    if (row.vocabulary === null) {
      // createRepository inserts the vocabulary row together with the
      // repository row, so an existing repository without one is corrupt
      // state. Returning a synthetic empty vocabulary would hand callers a
      // version that saveVocabulary can never match.
      throw new ProviderError(
        `Repository "${repositoryId}" exists but has no stored vocabulary`,
        'The vocabulary is created with the repository; re-create or re-import the repository to restore it.',
      );
    }

    return JSON.parse(row.vocabulary) as MemoryVocabulary;
  }

  /**
   * Compare-and-set write of the vocabulary.
   *
   * The version check and the write are one UPDATE, so two writers that read
   * the same base version cannot both land — the second matches zero rows.
   * The stored version is read out of the JSON document with JSON_VALUE
   * rather than kept in a dedicated column, so the table schema is unchanged.
   * The comparison uses a binary collation so it is exact: the default
   * collations ignore case and trailing spaces, which would let a different
   * version string match.
   *
   * Zero rows affected means either the repository is gone or the version is
   * stale; only on that path does a follow-up read decide which typed error to
   * throw. The success path is a single round-trip — no up-front repository
   * check, because the UPDATE's WHERE clause already covers a missing row.
   */
  public async saveVocabulary(
    repositoryId: string,
    vocabulary: MemoryVocabulary,
    expectedVersion: string,
  ): Promise<void> {
    const pool = this.getPool();

    const update = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .input('vocabulary', sql.NVarChar, JSON.stringify(vocabulary))
      .input('expectedVersion', sql.NVarChar, expectedVersion)
      .query(`
        UPDATE ${this.t('dm_vocabularies')}
        SET [vocabulary] = @vocabulary
        WHERE [repository_id] = @id
          AND JSON_VALUE([vocabulary], '$.version') COLLATE Latin1_General_100_BIN2 = @expectedVersion
      `);

    if ((update.rowsAffected[0] ?? 0) > 0) {
      return;
    }

    const current = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query<{ version: string | null }>(`
        SELECT JSON_VALUE([vocabulary], '$.version') AS [version]
        FROM ${this.t('dm_vocabularies')}
        WHERE [repository_id] = @id
      `);

    const row = current.recordset[0];
    if (!row) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    if (row.version === null) {
      // JSON_VALUE yields NULL when $.version is missing, not a scalar, or
      // longer than 4000 characters. No expectedVersion can ever match such a
      // row, so reporting a conflict would send callers into a futile retry.
      throw new ProviderError(
        `Stored vocabulary for repository "${repositoryId}" has no readable version`,
        'The stored vocabulary document is malformed; its "version" must be a "major.minor.patch" string.',
      );
    }
    throw new VocabularyVersionConflictError(repositoryId, expectedVersion, row.version);
  }

  public async getVocabularyChangeLog(
    repositoryId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<VocabularyChangeRecord>> {
    const pool = this.getPool();
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;

    // One batch: the repository check, the count and the page.
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query<[RepositoryCheckRow, { cnt: number }, Record<string, unknown>]>(
        `${this.repositoryCheckSql()}
         SELECT COUNT(*) AS cnt FROM ${this.t('dm_vocabulary_change_log')} WHERE [repository_id] = @repoId;
         SELECT * FROM ${this.t('dm_vocabulary_change_log')}
         WHERE [repository_id] = @repoId
         ORDER BY [proposed_at] DESC
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`,
      );
    this.assertRepositoryChecked(result.recordsets[0], repositoryId, 'getVocabularyChangeLog');
    const total = result.recordsets[1][0]?.cnt ?? 0;

    return {
      items: result.recordsets[2].map(changeRecordFromRow),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  // ─── Entities ────────────────────────────────────────────────────

  public async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    // Check for duplicate
    const existing = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entity.id)
      .query<{ entity_id: string }>(
        `SELECT [entity_id] FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId AND [entity_id] = @entityId`,
      );

    if (existing.recordset.length > 0) {
      throw new DuplicateEntityError(entity.id);
    }

    const req = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entity.id)
      .input('slug', sql.NVarChar, entity.slug)
      .input('entityType', sql.NVarChar, entity.entityType)
      .input('label', sql.NVarChar, entity.label)
      .input('summary', sql.NVarChar, entity.summary ?? null)
      .input('properties', sql.NVarChar, JSON.stringify(entity.properties))
      .input('data', sql.NVarChar, entity.data ?? null)
      .input('dataFormat', sql.NVarChar, entity.dataFormat ?? null)
      .input('embedding', sql.NVarChar, entity.embedding ? JSON.stringify(entity.embedding) : null);

    this.addProvenanceInputs(req, entity.provenance);

    await req.query(`
      INSERT INTO ${this.t('dm_entities')} (
        [repository_id], [entity_id], [slug], [entity_type], [label], [summary],
        [properties], [data], [data_format], [embedding],
        [created_by], [created_by_type], [created_at],
        [created_in_conversation], [created_from_message],
        [modified_by], [modified_by_type], [modified_at],
        [modified_in_conversation], [modified_from_message]
      ) VALUES (
        @repoId, @entityId, @slug, @entityType, @label, @summary,
        @properties, @data, @dataFormat, @embedding,
        @createdBy, @createdByType, @createdAt,
        @createdInConversation, @createdFromMessage,
        @modifiedBy, @modifiedByType, @modifiedAt,
        @modifiedInConversation, @modifiedFromMessage
      )
    `).catch(rethrowUniqueViolation({
      kind: 'entity',
      entityId: entity.id,
      slug: entity.slug,
      entityType: entity.entityType,
      label: entity.label,
    }));

    return entity;
  }

  public async getEntity(
    repositoryId: string,
    entityId: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null> {
    const cols = options?.loadEmbeddings ? ENTITY_COLS_FULL : ENTITY_COLS_LIGHT;
    const [entity] = await this.readEntitiesGuarded(repositoryId, 'getEntity', { entityId }, cols);
    return entity ?? null;
  }

  public async getEntityBySlug(
    repositoryId: string,
    slug: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null> {
    const cols = options?.loadEmbeddings ? ENTITY_COLS_FULL : ENTITY_COLS_LIGHT;
    const [entity] = await this.readEntitiesGuarded(repositoryId, 'getEntityBySlug', { slug }, cols);
    return entity ?? null;
  }

  /** An empty `entityIds` list still checks the repository. */
  public async getEntities(
    repositoryId: string,
    entityIds: string[],
    options?: EntityReadOptions,
  ): Promise<Map<string, StoredEntity>> {
    const cols = options?.loadEmbeddings ? ENTITY_COLS_FULL : ENTITY_COLS_LIGHT;
    const entities = await this.readEntitiesGuarded(repositoryId, 'getEntities', { entityIds }, cols);
    return new Map(entities.map((entity) => [entity.id, entity]));
  }

  public async updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity> {
    const pool = this.getPool();

    // Get existing entity. The read checks the repository in the same batch,
    // so a deleted repository reports `RepositoryNotFoundError` rather than a
    // missing entity.
    const existing = await this.getEntity(repositoryId, entityId);
    if (!existing) throw new EntityNotFoundError(entityId);

    // For optional string fields, null clears, undefined preserves, string sets.
    const updated: StoredEntity = {
      ...existing,
      entityType: updates.entityType ?? existing.entityType,
      label: updates.label ?? existing.label,
      slug: updates.slug ?? existing.slug,
      summary: updates.summary === undefined ? existing.summary : (updates.summary ?? undefined),
      properties: updates.properties ?? existing.properties,
      data: updates.data === undefined ? existing.data : (updates.data ?? undefined),
      dataFormat: updates.dataFormat === undefined ? existing.dataFormat : (updates.dataFormat ?? undefined),
      provenance: updates.provenance,
      embedding: updates.embedding ?? existing.embedding,
    };

    const req = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId)
      .input('entityType', sql.NVarChar, updated.entityType)
      .input('slug', sql.NVarChar, updated.slug)
      .input('label', sql.NVarChar, updated.label)
      .input('summary', sql.NVarChar, updated.summary ?? null)
      .input('properties', sql.NVarChar, JSON.stringify(updated.properties))
      .input('data', sql.NVarChar, updated.data ?? null)
      .input('dataFormat', sql.NVarChar, updated.dataFormat ?? null)
      .input('embedding', sql.NVarChar, updated.embedding ? JSON.stringify(updated.embedding) : null)
      .input('modifiedBy', sql.NVarChar, updates.provenance.modifiedBy)
      .input('modifiedByType', sql.NVarChar, updates.provenance.modifiedByType)
      .input('modifiedAt', sql.NVarChar, updates.provenance.modifiedAt)
      .input('modifiedInConversation', sql.NVarChar, updates.provenance.modifiedInConversation ?? null)
      .input('modifiedFromMessage', sql.NVarChar, updates.provenance.modifiedFromMessage ?? null);

    const update = await req.query(`
      UPDATE ${this.t('dm_entities')} SET
        [entity_type] = @entityType,
        [slug] = @slug,
        [label] = @label,
        [summary] = @summary,
        [properties] = @properties,
        [data] = @data,
        [data_format] = @dataFormat,
        [embedding] = @embedding,
        [modified_by] = @modifiedBy,
        [modified_by_type] = @modifiedByType,
        [modified_at] = @modifiedAt,
        [modified_in_conversation] = @modifiedInConversation,
        [modified_from_message] = @modifiedFromMessage
      WHERE [repository_id] = @repoId AND [entity_id] = @entityId
    `).catch(rethrowUniqueViolation({
      kind: 'entity',
      entityId,
      slug: updated.slug,
      entityType: updated.entityType,
      label: updated.label,
    }));

    // The entity (or its whole repository) was deleted between the read and
    // the write: nothing was updated.
    if ((update.rowsAffected[0] ?? 0) === 0) {
      await this.assertRepository(repositoryId);
      throw new EntityNotFoundError(entityId);
    }

    return updated;
  }

  /**
   * Delete one entity and its relationships. A miss checks the repository,
   * so a deleted repository reports `RepositoryNotFoundError` rather than a
   * missing entity; the check costs a round trip on the failure path only.
   * `deleteRepository` removes a repository's rows in one transaction, so
   * an entity row never outlives its repository row.
   */
  public async deleteEntity(repositoryId: string, entityId: string): Promise<void> {
    const pool = this.getPool();

    // Delete relationships first (FK constraints would block otherwise)
    // Two targeted DELETEs hit source/target indexes instead of one OR scan
    const delReq = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId);
    await delReq.query(`
      DELETE FROM ${this.t('dm_relationships')}
        WHERE [repository_id] = @repoId AND [source_entity_id] = @entityId;
      DELETE FROM ${this.t('dm_relationships')}
        WHERE [repository_id] = @repoId AND [target_entity_id] = @entityId;
    `);

    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId)
      .query(
        `DELETE FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId AND [entity_id] = @entityId`,
      );

    if (result.rowsAffected[0] === 0) {
      await this.assertRepository(repositoryId);
      throw new EntityNotFoundError(entityId);
    }
  }

  /**
   * Delete entities by id in one guarded batch (`deleteByIdsGuarded`). An
   * empty list deletes nothing but still checks the repository.
   */
  public async deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) {
      await this.assertRepository(repositoryId);
      return { deleted: [], notFound: [] };
    }

    // Relationships where any of these entities is source or target go
    // first (foreign keys); OUTPUT tells which entity rows actually existed.
    return this.deleteByIdsGuarded(repositoryId, ids, 'deleteEntities', `
      DELETE FROM ${this.t('dm_relationships')}
        WHERE [repository_id] = @repoId AND [source_entity_id] IN (SELECT [id] FROM @ids);
      DELETE FROM ${this.t('dm_relationships')}
        WHERE [repository_id] = @repoId AND [target_entity_id] IN (SELECT [id] FROM @ids);
      DELETE FROM ${this.t('dm_entities')}
        OUTPUT DELETED.[entity_id] INTO @deleted
        WHERE [repository_id] = @repoId AND [entity_id] IN (SELECT [id] FROM @ids);
    `);
  }

  /**
   * One batch and one transaction (see `deleteByTypeGuarded`): the
   * relationships with an endpoint of the type go first, by source and then
   * by target, then the entities.
   */
  public async deleteEntitiesByType(
    repositoryId: string,
    entityType: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const request = this.getPool().request().input('entityType', sql.NVarChar, entityType);
    return this.deleteByTypeGuarded(repositoryId, 'deleteEntitiesByType', request, `
      DELETE r FROM ${this.t('dm_relationships')} r
      INNER JOIN ${this.t('dm_entities')} e
        ON r.[repository_id] = e.[repository_id]
        AND r.[source_entity_id] = e.[entity_id]
      WHERE e.[repository_id] = @repoId AND e.[entity_type] = @entityType;
      SET @deletedRelationships += @@ROWCOUNT;
      DELETE r FROM ${this.t('dm_relationships')} r
      INNER JOIN ${this.t('dm_entities')} e
        ON r.[repository_id] = e.[repository_id]
        AND r.[target_entity_id] = e.[entity_id]
      WHERE e.[repository_id] = @repoId AND e.[entity_type] = @entityType;
      SET @deletedRelationships += @@ROWCOUNT;
      DELETE FROM ${this.t('dm_entities')}
      WHERE [repository_id] = @repoId AND [entity_type] = @entityType;
      SET @deletedEntities = @@ROWCOUNT;
    `);
  }

  /**
   * One batch: the repository check, the count and the page, sharing one
   * set of parameters.
   */
  public async findEntities(
    repositoryId: string,
    query: StorageFindQuery,
    options?: EntityReadOptions,
  ): Promise<PaginatedResult<StoredEntity>> {
    const pool = this.getPool();
    const req = pool.request().input('repoId', sql.UniqueIdentifier, repositoryId);

    const conditions = ['[repository_id] = @repoId'];

    // Type filter
    if (query.entityTypes && query.entityTypes.length > 0) {
      const typePlaceholders = query.entityTypes.map((t, i) => {
        req.input(`et${i}`, sql.NVarChar, t);
        return `@et${i}`;
      });
      conditions.push(`[entity_type] IN (${typePlaceholders.join(',')})`);
    }

    // Search term (case-insensitive LIKE on label and summary)
    if (query.searchTerm) {
      req.input('searchTerm', sql.NVarChar, `%${query.searchTerm}%`);
      conditions.push(`([label] LIKE @searchTerm OR [summary] LIKE @searchTerm)`);
    }

    // Property filter (exact match via JSON_VALUE)
    if (query.properties) {
      const entries = Object.entries(query.properties);
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i]!;
        req.input(`propKey${i}`, sql.NVarChar, `$.${key}`);
        req.input(`propVal${i}`, sql.NVarChar, String(value));
        conditions.push(`JSON_VALUE([properties], @propKey${i}) = @propVal${i}`);
      }
    }

    // Provenance filter
    if (query.provenance) {
      addProvenanceConditions(req, query.provenance, conditions);
    }

    const where = conditions.join(' AND ');
    req.input('limit', sql.Int, query.limit);
    req.input('offset', sql.Int, query.offset);

    const cols = options?.loadEmbeddings ? ENTITY_COLS_FULL : ENTITY_COLS_LIGHT;
    const result = await req.query<[RepositoryCheckRow, { cnt: number }, Record<string, unknown>]>(
      `${this.repositoryCheckSql()}
       SELECT COUNT(*) AS cnt FROM ${this.t('dm_entities')} WHERE ${where};
       SELECT ${cols} FROM ${this.t('dm_entities')}
       WHERE ${where}
       ORDER BY [entity_id]
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`,
    );
    this.assertRepositoryChecked(result.recordsets[0], repositoryId, 'findEntities');
    const total = result.recordsets[1][0]?.cnt ?? 0;

    return {
      items: result.recordsets[2].map(entityFromRow),
      total,
      hasMore: query.offset + query.limit < total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  // ─── Relationships ──────────────────────────────────────────────

  /**
   * The id check is a primary-key seek, and the primary key enforces id
   * uniqueness on the INSERT as well, so a reused id is refused whatever
   * `options.idMinted` says.
   */
  public async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
    _options?: RelationshipCreateOptions,
  ): Promise<StoredRelationship> {
    // Check first so the common failures get their typed errors without a
    // failed INSERT. The check and the INSERT are separate statements, so a
    // concurrent writer can still change the answer in between; the INSERT's
    // own failure is mapped below.
    const preconditions = await this.readRelationshipCreatePreconditions(repositoryId, relationship);
    if (!preconditions.repositoryExists) throw new RepositoryNotFoundError(repositoryId);
    if (preconditions.relationshipExists) throw new DuplicateRelationshipError(relationship.id);
    throwForMissingEndpoint(preconditions, relationship);

    const pool = this.getPool();
    const req = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationship.id)
      .input('relType', sql.NVarChar, relationship.relationshipType)
      .input('sourceId', sql.NVarChar, relationship.sourceEntityId)
      .input('targetId', sql.NVarChar, relationship.targetEntityId)
      .input('properties', sql.NVarChar, JSON.stringify(relationship.properties))
      .input('bidirectional', sql.Bit, relationship.bidirectional ? 1 : 0);

    this.addProvenanceInputs(req, relationship.provenance);

    await req.query(`
      INSERT INTO ${this.t('dm_relationships')} (
        [repository_id], [relationship_id], [relationship_type],
        [source_entity_id], [target_entity_id], [properties], [bidirectional],
        [created_by], [created_by_type], [created_at],
        [created_in_conversation], [created_from_message],
        [modified_by], [modified_by_type], [modified_at],
        [modified_in_conversation], [modified_from_message]
      ) VALUES (
        @repoId, @relId, @relType,
        @sourceId, @targetId, @properties, @bidirectional,
        @createdBy, @createdByType, @createdAt,
        @createdInConversation, @createdFromMessage,
        @modifiedBy, @modifiedByType, @modifiedAt,
        @modifiedInConversation, @modifiedFromMessage
      )
    `).catch(async (err: unknown): Promise<never> => {
      if (isForeignKeyViolation(err)) await this.throwForDeletedPrecondition(repositoryId, relationship, err);
      return rethrowUniqueViolation({ kind: 'relationship', relationshipId: relationship.id })(err);
    });

    return relationship;
  }

  /**
   * Whether the repository, an existing relationship with the same id, and
   * both endpoints exist — one round-trip, read before a relationship
   * INSERT and again when the INSERT fails on a foreign key.
   */
  private async readRelationshipCreatePreconditions(
    repositoryId: string,
    relationship: StoredRelationship,
  ): Promise<RelationshipCreatePreconditions> {
    const check = await this.getPool().request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationship.id)
      .input('sourceId', sql.NVarChar, relationship.sourceEntityId)
      .input('targetId', sql.NVarChar, relationship.targetEntityId)
      .query<{
        repository_exists: number;
        relationship_exists: number;
        source_exists: number;
        target_exists: number;
      }>(
        `SELECT
           CASE WHEN EXISTS (SELECT 1 FROM ${this.t('dm_repositories')}
             WHERE [repository_id] = @repoId) THEN 1 ELSE 0 END AS repository_exists,
           CASE WHEN EXISTS (SELECT 1 FROM ${this.t('dm_relationships')}
             WHERE [repository_id] = @repoId AND [relationship_id] = @relId) THEN 1 ELSE 0 END AS relationship_exists,
           CASE WHEN EXISTS (SELECT 1 FROM ${this.t('dm_entities')}
             WHERE [repository_id] = @repoId AND [entity_id] = @sourceId) THEN 1 ELSE 0 END AS source_exists,
           CASE WHEN EXISTS (SELECT 1 FROM ${this.t('dm_entities')}
             WHERE [repository_id] = @repoId AND [entity_id] = @targetId) THEN 1 ELSE 0 END AS target_exists`,
      );
    const row = check.recordset[0];
    if (row === undefined) {
      throw new ProviderError('SQL Server createRelationship precondition check returned no row.');
    }
    return {
      repositoryExists: row.repository_exists === 1,
      relationshipExists: row.relationship_exists === 1,
      sourceExists: row.source_exists === 1,
      targetExists: row.target_exists === 1,
    };
  }

  /**
   * After a relationship INSERT failed on a foreign key: re-read what the
   * keys reference and throw the typed error for the first thing missing —
   * repository, then source, then target. The error number is shared by all
   * three foreign keys and the message naming the key may be localised, so
   * the rows decide, not the message. When everything exists the failure is
   * not one the contract names, and it surfaces as `ProviderError`.
   */
  private async throwForDeletedPrecondition(
    repositoryId: string,
    relationship: StoredRelationship,
    cause: unknown,
  ): Promise<never> {
    const preconditions = await this.readRelationshipCreatePreconditions(repositoryId, relationship);
    if (!preconditions.repositoryExists) throw new RepositoryNotFoundError(repositoryId);
    throwForMissingEndpoint(preconditions, relationship);
    throw new ProviderError(
      `SQL Server createRelationship failed on a foreign key although the repository and both endpoints exist.`,
      undefined,
      { cause },
    );
  }

  public async getRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<StoredRelationship | null> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationshipId)
      .query<[RepositoryCheckRow, Record<string, unknown>]>(
        `${this.repositoryCheckSql()}
         SELECT * FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [relationship_id] = @relId;`,
      );
    this.assertRepositoryChecked(result.recordsets[0], repositoryId, 'getRelationship');

    const row = result.recordsets[1][0];
    if (!row) return null;
    return relationshipFromRow(row);
  }

  /**
   * One batch: the repository check, the count and the page. Property
   * filters apply to the fetched page afterwards.
   */
  public async getEntityRelationships(
    repositoryId: string,
    entityId: string,
    options?: RelationshipQueryOptions,
  ): Promise<PaginatedResult<StoredRelationship>> {
    const pool = this.getPool();
    const direction = options?.direction ?? 'both';
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;
    const tbl = this.t('dm_relationships');

    // Build relationship type filter clause (shared across branches)
    let rtFilter = '';
    const rtInputs: Array<{ name: string; value: string }> = [];
    if (options?.relationshipTypes && options.relationshipTypes.length > 0) {
      const placeholders = options.relationshipTypes.map((t, i) => {
        rtInputs.push({ name: `rt${i}`, value: t });
        return `@rt${i}`;
      });
      rtFilter = ` AND [relationship_type] IN (${placeholders.join(',')})`;
    }

    // Build UNION ALL query — each branch targets a specific nonclustered index
    // instead of forcing an OR-based scan across source/target columns.
    const unionBranches = this.buildRelationshipUnion(tbl, direction, rtFilter);

    const req = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset);
    for (const p of rtInputs) req.input(p.name, sql.NVarChar, p.value);

    const result = await req.query<[RepositoryCheckRow, { cnt: number }, Record<string, unknown>]>(
      `${this.repositoryCheckSql()}
       SELECT COUNT(*) AS cnt FROM (${unionBranches}) AS _u;
       SELECT * FROM (${unionBranches}) AS _u
       ORDER BY [relationship_id]
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY;`,
    );
    this.assertRepositoryChecked(result.recordsets[0], repositoryId, 'getEntityRelationships');
    const total = result.recordsets[1][0]?.cnt ?? 0;

    let items = result.recordsets[2].map(relationshipFromRow);

    // Apply property filters in-memory
    if (options?.propertyFilters && options.propertyFilters.length > 0) {
      items = items.filter((r) => matchesPropertyFilters(r.properties, options.propertyFilters!));
      const filteredTotal = total; // approximate — exact count would require re-querying
      return {
        items,
        total: filteredTotal,
        hasMore: offset + limit < filteredTotal,
        limit,
        offset,
      };
    }

    return {
      items,
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  /**
   * Build a UNION ALL query that seeks on source and target indexes separately,
   * avoiding OR-based index scans. Each branch produces an index seek at scale.
   */
  private buildRelationshipUnion(tbl: string, direction: string, rtFilter: string): string {
    // Source branch: seeks ix_dm_relationships_source (repo, source_entity_id, relationship_type)
    const srcBase = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [source_entity_id] = @entityId${rtFilter}`;
    // Target branch: seeks ix_dm_relationships_target (repo, target_entity_id, bidirectional, relationship_type)
    const tgtBase = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [target_entity_id] = @entityId${rtFilter}`;
    // Bidirectional target: seeks ix_dm_relationships_target with bidirectional = 1
    const tgtBidi = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [target_entity_id] = @entityId AND [bidirectional] = 1${rtFilter}`;
    // Bidirectional source: seeks ix_dm_relationships_source with bidirectional = 1
    const srcBidi = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [source_entity_id] = @entityId AND [bidirectional] = 1${rtFilter}`;

    switch (direction) {
      case 'out':
        // Outbound = where entity is source, OR where entity is target of a bidirectional rel
        return `${srcBase} UNION ALL ${tgtBidi} AND [source_entity_id] <> @entityId`;
      case 'in':
        // Inbound = where entity is target, OR where entity is source of a bidirectional rel
        return `${tgtBase} UNION ALL ${srcBidi} AND [target_entity_id] <> @entityId`;
      case 'both':
      default:
        // Both = where entity is source UNION where entity is target (excluding duplicates from source branch)
        return `${srcBase} UNION ALL ${tgtBase} AND [source_entity_id] <> @entityId`;
    }
  }

  /**
   * Delete one relationship. A miss checks the repository, so a deleted
   * repository reports `RepositoryNotFoundError` rather than a missing
   * relationship; the check costs a round trip on the failure path only.
   */
  public async deleteRelationship(repositoryId: string, relationshipId: string): Promise<void> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationshipId)
      .query(
        `DELETE FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [relationship_id] = @relId`,
      );

    if (result.rowsAffected[0] === 0) {
      await this.assertRepository(repositoryId);
      throw new RelationshipNotFoundError(relationshipId);
    }
  }

  /**
   * Delete relationships by id in one guarded batch (`deleteByIdsGuarded`).
   * An empty list deletes nothing but still checks the repository.
   */
  public async deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) {
      await this.assertRepository(repositoryId);
      return { deleted: [], notFound: [] };
    }

    return this.deleteByIdsGuarded(repositoryId, ids, 'deleteRelationships', `
      DELETE FROM ${this.t('dm_relationships')}
        OUTPUT DELETED.[relationship_id] INTO @deleted
        WHERE [repository_id] = @repoId AND [relationship_id] IN (SELECT [id] FROM @ids);
    `);
  }

  /** One batch and one transaction (see `deleteByTypeGuarded`). */
  public async deleteRelationshipsByType(
    repositoryId: string,
    relationshipType: string,
  ): Promise<{ deletedRelationships: number }> {
    const request = this.getPool().request().input('relType', sql.NVarChar, relationshipType);
    const { deletedRelationships } = await this.deleteByTypeGuarded(
      repositoryId,
      'deleteRelationshipsByType',
      request,
      `DELETE FROM ${this.t('dm_relationships')}
       WHERE [repository_id] = @repoId AND [relationship_type] = @relType;
       SET @deletedRelationships = @@ROWCOUNT;`,
    );
    return { deletedRelationships };
  }

  // ─── Graph Traversal ────────────────────────────────────────────

  public async exploreNeighborhood(
    repositoryId: string,
    entityId: string,
    options: StorageExploreOptions,
  ): Promise<StorageNeighborhood> {
    // The center entity must exist (light — no embedding needed); the same
    // batch checks the repository first.
    const [center] = await this.readEntitiesGuarded(
      repositoryId,
      'exploreNeighborhood',
      { entityId },
      ENTITY_COLS_LIGHT,
    );
    if (!center) {
      throw new EntityNotFoundError(entityId);
    }

    const layers: StorageNeighborhood['layers'] = [];
    const visited = new Set<string>([entityId]);
    let currentFrontier = new Set<string>([entityId]);

    for (let depth = 0; depth < options.depth; depth++) {
      const layer: StorageNeighborhood['layers'][number] = {};
      const nextFrontier = new Set<string>();

      // Batch: fetch all relationships for the entire frontier in one query
      const frontierIds = [...currentFrontier];
      const relsByEntity = await this.getRelationshipsForEntities(
        repositoryId,
        frontierIds,
        options.direction,
        options.relationshipTypes,
      );

      // Collect all connected entity IDs we need to fetch
      const connectedIdsToFetch = new Set<string>();
      const pendingRels: Array<{ frontierEntityId: string; rel: StoredRelationship; connectedEntityId: string }> = [];

      for (const frontierEntityId of frontierIds) {
        const rels = relsByEntity.get(frontierEntityId) ?? [];
        for (const rel of rels) {
          let connectedEntityId: string | undefined;
          if (rel.sourceEntityId === frontierEntityId) {
            connectedEntityId = rel.targetEntityId;
          } else if (rel.targetEntityId === frontierEntityId) {
            connectedEntityId = rel.sourceEntityId;
          }
          if (!connectedEntityId || visited.has(connectedEntityId)) continue;

          // Filter by relationship property values
          if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
            if (!matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters)) {
              continue;
            }
          }

          connectedIdsToFetch.add(connectedEntityId);
          pendingRels.push({ frontierEntityId, rel, connectedEntityId });
        }
      }

      // Batch: fetch all connected entities in one query
      const connectedEntities = await this.getEntitiesLight(repositoryId, [...connectedIdsToFetch]);

      // Process results in memory
      for (const { rel, connectedEntityId } of pendingRels) {
        if (visited.has(connectedEntityId)) continue;

        const connectedEntity = connectedEntities.get(connectedEntityId);
        if (!connectedEntity) continue;

        if (options.entityTypes && !options.entityTypes.includes(connectedEntity.entityType)) {
          continue;
        }

        const relType = rel.relationshipType;
        if (!layer[relType]) {
          layer[relType] = { total: 0, entities: [], relationships: [] };
        }

        const group = layer[relType]!;
        group.total++;

        if (group.entities.length < options.limitPerType) {
          group.entities.push(connectedEntity);
          group.relationships.push(rel);
        }

        nextFrontier.add(connectedEntityId);
        visited.add(connectedEntityId);
      }

      layers.push(layer);
      currentFrontier = nextFrontier;
      if (nextFrontier.size === 0) break;
    }

    return { centerId: entityId, layers };
  }

  public async findPaths(
    repositoryId: string,
    sourceId: string,
    targetId: string,
    options: StoragePathOptions,
  ): Promise<StoragePathResult> {
    // Both entities must exist (light — no embedding needed); the same
    // batch checks the repository first.
    const endpoints = await this.readEntitiesGuarded(
      repositoryId,
      'findPaths',
      { entityIds: [sourceId, targetId] },
      ENTITY_COLS_LIGHT,
    );
    const found = new Set(endpoints.map((entity) => entity.id));
    if (!found.has(sourceId)) throw new EntityNotFoundError(sourceId);
    if (!found.has(targetId)) throw new EntityNotFoundError(targetId);

    if (sourceId === targetId) {
      return { paths: [{ entityIds: [sourceId], relationshipIds: [] }], totalPaths: 1 };
    }

    // BFS path finding — processes in depth levels for batch relationship fetching
    const paths: Array<{ entityIds: string[]; relationshipIds: string[] }> = [];
    let currentLevel: Array<{ entityId: string; path: string[]; relPath: string[] }> = [
      { entityId: sourceId, path: [sourceId], relPath: [] },
    ];
    const visitedAtDepth = new Map<string, number>();
    visitedAtDepth.set(sourceId, 0);

    for (let depth = 0; depth <= options.maxDepth && currentLevel.length > 0 && paths.length < options.limit + options.offset; depth++) {
      // Batch: fetch relationships for all frontier entities at this depth
      const frontierIds = [...new Set(currentLevel.map(e => e.entityId))];
      const relsByEntity = await this.getRelationshipsForEntities(
        repositoryId,
        frontierIds,
        'both',
        options.relationshipTypes,
      );

      const nextLevel: Array<{ entityId: string; path: string[]; relPath: string[] }> = [];

      for (const current of currentLevel) {
        if (paths.length >= options.limit + options.offset) break;

        const rels = relsByEntity.get(current.entityId) ?? [];
        for (const rel of rels) {
          // Filter by relationship property values
          if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
            if (!matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters)) {
              continue;
            }
          }

          let nextEntityId: string | undefined;
          if (rel.sourceEntityId === current.entityId) {
            nextEntityId = rel.targetEntityId;
          } else if (rel.targetEntityId === current.entityId) {
            nextEntityId = rel.sourceEntityId;
          }

          if (!nextEntityId) continue;
          if (current.path.includes(nextEntityId) && nextEntityId !== targetId) continue;

          const newPath = [...current.path, nextEntityId];
          const newRelPath = [...current.relPath, rel.id];

          if (nextEntityId === targetId) {
            paths.push({ entityIds: newPath, relationshipIds: newRelPath });
          } else if (newPath.length <= options.maxDepth) {
            const prevDepth = visitedAtDepth.get(nextEntityId);
            if (prevDepth === undefined || prevDepth >= newPath.length - 1) {
              visitedAtDepth.set(nextEntityId, newPath.length - 1);
              nextLevel.push({ entityId: nextEntityId, path: newPath, relPath: newRelPath });
            }
          }
        }
      }

      // Filter next level by entity types if specified (batch-fetch entity types)
      if (options.entityTypes && nextLevel.length > 0) {
        const nextIds = [...new Set(nextLevel.map(e => e.entityId))];
        const entityMap = await this.getEntitiesLight(repositoryId, nextIds);
        const allowedIds = new Set<string>();
        for (const [id, e] of entityMap) {
          if (options.entityTypes.includes(e.entityType)) {
            allowedIds.add(id);
          }
        }
        currentLevel = nextLevel.filter(e => allowedIds.has(e.entityId));
      } else {
        currentLevel = nextLevel;
      }
    }

    const paginatedPaths = paths.slice(options.offset, options.offset + options.limit);
    return { paths: paginatedPaths, totalPaths: paths.length };
  }

  // ─── Timeline ───────────────────────────────────────────────────

  public async getTimeline(
    repositoryId: string,
    entityId: string,
    options: StorageTimelineOptions,
  ): Promise<StorageTimelineResult> {
    // The same batch checks the repository before reading the entity.
    const [entity] = await this.readEntitiesGuarded(
      repositoryId,
      'getTimeline',
      { entityId },
      ENTITY_COLS_LIGHT,
    );
    if (!entity) {
      throw new EntityNotFoundError(entityId);
    }

    const events: StorageTimelineEvent[] = [];

    // Entity creation event
    events.push({
      timestamp: entity.provenance.createdAt,
      eventType: 'entity:created',
      entityId,
    });

    // Entity modification event
    if (entity.provenance.modifiedAt !== entity.provenance.createdAt) {
      events.push({
        timestamp: entity.provenance.modifiedAt,
        eventType: 'entity:updated',
        entityId,
      });
    }

    // Relationship events involving this entity — push time-range filter into SQL
    const pool = this.getPool();
    const relReq = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId)
      .input('from', sql.NVarChar, options.timeRange?.from ?? null)
      .input('to', sql.NVarChar, options.timeRange?.to ?? null);

    const relResult = await relReq.query<Record<string, unknown>>(
      `SELECT [relationship_id], [created_at] FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [source_entity_id] = @entityId
           AND (@from IS NULL OR [created_at] >= @from)
           AND (@to IS NULL OR [created_at] <= @to)
       UNION ALL
       SELECT [relationship_id], [created_at] FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [target_entity_id] = @entityId
           AND [source_entity_id] <> @entityId
           AND (@from IS NULL OR [created_at] >= @from)
           AND (@to IS NULL OR [created_at] <= @to)`,
    );

    for (const row of relResult.recordset) {
      events.push({
        timestamp: row['created_at'] as string,
        eventType: 'relationship:created',
        entityId,
        relationshipId: row['relationship_id'] as string,
      });
    }

    // Filter by time range (still needed for entity events which come from provenance)
    let filtered = events;
    if (options.timeRange) {
      const from = new Date(options.timeRange.from).getTime();
      const to = new Date(options.timeRange.to).getTime();
      filtered = filtered.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= from && t <= to;
      });
    }

    // Filter by event types
    if (options.eventTypes && options.eventTypes.length > 0) {
      filtered = filtered.filter((e) => options.eventTypes!.includes(e.eventType));
    }

    // Sort descending
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const items = filtered.slice(options.offset, options.offset + options.limit);

    return { events: items, total };
  }

  // ─── Bulk Operations ────────────────────────────────────────────

  public async *exportAll(repositoryId: string): AsyncIterable<ExportChunk> {
    const pool = this.getPool();
    const batchSize = 100;

    // Export entities. The first count shares its batch with the repository
    // check, so a missing repository throws before anything is yielded.
    const entityCount = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .query<[RepositoryCheckRow, { cnt: number }]>(
        `${this.repositoryCheckSql()}
         SELECT COUNT(*) AS cnt FROM ${this.t('dm_entities')} WHERE [repository_id] = @repoId;`,
      );
    this.assertRepositoryChecked(entityCount.recordsets[0], repositoryId, 'exportAll');
    const totalEntities = entityCount.recordsets[1][0]?.cnt ?? 0;

    if (totalEntities === 0) {
      yield { type: 'entities', data: [], sequence: 0, isLast: true };
    } else {
      for (let offset = 0; offset < totalEntities; offset += batchSize) {
        const batch = await pool.request()
          .input('repoId', sql.UniqueIdentifier, repositoryId)
          .input('offset', sql.Int, offset)
          .input('limit', sql.Int, batchSize)
          .query<Record<string, unknown>>(
            `SELECT ${ENTITY_COLS_FULL} FROM ${this.t('dm_entities')}
             WHERE [repository_id] = @repoId
             ORDER BY [entity_id]
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
          );

        yield {
          type: 'entities',
          data: batch.recordset.map(entityFromRow),
          sequence: Math.floor(offset / batchSize),
          isLast: offset + batchSize >= totalEntities,
        };
      }
    }

    // Export relationships
    const relCount = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM ${this.t('dm_relationships')} WHERE [repository_id] = @repoId`,
      );
    const totalRels = relCount.recordset[0]?.cnt ?? 0;

    if (totalRels === 0) {
      yield { type: 'relationships', data: [], sequence: 0, isLast: true };
    } else {
      for (let offset = 0; offset < totalRels; offset += batchSize) {
        const batch = await pool.request()
          .input('repoId', sql.UniqueIdentifier, repositoryId)
          .input('offset', sql.Int, offset)
          .input('limit', sql.Int, batchSize)
          .query<Record<string, unknown>>(
            `SELECT * FROM ${this.t('dm_relationships')}
             WHERE [repository_id] = @repoId
             ORDER BY [relationship_id]
             OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
          );

        yield {
          type: 'relationships',
          data: batch.recordset.map(relationshipFromRow),
          sequence: Math.floor(offset / batchSize),
          isLast: offset + batchSize >= totalRels,
        };
      }
    }
  }

  public async importBulk(
    repositoryId: string,
    data: ImportChunk[],
    _options?: BulkImportOptions,
  ): Promise<BulkImportResult> {
    const pool = this.getPool();
    let entitiesImported = 0;
    let relationshipsImported = 0;

    // One transaction for the whole import: either every row lands or none
    // does, so a failed import never leaves a partial repository behind and
    // re-running it starts from a clean slate. The row being written is
    // tracked so a failure can name it.
    let current: ImportRow | undefined;
    const transaction = pool.transaction();
    await transaction.begin();

    // The repository row is the transaction's first read and is held
    // (`HOLDLOCK`) to the end, in the same lock order as `deleteRepository`,
    // so a concurrent delete waits for the import instead of failing it
    // part-way. With no repository row nothing is written: the empty
    // transaction commits and the call throws `RepositoryNotFoundError`.
    // A failed check or commit rolls back; a typed error raised here passes
    // through unchanged and only a driver error is wrapped.
    let repositoryExists: boolean;
    try {
      const check = await transaction.request()
        .input('repoId', sql.UniqueIdentifier, repositoryId)
        .query<RepositoryCheckRow>(
          `SELECT COUNT(*) AS repository_exists
           FROM ${this.t('dm_repositories')} WITH (HOLDLOCK, ROWLOCK)
           WHERE [repository_id] = @repoId`,
        );
      const checkRow = check.recordset[0];
      if (checkRow === undefined) {
        throw new ProviderError('SQL Server importBulk returned no repository check row.');
      }
      repositoryExists = checkRow.repository_exists === 1;
      if (!repositoryExists) {
        await transaction.commit();
      }
    } catch (err) {
      let rollbackNote = '';
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        // Reported inside the error below; it must not replace the failure
        // that caused the rollback.
        rollbackNote = ` (the rollback also failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)})`;
      }
      if (err instanceof DeepMemoryError) throw err;
      throw new ProviderError(
        `SQL Server importBulk could not check the repository: ${err instanceof Error ? err.message : String(err)}${rollbackNote}`,
        'Nothing from this import was written; re-running it is safe.',
        { cause: err },
      );
    }
    if (!repositoryExists) {
      throw new RepositoryNotFoundError(repositoryId);
    }

    try {
      for (const chunk of data) {
        if (chunk.entities) {
          for (const entity of chunk.entities) {
            current = {
              item: `entity:${entity.id}`,
              context: {
                kind: 'entity',
                entityId: entity.id,
                slug: entity.slug,
                entityType: entity.entityType,
                label: entity.label,
              },
            };
            const req = transaction.request()
              .input('repoId', sql.UniqueIdentifier, repositoryId)
              .input('entityId', sql.NVarChar, entity.id)
              .input('slug', sql.NVarChar, entity.slug)
              .input('entityType', sql.NVarChar, entity.entityType)
              .input('label', sql.NVarChar, entity.label)
              .input('summary', sql.NVarChar, entity.summary ?? null)
              .input('properties', sql.NVarChar, JSON.stringify(entity.properties))
              .input('data', sql.NVarChar, entity.data ?? null)
              .input('dataFormat', sql.NVarChar, entity.dataFormat ?? null)
              .input('embedding', sql.NVarChar, entity.embedding ? JSON.stringify(entity.embedding) : null);

            this.addProvenanceInputs(req, entity.provenance);

            await req.query(`
              MERGE ${this.t('dm_entities')} AS target
              USING (SELECT @repoId AS repository_id, @entityId AS entity_id) AS source
              ON target.[repository_id] = source.repository_id AND target.[entity_id] = source.entity_id
              WHEN MATCHED THEN UPDATE SET
                [entity_type] = @entityType, [slug] = @slug, [label] = @label, [summary] = @summary,
                [properties] = @properties, [data] = @data, [data_format] = @dataFormat,
                [embedding] = @embedding,
                [modified_by] = @modifiedBy, [modified_by_type] = @modifiedByType,
                [modified_at] = @modifiedAt, [modified_in_conversation] = @modifiedInConversation,
                [modified_from_message] = @modifiedFromMessage
              WHEN NOT MATCHED THEN INSERT (
                [repository_id], [entity_id], [slug], [entity_type], [label], [summary],
                [properties], [data], [data_format], [embedding],
                [created_by], [created_by_type], [created_at],
                [created_in_conversation], [created_from_message],
                [modified_by], [modified_by_type], [modified_at],
                [modified_in_conversation], [modified_from_message]
              ) VALUES (
                @repoId, @entityId, @slug, @entityType, @label, @summary,
                @properties, @data, @dataFormat, @embedding,
                @createdBy, @createdByType, @createdAt,
                @createdInConversation, @createdFromMessage,
                @modifiedBy, @modifiedByType, @modifiedAt,
                @modifiedInConversation, @modifiedFromMessage
              );
            `);
            entitiesImported++;
          }
        }

        if (chunk.relationships) {
          for (const rel of chunk.relationships) {
            current = {
              item: `relationship:${rel.id}`,
              context: { kind: 'relationship', relationshipId: rel.id },
            };
            const req = transaction.request()
              .input('repoId', sql.UniqueIdentifier, repositoryId)
              .input('relId', sql.NVarChar, rel.id)
              .input('relType', sql.NVarChar, rel.relationshipType)
              .input('sourceId', sql.NVarChar, rel.sourceEntityId)
              .input('targetId', sql.NVarChar, rel.targetEntityId)
              .input('properties', sql.NVarChar, JSON.stringify(rel.properties))
              .input('bidirectional', sql.Bit, rel.bidirectional ? 1 : 0);

            this.addProvenanceInputs(req, rel.provenance);

            await req.query(`
              MERGE ${this.t('dm_relationships')} AS target
              USING (SELECT @repoId AS repository_id, @relId AS relationship_id) AS source
              ON target.[repository_id] = source.repository_id AND target.[relationship_id] = source.relationship_id
              WHEN MATCHED THEN UPDATE SET
                [relationship_type] = @relType, [source_entity_id] = @sourceId,
                [target_entity_id] = @targetId, [properties] = @properties,
                [bidirectional] = @bidirectional,
                [modified_by] = @modifiedBy, [modified_by_type] = @modifiedByType,
                [modified_at] = @modifiedAt, [modified_in_conversation] = @modifiedInConversation,
                [modified_from_message] = @modifiedFromMessage
              WHEN NOT MATCHED THEN INSERT (
                [repository_id], [relationship_id], [relationship_type],
                [source_entity_id], [target_entity_id], [properties], [bidirectional],
                [created_by], [created_by_type], [created_at],
                [created_in_conversation], [created_from_message],
                [modified_by], [modified_by_type], [modified_at],
                [modified_in_conversation], [modified_from_message]
              ) VALUES (
                @repoId, @relId, @relType,
                @sourceId, @targetId, @properties, @bidirectional,
                @createdBy, @createdByType, @createdAt,
                @createdInConversation, @createdFromMessage,
                @modifiedBy, @modifiedByType, @modifiedAt,
                @modifiedInConversation, @modifiedFromMessage
              );
            `);
            relationshipsImported++;
          }
        }
      }
      current = undefined;
      await transaction.commit();
    } catch (err) {
      let rollbackError: unknown;
      try {
        await transaction.rollback();
      } catch (rollbackErr) {
        // Reported inside the import error below; it must not replace the
        // failure that caused the rollback.
        rollbackError = rollbackErr;
      }
      throw importFailure(err, current, rollbackError);
    }

    return { entitiesImported, relationshipsImported, errors: [] };
  }

  // ─── Private helpers ────────────────────────────────────────────

  /** Creates a TVP table from an array of string IDs (eliminates plan cache bloat from IN clauses). */
  private createIdListTvp(ids: string[]): sql.Table {
    const tvp = new sql.Table(`${this.schema}.dm_id_list`);
    tvp.columns.add('id', sql.NVarChar(300));
    for (const id of ids) tvp.rows.add(id);
    return tvp;
  }

  /**
   * Read entities by id, by ids or by slug in one batch that checks the
   * repository first (see `repositoryCheckSql`), so a missing repository
   * throws `RepositoryNotFoundError` rather than answering "no such entity".
   * A single id binds a scalar parameter; a list goes through the id-list TVP.
   */
  private async readEntitiesGuarded(
    repositoryId: string,
    operation: GuardedEntityReadOperation,
    match: { entityId: string } | { entityIds: string[] } | { slug: string },
    cols: string,
  ): Promise<StoredEntity[]> {
    const req = this.getPool().request().input('repoId', sql.UniqueIdentifier, repositoryId);
    let predicate: string;
    if ('entityId' in match) {
      req.input('entityId', sql.NVarChar, match.entityId);
      predicate = '[entity_id] = @entityId';
    } else if ('entityIds' in match) {
      req.input('entityIds', this.createIdListTvp(match.entityIds));
      predicate = '[entity_id] IN (SELECT [id] FROM @entityIds)';
    } else {
      req.input('slug', sql.NVarChar, match.slug);
      predicate = '[slug] = @slug';
    }

    const result = await req.query<[RepositoryCheckRow, Record<string, unknown>]>(
      `${this.repositoryCheckSql()}
       SELECT ${cols} FROM ${this.t('dm_entities')}
       WHERE [repository_id] = @repoId AND ${predicate};`,
    );
    this.assertRepositoryChecked(result.recordsets[0], repositoryId, operation);
    return result.recordsets[1].map(entityFromRow);
  }

  /** Returns multiple entities without embedding columns, using TVP for batch lookup. */
  private async getEntitiesLight(
    repositoryId: string,
    entityIds: string[],
  ): Promise<Map<string, StoredEntity>> {
    const pool = this.getPool();
    const result = new Map<string, StoredEntity>();
    if (entityIds.length === 0) return result;

    const tvp = this.createIdListTvp(entityIds);
    const rows = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityIds', tvp)
      .query<Record<string, unknown>>(
        `SELECT ${ENTITY_COLS_LIGHT} FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId
         AND [entity_id] IN (SELECT [id] FROM @entityIds)`,
      );

    for (const row of rows.recordset) {
      const entity = entityFromRow(row);
      result.set(entity.id, entity);
    }

    return result;
  }

  /**
   * Fetches relationships for multiple entity IDs in a single query using TVP.
   * Returns results grouped by the frontier entity ID.
   */
  private async getRelationshipsForEntities(
    repositoryId: string,
    entityIds: string[],
    direction: string,
    relationshipTypes?: string[],
  ): Promise<Map<string, StoredRelationship[]>> {
    const pool = this.getPool();
    const result = new Map<string, StoredRelationship[]>();
    if (entityIds.length === 0) return result;

    const tbl = this.t('dm_relationships');
    const tvp = this.createIdListTvp(entityIds);

    let rtFilter = '';
    const rtInputs: Array<{ name: string; value: string }> = [];
    if (relationshipTypes && relationshipTypes.length > 0) {
      const placeholders = relationshipTypes.map((t, i) => {
        rtInputs.push({ name: `rt${i}`, value: t });
        return `@rt${i}`;
      });
      rtFilter = ` AND [relationship_type] IN (${placeholders.join(',')})`;
    }

    // Build UNION ALL branches using TVP instead of single @entityId
    const srcBase = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [source_entity_id] IN (SELECT [id] FROM @entityIds)${rtFilter}`;
    const tgtBase = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [target_entity_id] IN (SELECT [id] FROM @entityIds)${rtFilter}`;
    const tgtBidi = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [target_entity_id] IN (SELECT [id] FROM @entityIds) AND [bidirectional] = 1${rtFilter}`;
    const srcBidi = `SELECT * FROM ${tbl} WHERE [repository_id] = @repoId AND [source_entity_id] IN (SELECT [id] FROM @entityIds) AND [bidirectional] = 1${rtFilter}`;

    let unionQuery: string;
    switch (direction) {
      case 'out':
        unionQuery = `${srcBase} UNION ALL ${tgtBidi}`;
        break;
      case 'in':
        unionQuery = `${tgtBase} UNION ALL ${srcBidi}`;
        break;
      case 'both':
      default:
        unionQuery = `${srcBase} UNION ALL ${tgtBase}`;
        break;
    }

    const req = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityIds', tvp);
    for (const p of rtInputs) req.input(p.name, sql.NVarChar, p.value);

    const rows = await req.query<Record<string, unknown>>(unionQuery);

    const entityIdSet = new Set(entityIds);
    for (const row of rows.recordset) {
      const rel = relationshipFromRow(row);
      // Determine which frontier entity this relationship belongs to
      const frontierIds: string[] = [];
      if (entityIdSet.has(rel.sourceEntityId)) frontierIds.push(rel.sourceEntityId);
      if (entityIdSet.has(rel.targetEntityId)) frontierIds.push(rel.targetEntityId);
      for (const fid of frontierIds) {
        let list = result.get(fid);
        if (!list) {
          list = [];
          result.set(fid, list);
        }
        list.push(rel);
      }
    }

    return result;
  }

  /**
   * Run a delete-by-ids batch in one round trip, only while the repository
   * row exists. `deletes` reads the ids from the `@ids` table parameter,
   * scopes every statement by `@repoId`, and records the ids it removed with
   * `OUTPUT ... INTO @deleted`.
   *
   * The batch reads the repository row under a shared lock held to the end
   * of its transaction, so `deleteRepository` (which locks that row first)
   * cannot remove the repository between the check and the deletes. Both
   * take the repository row before any other row, so the two cannot
   * deadlock on each other. With no repository row nothing is deleted and
   * the call throws `RepositoryNotFoundError`, ahead of any per-id outcome.
   * With `XACT_ABORT` on, an error anywhere in the batch rolls all of it
   * back.
   */
  private async deleteByIdsGuarded(
    repositoryId: string,
    ids: string[],
    operation: 'deleteEntities' | 'deleteRelationships',
    deletes: string,
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    const pool = this.getPool();
    let result: IResult<[RepositoryCheckRow, { id: string }]>;
    try {
      result = await pool.request()
        .input('repoId', sql.UniqueIdentifier, repositoryId)
        .input('ids', this.createIdListTvp(ids))
        .query<[RepositoryCheckRow, { id: string }]>(`
          SET XACT_ABORT ON;
          DECLARE @repositories INT = 0;
          DECLARE @deleted TABLE ([id] NVARCHAR(300) NOT NULL);
          BEGIN TRANSACTION;
          SELECT @repositories = 1
            FROM ${this.t('dm_repositories')} WITH (HOLDLOCK, ROWLOCK)
            WHERE [repository_id] = @repoId;
          IF @repositories = 1
          BEGIN
            ${deletes}
          END
          COMMIT TRANSACTION;
          SELECT @repositories AS repository_exists;
          SELECT [id] FROM @deleted;
        `);
    } catch (err) {
      throw new ProviderError(
        `SQL Server ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        'The batch is all-or-nothing; re-running is safe, and ids already removed report as not found.',
        { cause: err },
      );
    }

    this.assertRepositoryChecked(result.recordsets[0], repositoryId, operation);
    const deleted = (result.recordsets[1] ?? []).map((row) => row.id);
    const deletedSet = new Set(deleted);
    return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
  }

  /**
   * Head of a batch that must answer `RepositoryNotFoundError` for a missing
   * repository. Its result set always comes first and always has one row.
   * With no repository row the batch ends there (`RETURN`): it skips the
   * reads and returns exactly that one result set, so callers can index
   * `recordsets` by position and act on the check before touching the rest.
   * (A repository row is the only marker on SQL Server: foreign keys and the
   * single-transaction `deleteRepository` mean data never outlives it.)
   */
  private repositoryCheckSql(): string {
    return `IF NOT EXISTS (SELECT 1 FROM ${this.t('dm_repositories')} WHERE [repository_id] = @repoId)
       BEGIN
         SELECT 0 AS repository_exists;
         RETURN;
       END;
       SELECT 1 AS repository_exists;`;
  }

  /**
   * Act on the result set of `repositoryCheckSql`. A missing row means the
   * batch did not run as written, which is a provider failure, not a missing
   * repository.
   */
  private assertRepositoryChecked(
    rows: IRecordSet<RepositoryCheckRow> | undefined,
    repositoryId: string,
    operation: RepositoryCheckedOperation,
  ): void {
    const row = rows?.[0];
    if (row === undefined) {
      throw new ProviderError(`SQL Server ${operation} returned no repository check row.`);
    }
    if (row.repository_exists !== 1) throw new RepositoryNotFoundError(repositoryId);
  }

  /**
   * Delete by type in one batch and one transaction that takes the
   * repository row first, with `HOLDLOCK` to the end of the transaction, in
   * the same order as `deleteRepository` and `deleteByIdsGuarded`. With no
   * repository row nothing is deleted and the call throws
   * `RepositoryNotFoundError`. `deletes` adds what it removes to
   * `@deletedEntities` / `@deletedRelationships`; with `XACT_ABORT` on, an
   * error anywhere rolls all of it back.
   */
  private async deleteByTypeGuarded(
    repositoryId: string,
    operation: 'deleteEntitiesByType' | 'deleteRelationshipsByType',
    request: sql.Request,
    deletes: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    let result: IResult<{ repository_exists: number; deleted_entities: number; deleted_relationships: number }>;
    try {
      result = await request
        .input('repoId', sql.UniqueIdentifier, repositoryId)
        .query<{ repository_exists: number; deleted_entities: number; deleted_relationships: number }>(`
          SET XACT_ABORT ON;
          DECLARE @repositories INT = 0;
          DECLARE @deletedEntities INT = 0;
          DECLARE @deletedRelationships INT = 0;
          BEGIN TRANSACTION;
          SELECT @repositories = 1
            FROM ${this.t('dm_repositories')} WITH (HOLDLOCK, ROWLOCK)
            WHERE [repository_id] = @repoId;
          IF @repositories = 1
          BEGIN
            ${deletes}
          END
          COMMIT TRANSACTION;
          SELECT @repositories AS repository_exists,
                 @deletedEntities AS deleted_entities,
                 @deletedRelationships AS deleted_relationships;
        `);
    } catch (err) {
      throw new ProviderError(
        `SQL Server ${operation} failed: ${err instanceof Error ? err.message : String(err)}`,
        'The delete is all-or-nothing; re-running it is safe.',
        { cause: err },
      );
    }

    const row = result.recordset[0];
    if (row === undefined) {
      throw new ProviderError(`SQL Server ${operation} returned no result row.`);
    }
    if (row.repository_exists !== 1) throw new RepositoryNotFoundError(repositoryId);
    return { deletedEntities: row.deleted_entities, deletedRelationships: row.deleted_relationships };
  }

  private async assertRepository(repositoryId: string): Promise<void> {
    const repo = await this.getRepository(repositoryId);
    if (!repo) {
      throw new RepositoryNotFoundError(repositoryId);
    }
  }

  private addProvenanceInputs(req: sql.Request, provenance: Provenance): void {
    req.input('createdBy', sql.NVarChar, provenance.createdBy);
    req.input('createdByType', sql.NVarChar, provenance.createdByType);
    req.input('createdAt', sql.NVarChar, provenance.createdAt);
    req.input('createdInConversation', sql.NVarChar, provenance.createdInConversation ?? null);
    req.input('createdFromMessage', sql.NVarChar, provenance.createdFromMessage ?? null);
    req.input('modifiedBy', sql.NVarChar, provenance.modifiedBy);
    req.input('modifiedByType', sql.NVarChar, provenance.modifiedByType);
    req.input('modifiedAt', sql.NVarChar, provenance.modifiedAt);
    req.input('modifiedInConversation', sql.NVarChar, provenance.modifiedInConversation ?? null);
    req.input('modifiedFromMessage', sql.NVarChar, provenance.modifiedFromMessage ?? null);
  }
}
