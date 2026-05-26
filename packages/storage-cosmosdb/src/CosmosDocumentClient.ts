// CosmosDocumentClient — Cosmos NoSQL (Document) endpoint client.
//
// Used by query paths that the Gremlin subset can't express server-side
// (substring + case-insensitive matching, structured property predicates).
// Both this client and CosmosDbConnection (Gremlin) write RU into the active
// usageScope so a single public method spanning both endpoints emits one
// usage record.
//
// Transport: raw fetch + HMAC, the same pattern as cosmos-rest-auth.ts. No
// @azure/cosmos SDK dependency — keeps the provider's runtime footprint small
// and matches what `ensureSchema()` already does for container provisioning.

import { cosmosAuthToken } from './cosmos-rest-auth.js';
import { usageScope } from './usage.js';

export interface CosmosDocumentClientConfig {
  /** Cosmos NoSQL REST endpoint (e.g. https://host.docker.internal:8081). */
  restEndpoint: string;
  /** CosmosDB primary key (base64). */
  key: string;
  /** Database id. */
  database: string;
  /** Container id. */
  container: string;
  /** Whether to reject unauthorized TLS certs — set false for emulator. */
  rejectUnauthorized: boolean;
  /** Max retries for 429/503 (default: 3). */
  maxRetries?: number;
  /** Default query timeout in ms (default: 30000). Reserved for future use. */
  defaultTimeoutMs?: number;
}

export interface CosmosQueryParameter {
  /** Parameter name including the leading '@' (e.g. '@rid'). */
  name: string;
  value: unknown;
}

export interface CosmosQueryOptions {
  /**
   * Partition-key value. When provided, the query is partition-scoped and
   * Cosmos charges proportional RU. When omitted, cross-partition is enabled —
   * findEntities always supplies a partition key (repositoryId).
   */
  partitionKey?: string;
  /** Request query metrics in the response (`x-ms-documentdb-query-metrics`). */
  populateMetrics?: boolean;
  /** Continuation token from a previous page, if any. */
  continuationToken?: string | null;
}

export interface CosmosQueryResult<T> {
  documents: T[];
  /** Request charge in RU, from `x-ms-request-charge`. */
  requestCharge: number;
  /** Query metrics from `x-ms-documentdb-query-metrics` (only present when populateMetrics is true). */
  queryMetrics: string | null;
  /** Continuation token for the next page, or null if exhausted. */
  continuationToken: string | null;
}

export interface CosmosContainerProperties {
  id: string;
  partitionKey: { paths: string[]; kind: string };
  indexingPolicy: {
    indexingMode: string;
    automatic: boolean;
    includedPaths: Array<{ path: string }>;
    excludedPaths: Array<{ path: string }>;
  };
}

/** Internal — narrow alias for the fetch function so tests can inject a stub. */
type FetchLike = typeof fetch;

/**
 * Cosmos NoSQL (Document) endpoint client. Issues parameterised SQL queries
 * and reads container metadata. RU is accumulated into the active usageScope.
 */
export class CosmosDocumentClient {
  private readonly config: Required<Pick<CosmosDocumentClientConfig, 'maxRetries' | 'defaultTimeoutMs'>> & CosmosDocumentClientConfig;
  private readonly fetchImpl: FetchLike;

  /**
   * `fetchImpl` is for tests only — production code should pass nothing and
   * inherit `globalThis.fetch`. Keeping it on the constructor (rather than
   * stubbing globals) means each test instance is hermetic.
   */
  constructor(config: CosmosDocumentClientConfig, fetchImpl?: FetchLike) {
    this.config = {
      ...config,
      maxRetries: config.maxRetries ?? 3,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30000,
    };
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /**
   * Execute a parameterised Cosmos SQL query against the container's `docs`
   * resource. Retries on 429/503 with the response's `x-ms-retry-after-ms`
   * when present, otherwise exponential backoff. RU is accumulated into the
   * active {@link usageScope}.
   */
  public async query<T = unknown>(
    sql: string,
    parameters: CosmosQueryParameter[],
    options: CosmosQueryOptions,
  ): Promise<CosmosQueryResult<T>> {
    const resourceLink = `dbs/${this.config.database}/colls/${this.config.container}`;
    const url = `${this.restBase()}/${resourceLink}/docs`;

    // For self-signed certs (emulator), disable TLS verification process-wide.
    // Caller opted in via rejectUnauthorized: false. Same pattern as cosmosRestPut.
    if (!this.config.rejectUnauthorized) {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    }

    const body = JSON.stringify({ query: sql, parameters });

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const date = new Date().toUTCString();
      const token = cosmosAuthToken('post', 'docs', resourceLink, date, this.config.key);
      const headers: Record<string, string> = {
        'Authorization': token,
        'x-ms-version': '2018-12-31',
        'x-ms-date': date,
        'Content-Type': 'application/query+json',
        'x-ms-documentdb-isquery': 'true',
      };
      if (options.partitionKey != null) {
        headers['x-ms-documentdb-partitionkey'] = JSON.stringify([options.partitionKey]);
      } else {
        headers['x-ms-documentdb-query-enablecrosspartition'] = 'true';
      }
      if (options.populateMetrics) {
        headers['x-ms-documentdb-populatequerymetrics'] = 'true';
      }
      if (options.continuationToken) {
        headers['x-ms-continuation'] = options.continuationToken;
      }

      const response = await this.fetchImpl(url, { method: 'POST', headers, body });

      if (response.status === 429 || response.status === 503) {
        if (attempt < this.config.maxRetries) {
          const waitMs = parseRetryAfterMs(response, attempt);
          const acc = usageScope.getStore();
          if (acc) acc.retries++;
          await sleep(waitMs);
          continue;
        }
        const text = await response.text();
        throw new Error(`CosmosDB Document query ${response.status}: ${text}`);
      }

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`CosmosDB Document query ${response.status}: ${text}`);
      }

      const json = (await response.json()) as { Documents?: unknown[]; _count?: number };
      const requestCharge = Number(response.headers.get('x-ms-request-charge') ?? '0') || 0;
      const queryMetrics = response.headers.get('x-ms-documentdb-query-metrics');
      const continuationToken = response.headers.get('x-ms-continuation');

      const acc = usageScope.getStore();
      if (acc) {
        acc.calls++;
        acc.ru += requestCharge;
      }

      return {
        documents: (json.Documents ?? []) as T[],
        requestCharge,
        queryMetrics,
        continuationToken,
      };
    }
    // Unreachable — the loop either returns or throws on the final attempt.
    throw new Error('CosmosDocumentClient.query: retry loop exhausted without resolution');
  }

  /**
   * Read container metadata (id, partition key, indexing policy). Used by
   * `ensureSchema()` to warn when externally-provisioned containers have
   * excluded paths the findEntities SQL needs.
   */
  public async getContainerProperties(): Promise<CosmosContainerProperties> {
    const resourceLink = `dbs/${this.config.database}/colls/${this.config.container}`;
    const url = `${this.restBase()}/${resourceLink}`;

    if (!this.config.rejectUnauthorized) {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    }

    const date = new Date().toUTCString();
    const token = cosmosAuthToken('get', 'colls', resourceLink, date, this.config.key);

    const response = await this.fetchImpl(url, {
      method: 'GET',
      headers: {
        'Authorization': token,
        'x-ms-version': '2018-12-31',
        'x-ms-date': date,
      },
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`CosmosDB Document getContainerProperties ${response.status}: ${text}`);
    }

    return (await response.json()) as CosmosContainerProperties;
  }

  private restBase(): string {
    return this.config.restEndpoint.replace(/\/+$/, '');
  }
}

function parseRetryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get('x-ms-retry-after-ms');
  if (header) {
    const n = Number(header);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return Math.min(500 * Math.pow(2, attempt), 10000);
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
