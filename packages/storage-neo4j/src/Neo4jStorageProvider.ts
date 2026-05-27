// Neo4jStorageProvider — Neo4j implementation of @utaba/deep-memory's
// StorageProvider. CRUD methods are added incrementally; the `implements
// StorageProvider` declaration is added once the surface is complete.

import type { EnsureSchemaResult } from '@utaba/deep-memory/providers';
import type { UsageSink } from '@utaba/deep-memory/types';
import { ProviderError, createSafeSink } from '@utaba/deep-memory';
import { Neo4jConnection, type Neo4jConnectionConfig } from './Neo4jConnection.js';
import { getSchemaCypher, SCHEMA_VERSION } from './schema.js';
import {
  buildUsageDetails,
  createUsageScope,
  runInUsageScope,
} from './usageScope.js';

const PROVIDER_NAME = 'neo4j';

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
}
