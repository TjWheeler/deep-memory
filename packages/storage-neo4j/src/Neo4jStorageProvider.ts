// Neo4jStorageProvider — Neo4j implementation of @utaba/deep-memory's
// StorageProvider. Phase 2 scope: constructor / lifecycle / ensureSchema.
// CRUD methods land in Phases 4–7 and the `implements StorageProvider`
// declaration is added once the surface is complete.

import type { EnsureSchemaResult } from '@utaba/deep-memory/providers';
import { ProviderError } from '@utaba/deep-memory';
import { Neo4jConnection, type Neo4jConnectionConfig } from './Neo4jConnection.js';
import { getSchemaCypher, SCHEMA_VERSION } from './schema.js';

/** Configuration for `Neo4jStorageProvider`. */
export interface Neo4jStorageProviderConfig extends Neo4jConnectionConfig {
  // Reserved for Phase 3 — `reportUsage?: UsageSink` lands once the
  // server_ms sink wiring is in place. Intentionally not added here so the
  // public config stays minimal until that contract is built.
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
