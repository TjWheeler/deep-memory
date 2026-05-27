// Neo4jConnection — the single chokepoint for every Bolt round-trip in this
// provider. No other source file under src/ is allowed to import `neo4j-driver`
// directly or call `driver.session()` / `driver.executeQuery()` — see D3b
// (Isolation guarantee) in plans/neo4j-provider.md and the grep test that
// enforces it.

import neo4j from 'neo4j-driver';
import type {
  Driver,
  EagerResult,
  ManagedTransaction,
  RecordShape,
  ResultSummary,
  RoutingControl,
  ServerInfo,
} from 'neo4j-driver';
import { ProviderError } from '@utaba/deep-memory';
import { recordRoundTrip } from './usageScope.js';

/**
 * Cypher parameters are arbitrary Bolt-encodable values keyed by name.
 * TypeScript cannot statically validate the shape against Cypher's runtime
 * contract, so the boundary type is intentionally `unknown` — narrower
 * "real types" only exist call-site by call-site.
 */
export type CypherParams = Record<string, unknown>;

/** Connection configuration. */
export interface Neo4jConnectionConfig {
  /** Bolt URI, e.g. `bolt://localhost:7687` or `neo4j+s://aura-host`. */
  uri: string;
  /** Username for basic auth. */
  username: string;
  /** Password for basic auth. */
  password: string;
  /**
   * Database name. Per the driver manual, this should be specified explicitly
   * even on single-database Community instances. Defaults to `'neo4j'`.
   */
  database?: string;
  /** User-agent string sent on the Bolt handshake. */
  userAgent?: string;
  /** Maximum time (ms) the driver will retry a managed transaction. */
  maxTransactionRetryTime?: number;
}

/** Options for `executeQuery` — required `repositoryId` enforces D3b layer 2. */
export interface ExecuteQueryOptions {
  repositoryId: string;
  routing?: RoutingControl;
}

/** Options for `executeSystemQuery` — the explicit cross-repository allowlist. */
export interface ExecuteSystemQueryOptions {
  /** Must be `true`. Forces every caller to spell out the elevation. */
  crossRepository: true;
  routing?: RoutingControl;
}

const DEFAULT_DATABASE = 'neo4j';
const DEFAULT_USER_AGENT = '@utaba/deep-memory-storage-neo4j';
const RID_TOKEN_PATTERN = /\$rid\b/;
const NOTIFICATION_QUERY_TRUNCATION = 200;

/**
 * Wrapper around the official `neo4j-driver`. One instance per provider —
 * driver creation is expensive and the driver itself is documented as
 * "immutable, thread-safe" and meant to be shared. The instance is `private`
 * on the provider; the only legitimate entry points are the helpers below.
 */
export class Neo4jConnection {
  private readonly driver: Driver;
  private readonly database: string;

  constructor(config: Neo4jConnectionConfig) {
    this.database = config.database ?? DEFAULT_DATABASE;
    this.driver = neo4j.driver(
      config.uri,
      neo4j.auth.basic(config.username, config.password),
      {
        // BigInt for INTEGER avoids silent precision loss on counts that may
        // exceed Number.MAX_SAFE_INTEGER — see D6b. The mapping layer
        // narrows BigInt → Number at the public-API boundary.
        useBigInt: true,
        userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
        ...(config.maxTransactionRetryTime !== undefined
          ? { maxTransactionRetryTime: config.maxTransactionRetryTime }
          : {}),
      },
    );
  }

  /** Verify the driver can reach the server. Throws on failure. */
  public async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity({ database: this.database });
  }

  /** Returns server version / edition metadata for diagnostics. */
  public async getServerInfo(): Promise<ServerInfo> {
    return this.driver.getServerInfo({ database: this.database });
  }

  /** Close the driver and release all connections. */
  public async close(): Promise<void> {
    await this.driver.close();
  }

  /**
   * Run a single-statement query scoped to a repository.
   *
   * Required `repositoryId` binds `$rid` for the caller. The Cypher string
   * MUST reference `$rid` somewhere in a predicate or property map; absence
   * throws `ProviderError` as a programming error (D3b layer 2).
   */
  public async executeQuery<T extends RecordShape = RecordShape>(
    cypher: string,
    params: CypherParams,
    options: ExecuteQueryOptions,
  ): Promise<EagerResult<T>> {
    this.assertRepositoryId(options.repositoryId);
    this.assertScoped(cypher);
    const result = await this.driver.executeQuery<EagerResult<T>>(
      cypher,
      { ...params, rid: options.repositoryId },
      {
        database: this.database,
        ...(options.routing !== undefined ? { routing: options.routing } : {}),
      },
    );
    recordRoundTrip(result.summary, result.records.length);
    this.surfaceNotifications(cypher, result.summary);
    return result;
  }

  /**
   * Run a managed write transaction scoped to a repository. Use only when
   * more than one Cypher statement must commit atomically — single-statement
   * writes go through `executeQuery` so the driver handles transient-error
   * retry uniformly (D2b).
   *
   * Every `tx.run` call inside `txFn` is wrapped to inject `$rid` and assert
   * scope, so the same isolation enforcement applies as on the default path.
   * The transaction function MUST be idempotent (the driver retries on
   * transient errors) and MUST NOT return the raw `Result` — process records
   * inside the function and return mapped data.
   */
  public async executeWrite<T>(
    repositoryId: string,
    txFn: (tx: ScopedTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runManaged('write', repositoryId, txFn);
  }

  /**
   * Run a managed read transaction scoped to a repository. Same isolation
   * contract as `executeWrite`.
   */
  public async executeRead<T>(
    repositoryId: string,
    txFn: (tx: ScopedTransaction) => Promise<T>,
  ): Promise<T> {
    return this.runManaged('read', repositoryId, txFn);
  }

  /**
   * Cross-repository escape hatch. Reserved for the small allowlist of
   * legitimate cross-repository operations: `ensureSchema` (DDL),
   * `listRepositories`, `_Meta` schema-version reads, server-info probes.
   * Does NOT inject `$rid`. Every call site MUST add a one-line comment
   * justifying why cross-repository access is correct (D3b).
   */
  public async executeSystemQuery<T extends RecordShape = RecordShape>(
    cypher: string,
    params: CypherParams,
    options: ExecuteSystemQueryOptions,
  ): Promise<EagerResult<T>> {
    if (options.crossRepository !== true) {
      throw new ProviderError(
        'executeSystemQuery requires crossRepository: true — use executeQuery for repository-scoped Cypher.',
      );
    }
    const result = await this.driver.executeQuery<EagerResult<T>>(cypher, params, {
      database: this.database,
      ...(options.routing !== undefined ? { routing: options.routing } : {}),
    });
    recordRoundTrip(result.summary, result.records.length);
    this.surfaceNotifications(cypher, result.summary);
    return result;
  }

  /**
   * Run a single DDL statement on a session (auto-commit). Used for schema
   * setup — `CREATE CONSTRAINT` / `CREATE INDEX` statements cannot run inside
   * a managed transaction in Cypher 25 and must be issued one per call.
   * Cross-repository by definition.
   */
  public async executeSystemDdl(cypher: string): Promise<ResultSummary> {
    const session = this.driver.session({ database: this.database });
    try {
      const result = await session.run(cypher);
      recordRoundTrip(result.summary, result.records.length);
      this.surfaceNotifications(cypher, result.summary);
      return result.summary;
    } finally {
      await session.close();
    }
  }

  private async runManaged<T>(
    mode: 'read' | 'write',
    repositoryId: string,
    txFn: (tx: ScopedTransaction) => Promise<T>,
  ): Promise<T> {
    this.assertRepositoryId(repositoryId);
    const session = this.driver.session({ database: this.database });
    try {
      const wrapped = (managed: ManagedTransaction): Promise<T> =>
        txFn(new ScopedTransaction(managed, repositoryId, this.surfaceNotifications.bind(this)));
      return mode === 'write'
        ? await session.executeWrite(wrapped)
        : await session.executeRead(wrapped);
    } finally {
      await session.close();
    }
  }

  private assertRepositoryId(repositoryId: string): void {
    if (typeof repositoryId !== 'string' || repositoryId.length === 0) {
      throw new ProviderError(
        'Neo4jConnection: repositoryId is required for scoped queries (D3b isolation guarantee).',
      );
    }
  }

  private assertScoped(cypher: string): void {
    if (!RID_TOKEN_PATTERN.test(cypher)) {
      throw new ProviderError(
        'Neo4jConnection: Cypher omits required $rid binding. ' +
          'Repository-scoped queries MUST reference $rid in a predicate or property map. ' +
          'Use executeSystemQuery for cross-repository calls (D3b allowlist).',
      );
    }
  }

  private surfaceNotifications(cypher: string, summary: ResultSummary): void {
    const items = collectNonInformationNotifications(summary);
    if (items.length === 0) return;
    const truncated =
      cypher.length > NOTIFICATION_QUERY_TRUNCATION
        ? `${cypher.slice(0, NOTIFICATION_QUERY_TRUNCATION)}…`
        : cypher;
    // One warn per emission keeps the signal scannable; the full notifications
    // array intentionally does NOT flow into the usage sink (D14).
    // eslint-disable-next-line no-console
    console.warn('[neo4j] notifications', { cypher: truncated, notifications: items });
  }
}

/**
 * `tx.run` wrapper used inside managed transactions. Carries the same
 * isolation enforcement as `Neo4jConnection.executeQuery` so transaction
 * functions cannot bypass the chokepoint.
 */
export class ScopedTransaction {
  constructor(
    private readonly tx: ManagedTransaction,
    private readonly repositoryId: string,
    private readonly notify: (cypher: string, summary: ResultSummary) => void,
  ) {}

  /**
   * Run a single statement inside the managed transaction. Injects `$rid`
   * and asserts the Cypher string references it.
   */
  public async run<T extends RecordShape = RecordShape>(
    cypher: string,
    params: CypherParams,
  ): Promise<{ records: Array<import('neo4j-driver').Record<T>>; summary: ResultSummary }> {
    if (!RID_TOKEN_PATTERN.test(cypher)) {
      throw new ProviderError(
        'ScopedTransaction.run: Cypher omits required $rid binding. ' +
          'Multi-statement writes still flow through the isolation chokepoint.',
      );
    }
    const queryResult = await this.tx.run<T>(cypher, { ...params, rid: this.repositoryId });
    const records = queryResult.records;
    const summary = queryResult.summary;
    recordRoundTrip(summary, records.length);
    this.notify(cypher, summary);
    return { records, summary };
  }
}

interface CollectedNotification {
  severity: string;
  category: string;
  code: string;
  title: string;
  description: string;
}

/**
 * Surface real warnings from a `ResultSummary` without drowning callers in
 * the always-present "successful completion" sentinels.
 *
 * Per probe P15 (local-tests/baseline/neo4j-phase3-probes-results.md):
 *
 * - `summary.notifications` is the legacy server-side filtered surface; if it
 *   is non-empty the server already decided the entries are worth flagging
 *   (`UNRECOGNIZED`, `PERFORMANCE`, `DEPRECATION`, etc.). Prefer it.
 * - `summary.gqlStatusObjects` always includes a `severity=UNKNOWN
 *   classification=UNKNOWN` "successful completion" entry, plus tags many
 *   PERFORMANCE warnings (e.g. cartesian product) as `severity=INFORMATION`
 *   which a naive filter on `severity !== 'INFORMATION'` would silently drop.
 *
 * Strategy: dedup the legacy `notifications` first; supplement with
 * `gqlStatusObjects` entries whose severity is `WARNING` or `ERROR` (the
 * post-Cypher-25 GQL severities worth raising).
 */
function collectNonInformationNotifications(summary: ResultSummary): CollectedNotification[] {
  type LegacyLike = {
    severity?: string;
    category?: string;
    code?: string;
    title?: string;
    description?: string;
  };
  type GqlLike = {
    severity?: string;
    classification?: string;
    gqlStatus?: string;
    title?: string;
    description?: string;
    statusDescription?: string;
  };
  const summaryLike = summary as unknown as {
    gqlStatusObjects?: GqlLike[];
    notifications?: LegacyLike[];
  };
  const out: CollectedNotification[] = [];
  const seen = new Set<string>();
  for (const item of summaryLike.notifications ?? []) {
    const entry: CollectedNotification = {
      severity: item.severity ?? '',
      category: item.category ?? '',
      code: item.code ?? '',
      title: item.title ?? '',
      description: item.description ?? '',
    };
    const key = entry.code || entry.title;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }
  for (const item of summaryLike.gqlStatusObjects ?? []) {
    const severity = item.severity ?? '';
    if (severity !== 'WARNING' && severity !== 'ERROR') continue;
    const entry: CollectedNotification = {
      severity,
      category: item.classification ?? '',
      code: item.gqlStatus ?? '',
      title: item.title ?? '',
      description: item.description ?? item.statusDescription ?? '',
    };
    const key = entry.code || entry.title || entry.description;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }
  return out;
}
