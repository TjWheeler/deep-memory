// SqlServerStorageProvider — SQL Server implementation of StorageProvider

import sql from 'mssql';
import type { StorageProvider, EnsureSchemaResult } from '@utaba/deep-memory/providers';
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
import type { ExportChunk, ImportChunk } from '@utaba/deep-memory/types';
import type { Provenance } from '@utaba/deep-memory/types';
import {
  RepositoryNotFoundError,
  DuplicateRepositoryError,
  EntityNotFoundError,
  DuplicateEntityError,
  RelationshipNotFoundError,
  DuplicateRelationshipError,
  ProviderError,
  matchesPropertyFilters,
  createSafeSink,
} from '@utaba/deep-memory';
import { getSchemaSQL, SCHEMA_VERSION } from './schema.js';

const PROVIDER_NAME = 'sqlserver';

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

/**
 * Add provenance filter conditions to a SQL query.
 * Uses a prefix to avoid parameter name collisions across data/count requests.
 */
function addProvenanceConditions(
  req: sql.Request,
  prov: import('@utaba/deep-memory').ProvenanceFilter,
  conditions: string[],
  prefix: string,
): void {
  if (prov.conversationIds && prov.conversationIds.length > 0) {
    const placeholders = prov.conversationIds.map((id, i) => {
      req.input(`${prefix}ConvId${i}`, sql.NVarChar, id);
      return `@${prefix}ConvId${i}`;
    });
    const inClause = placeholders.join(',');
    conditions.push(`([created_in_conversation] IN (${inClause}) OR [modified_in_conversation] IN (${inClause}))`);
  }
  if (prov.actors && prov.actors.length > 0) {
    const placeholders = prov.actors.map((a, i) => {
      req.input(`${prefix}Actor${i}`, sql.NVarChar, a);
      return `@${prefix}Actor${i}`;
    });
    const inClause = placeholders.join(',');
    conditions.push(`([created_by] IN (${inClause}) OR [modified_by] IN (${inClause}))`);
  }
  if (prov.dateRange) {
    req.input(`${prefix}DateFrom`, sql.NVarChar, prov.dateRange.from);
    req.input(`${prefix}DateTo`, sql.NVarChar, prov.dateRange.to);
    conditions.push(`([created_at] >= @${prefix}DateFrom AND [created_at] <= @${prefix}DateTo) OR ([modified_at] >= @${prefix}DateFrom AND [modified_at] <= @${prefix}DateTo)`);
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

  async createRepository(config: StorageRepositoryConfig): Promise<StoredRepository> {
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
      `);

    // Create empty vocabulary
    const emptyVocabulary: MemoryVocabulary = {
      version: '0.0.0',
      lastModified: config.createdAt,
      modifiedBy: config.createdBy,
      entityTypes: [],
      relationshipTypes: [],
    };

    await pool.request()
      .input('id', sql.UniqueIdentifier, config.repositoryId)
      .input('vocabulary', sql.NVarChar, JSON.stringify(emptyVocabulary))
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

  async deleteRepository(repositoryId: string, _onProgress?: import('@utaba/deep-memory/types').DeleteProgressCallback): Promise<void> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query(`DELETE FROM ${this.t('dm_repositories')} WHERE [repository_id] = @id`);

    if (result.rowsAffected[0] === 0) {
      throw new RepositoryNotFoundError(repositoryId);
    }
  }

  async deleteAllContents(repositoryId: string, _onProgress?: import('@utaba/deep-memory/types').DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }> {
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

  async getRepositoryStats(repositoryId: string): Promise<RepositoryStats> {
    await this.assertRepository(repositoryId);
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

  async getVocabulary(repositoryId: string): Promise<MemoryVocabulary> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query<{ vocabulary: string }>(
        `SELECT [vocabulary] FROM ${this.t('dm_vocabularies')} WHERE [repository_id] = @id`,
      );

    const row = result.recordset[0];
    if (!row) {
      // Should not happen if repository exists, but handle gracefully
      return {
        version: '0.0.0',
        lastModified: new Date().toISOString(),
        modifiedBy: 'system',
        entityTypes: [],
        relationshipTypes: [],
      };
    }

    return JSON.parse(row.vocabulary) as MemoryVocabulary;
  }

  async saveVocabulary(repositoryId: string, vocabulary: MemoryVocabulary): Promise<void> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .input('vocabulary', sql.NVarChar, JSON.stringify(vocabulary))
      .query(`
        UPDATE ${this.t('dm_vocabularies')}
        SET [vocabulary] = @vocabulary
        WHERE [repository_id] = @id
      `);
  }

  async getVocabularyChangeLog(
    repositoryId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<VocabularyChangeRecord>> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;

    const countResult = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM ${this.t('dm_vocabulary_change_log')} WHERE [repository_id] = @id`,
      );
    const total = countResult.recordset[0]?.cnt ?? 0;

    const result = await pool.request()
      .input('id', sql.UniqueIdentifier, repositoryId)
      .input('limit', sql.Int, limit)
      .input('offset', sql.Int, offset)
      .query<Record<string, unknown>>(
        `SELECT * FROM ${this.t('dm_vocabulary_change_log')}
         WHERE [repository_id] = @id
         ORDER BY [proposed_at] DESC
         OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
      );

    return {
      items: result.recordset.map(changeRecordFromRow),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  // ─── Entities ────────────────────────────────────────────────────

  async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
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
    `);

    return entity;
  }

  async getEntity(repositoryId: string, entityId: string): Promise<StoredEntity | null> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId)
      .query<Record<string, unknown>>(
        `SELECT ${ENTITY_COLS_LIGHT} FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId AND [entity_id] = @entityId`,
      );

    const row = result.recordset[0];
    if (!row) return null;
    return entityFromRow(row);
  }

  async getEntityBySlug(repositoryId: string, slug: string): Promise<StoredEntity | null> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('slug', sql.NVarChar, slug)
      .query<Record<string, unknown>>(
        `SELECT ${ENTITY_COLS_LIGHT} FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId AND [slug] = @slug`,
      );

    const row = result.recordset[0];
    if (!row) return null;
    return entityFromRow(row);
  }

  async getEntities(
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

  async updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity> {
    const pool = this.getPool();

    // Get existing entity
    const existing = await this.getEntity(repositoryId, entityId);
    if (!existing) {
      throw new EntityNotFoundError(entityId);
    }

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

    await req.query(`
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
    `);

    return updated;
  }

  async deleteEntity(repositoryId: string, entityId: string): Promise<void> {
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
      throw new EntityNotFoundError(entityId);
    }
  }

  async deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) return { deleted: [], notFound: [] };

    const pool = this.getPool();

    // Cascade: delete relationships where any of these entities is source or target
    const tvp1 = this.createIdListTvp(ids);
    const cascadeReq = pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityIds', tvp1);
    await cascadeReq.query(`
      DELETE FROM ${this.t('dm_relationships')}
        WHERE [repository_id] = @repoId AND [source_entity_id] IN (SELECT [id] FROM @entityIds);
      DELETE FROM ${this.t('dm_relationships')}
        WHERE [repository_id] = @repoId AND [target_entity_id] IN (SELECT [id] FROM @entityIds);
    `);

    // Delete entities — OUTPUT DELETED tells us which rows actually existed
    const tvp2 = this.createIdListTvp(ids);
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityIds', tvp2)
      .query<{ entity_id: string }>(
        `DELETE FROM ${this.t('dm_entities')}
         OUTPUT DELETED.[entity_id]
         WHERE [repository_id] = @repoId
           AND [entity_id] IN (SELECT [id] FROM @entityIds)`,
      );

    const deleted = result.recordset.map((row) => row.entity_id);
    const deletedSet = new Set(deleted);
    return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
  }

  async deleteEntitiesByType(
    repositoryId: string,
    entityType: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    // Delete relationships where entities of this type are the SOURCE
    const srcResult = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityType', sql.NVarChar, entityType)
      .query(`
        DELETE r FROM ${this.t('dm_relationships')} r
        INNER JOIN ${this.t('dm_entities')} e
          ON r.[repository_id] = e.[repository_id]
          AND r.[source_entity_id] = e.[entity_id]
        WHERE e.[repository_id] = @repoId AND e.[entity_type] = @entityType
      `);

    // Delete relationships where entities of this type are the TARGET
    const tgtResult = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityType', sql.NVarChar, entityType)
      .query(`
        DELETE r FROM ${this.t('dm_relationships')} r
        INNER JOIN ${this.t('dm_entities')} e
          ON r.[repository_id] = e.[repository_id]
          AND r.[target_entity_id] = e.[entity_id]
        WHERE e.[repository_id] = @repoId AND e.[entity_type] = @entityType
      `);

    const deletedRelationships = (srcResult.rowsAffected[0] ?? 0) + (tgtResult.rowsAffected[0] ?? 0);

    // Delete the entities
    const entResult = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityType', sql.NVarChar, entityType)
      .query(
        `DELETE FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId AND [entity_type] = @entityType`,
      );
    const deletedEntities = entResult.rowsAffected[0] ?? 0;

    return { deletedEntities, deletedRelationships };
  }

  async findEntities(
    repositoryId: string,
    query: StorageFindQuery,
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
      addProvenanceConditions(req, query.provenance, conditions, 'data');
    }

    const where = conditions.join(' AND ');

    // Build a separate request for the count (mssql doesn't allow reusing requests)

    const countReq = pool.request().input('repoId', sql.UniqueIdentifier, repositoryId);
    const countConditions = ['[repository_id] = @repoId'];

    if (query.entityTypes && query.entityTypes.length > 0) {
      const typePlaceholders = query.entityTypes.map((t, i) => {
        countReq.input(`et${i}`, sql.NVarChar, t);
        return `@et${i}`;
      });
      countConditions.push(`[entity_type] IN (${typePlaceholders.join(',')})`);
    }
    if (query.searchTerm) {
      countReq.input('searchTerm', sql.NVarChar, `%${query.searchTerm}%`);
      countConditions.push(`([label] LIKE @searchTerm OR [summary] LIKE @searchTerm)`);
    }
    if (query.properties) {
      const entries = Object.entries(query.properties);
      for (let i = 0; i < entries.length; i++) {
        const [key, value] = entries[i]!;
        countReq.input(`propKey${i}`, sql.NVarChar, `$.${key}`);
        countReq.input(`propVal${i}`, sql.NVarChar, String(value));
        countConditions.push(`JSON_VALUE([properties], @propKey${i}) = @propVal${i}`);
      }
    }

    // Provenance filter (count query)
    if (query.provenance) {
      addProvenanceConditions(countReq, query.provenance, countConditions, 'count');
    }

    const countWhere = countConditions.join(' AND ');
    const totalResult = await countReq.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM ${this.t('dm_entities')} WHERE ${countWhere}`,
    );
    const total = totalResult.recordset[0]?.cnt ?? 0;

    // Fetch page
    req.input('limit', sql.Int, query.limit);
    req.input('offset', sql.Int, query.offset);

    const result = await req.query<Record<string, unknown>>(
      `SELECT ${ENTITY_COLS_LIGHT} FROM ${this.t('dm_entities')}
       WHERE ${where}
       ORDER BY [entity_id]
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    );

    return {
      items: result.recordset.map(entityFromRow),
      total,
      hasMore: query.offset + query.limit < total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  // ─── Relationships ──────────────────────────────────────────────

  async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
  ): Promise<StoredRelationship> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    // Check for duplicate
    const existing = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationship.id)
      .query<{ relationship_id: string }>(
        `SELECT [relationship_id] FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [relationship_id] = @relId`,
      );

    if (existing.recordset.length > 0) {
      throw new DuplicateRelationshipError(relationship.id);
    }

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
    `);

    return relationship;
  }

  async getRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<StoredRelationship | null> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationshipId)
      .query<Record<string, unknown>>(
        `SELECT * FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [relationship_id] = @relId`,
      );

    const row = result.recordset[0];
    if (!row) return null;
    return relationshipFromRow(row);
  }

  async getEntityRelationships(
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

    const addParams = (req: sql.Request): sql.Request => {
      req.input('repoId', sql.UniqueIdentifier, repositoryId);
      req.input('entityId', sql.NVarChar, entityId);
      for (const p of rtInputs) req.input(p.name, sql.NVarChar, p.value);
      return req;
    };

    // Count
    const countReq = addParams(pool.request());
    const totalResult = await countReq.query<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM (${unionBranches}) AS _u`,
    );
    const total = totalResult.recordset[0]?.cnt ?? 0;

    // Fetch page
    const fetchReq = addParams(pool.request());
    fetchReq.input('limit', sql.Int, limit);
    fetchReq.input('offset', sql.Int, offset);

    const result = await fetchReq.query<Record<string, unknown>>(
      `SELECT * FROM (${unionBranches}) AS _u
       ORDER BY [relationship_id]
       OFFSET @offset ROWS FETCH NEXT @limit ROWS ONLY`,
    );

    let items = result.recordset.map(relationshipFromRow);

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
      case 'outbound':
        // Outbound = where entity is source, OR where entity is target of a bidirectional rel
        return `${srcBase} UNION ALL ${tgtBidi} AND [source_entity_id] <> @entityId`;
      case 'inbound':
        // Inbound = where entity is target, OR where entity is source of a bidirectional rel
        return `${tgtBase} UNION ALL ${srcBidi} AND [target_entity_id] <> @entityId`;
      case 'both':
      default:
        // Both = where entity is source UNION where entity is target (excluding duplicates from source branch)
        return `${srcBase} UNION ALL ${tgtBase} AND [source_entity_id] <> @entityId`;
    }
  }

  async deleteRelationship(repositoryId: string, relationshipId: string): Promise<void> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relId', sql.NVarChar, relationshipId)
      .query(
        `DELETE FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [relationship_id] = @relId`,
      );

    if (result.rowsAffected[0] === 0) {
      throw new RelationshipNotFoundError(relationshipId);
    }
  }

  async deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    if (ids.length === 0) return { deleted: [], notFound: [] };

    const pool = this.getPool();
    const tvp = this.createIdListTvp(ids);
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relIds', tvp)
      .query<{ relationship_id: string }>(
        `DELETE FROM ${this.t('dm_relationships')}
         OUTPUT DELETED.[relationship_id]
         WHERE [repository_id] = @repoId
           AND [relationship_id] IN (SELECT [id] FROM @relIds)`,
      );

    const deleted = result.recordset.map((row) => row.relationship_id);
    const deletedSet = new Set(deleted);
    return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
  }

  async deleteRelationshipsByType(
    repositoryId: string,
    relationshipType: string,
  ): Promise<{ deletedRelationships: number }> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();

    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('relType', sql.NVarChar, relationshipType)
      .query(
        `DELETE FROM ${this.t('dm_relationships')}
         WHERE [repository_id] = @repoId AND [relationship_type] = @relType`,
      );

    return { deletedRelationships: result.rowsAffected[0] ?? 0 };
  }

  // ─── Graph Traversal ────────────────────────────────────────────

  async exploreNeighborhood(
    repositoryId: string,
    entityId: string,
    options: StorageExploreOptions,
  ): Promise<StorageNeighborhood> {
    // Verify the center entity exists (light — no embedding needed)
    const center = await this.getEntityLight(repositoryId, entityId);
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

  async findPaths(
    repositoryId: string,
    sourceId: string,
    targetId: string,
    options: StoragePathOptions,
  ): Promise<StoragePathResult> {
    // Verify both entities exist (light — no embedding needed)
    const [source, target] = await Promise.all([
      this.getEntityLight(repositoryId, sourceId),
      this.getEntityLight(repositoryId, targetId),
    ]);
    if (!source) throw new EntityNotFoundError(sourceId);
    if (!target) throw new EntityNotFoundError(targetId);

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

  async getTimeline(
    repositoryId: string,
    entityId: string,
    options: StorageTimelineOptions,
  ): Promise<StorageTimelineResult> {
    const entity = await this.getEntityLight(repositoryId, entityId);
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

  async *exportAll(repositoryId: string): AsyncIterable<ExportChunk> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();
    const batchSize = 100;

    // Export entities
    const entityCount = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .query<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM ${this.t('dm_entities')} WHERE [repository_id] = @repoId`,
      );
    const totalEntities = entityCount.recordset[0]?.cnt ?? 0;

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

  async importBulk(
    repositoryId: string,
    data: ImportChunk[],
    _options?: import('@utaba/deep-memory/types').BulkImportOptions,
  ): Promise<BulkImportResult> {
    await this.assertRepository(repositoryId);
    const pool = this.getPool();
    let entitiesImported = 0;
    let relationshipsImported = 0;

    const transaction = pool.transaction();
    await transaction.begin();
    try {
      for (const chunk of data) {
        if (chunk.entities) {
          for (const entity of chunk.entities) {
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
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
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

  /** Returns a StoredEntity without the embedding column (lighter I/O). */
  private async getEntityLight(repositoryId: string, entityId: string): Promise<StoredEntity | null> {
    const pool = this.getPool();
    const result = await pool.request()
      .input('repoId', sql.UniqueIdentifier, repositoryId)
      .input('entityId', sql.NVarChar, entityId)
      .query<Record<string, unknown>>(
        `SELECT ${ENTITY_COLS_LIGHT} FROM ${this.t('dm_entities')}
         WHERE [repository_id] = @repoId AND [entity_id] = @entityId`,
      );

    const row = result.recordset[0];
    if (!row) return null;
    return entityFromRow(row);
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
      case 'outbound':
        unionQuery = `${srcBase} UNION ALL ${tgtBidi}`;
        break;
      case 'inbound':
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
