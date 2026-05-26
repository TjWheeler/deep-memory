// CosmosDbConnection — Gremlin client wrapper for CosmosDB
//
// Handles WebSocket connection, CosmosDB authentication, TLS for emulator,
// and retry logic for transient errors (429 throttling, 503 unavailable).

// @ts-expect-error — gremlin has no type declarations
import gremlin from 'gremlin';
import { usageScope } from './usage.js';

export interface CosmosDbConnectionConfig {
  /** Gremlin WebSocket endpoint (e.g. wss://localhost:8901/) */
  endpoint: string;
  /** CosmosDB primary key */
  key: string;
  /** Database name */
  database: string;
  /** Container (graph) name */
  container: string;
  /** Max retries for transient errors (default: 3) */
  maxRetries?: number;
  /** Default query timeout in ms (default: 30000) */
  defaultTimeoutMs?: number;
  /** Whether to reject unauthorized TLS certs — set false for emulator (default: true) */
  rejectUnauthorized?: boolean;
}

export interface GremlinResult {
  /** Raw result items */
  items: unknown[];
  /** CosmosDB request charge (RU) from response headers */
  requestCharge?: number;
}

/**
 * Manages a Gremlin WebSocket connection to CosmosDB.
 * Provides `submit()` for parameterized Gremlin queries with retry on transient errors.
 */
export class CosmosDbConnection {
  private client: gremlin.driver.Client | null = null;
  private readonly config: Required<Pick<CosmosDbConnectionConfig, 'maxRetries' | 'defaultTimeoutMs' | 'rejectUnauthorized'>> & CosmosDbConnectionConfig;

  constructor(config: CosmosDbConnectionConfig) {
    this.config = {
      ...config,
      maxRetries: config.maxRetries ?? 3,
      defaultTimeoutMs: config.defaultTimeoutMs ?? 30000,
      rejectUnauthorized: config.rejectUnauthorized ?? true,
    };
  }

  /** Open the WebSocket connection to CosmosDB Gremlin endpoint. */
  async connect(): Promise<void> {
    if (this.client) return;

    const authenticator = new gremlin.driver.auth.PlainTextSaslAuthenticator(
      `/dbs/${this.config.database}/colls/${this.config.container}`,
      this.config.key,
    );

    this.client = new gremlin.driver.Client(this.config.endpoint, {
      authenticator,
      traversalsource: 'g',
      rejectUnauthorized: this.config.rejectUnauthorized,
      mimeType: 'application/vnd.gremlin-v2.0+json',
    });

    await this.client.open();
  }

  /** Close the WebSocket connection. */
  async close(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  /**
   * Submit a parameterized Gremlin query with retry on transient errors.
   * All user values should be passed as bindings (never interpolated into the query string).
   */
  async submit(query: string, bindings?: Record<string, unknown>): Promise<GremlinResult> {
    if (!this.client) {
      throw new Error('CosmosDbConnection: not connected. Call connect() first.');
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        const resultSet = await this.client.submit(query, bindings);
        const items = resultSet.toArray();
        const requestCharge = extractRequestCharge(resultSet);
        const acc = usageScope.getStore();
        if (acc) {
          acc.calls++;
          if (typeof requestCharge === 'number') acc.ru += requestCharge;
        }
        return { items, requestCharge };
      } catch (err: unknown) {
        lastError = err;
        if (isTransientError(err) && attempt < this.config.maxRetries) {
          const retryAfterMs = getRetryAfterMs(err, attempt);
          const acc = usageScope.getStore();
          if (acc) acc.retries++;
          await sleep(retryAfterMs);
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }

  /** Get the underlying Gremlin client (for advanced usage). */
  getClient(): gremlin.driver.Client {
    if (!this.client) {
      throw new Error('CosmosDbConnection: not connected. Call connect() first.');
    }
    return this.client;
  }
}

/** Check if an error is a transient CosmosDB error (429 or 503). */
function isTransientError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message;
    // CosmosDB returns status codes in error messages
    if (msg.includes('429') || msg.includes('RequestRateTooLarge')) return true;
    if (msg.includes('503') || msg.includes('ServiceUnavailable')) return true;
  }
  // Check statusCode property if present
  const statusCode = (err as Record<string, unknown>)?.['statusCode'];
  if (statusCode === 429 || statusCode === 503) return true;
  return false;
}

/** Extract retry-after from error or use exponential backoff. */
function getRetryAfterMs(err: unknown, attempt: number): number {
  // CosmosDB may include x-ms-retry-after-ms in error attributes
  const retryAfter = (err as Record<string, unknown>)?.['retryAfterMs'];
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return retryAfter;
  }
  // Exponential backoff: 500ms, 1s, 2s, 4s, ...
  return Math.min(500 * Math.pow(2, attempt), 10000);
}

/**
 * Extract request charge (RU) from a ResultSet's attributes.
 *
 * CosmosDB Gremlin exposes two related attributes on the response message:
 *   - `x-ms-request-charge`        — RU for this specific response message
 *   - `x-ms-total-request-charge`  — cumulative RU across the entire query
 *
 * For single-message responses (single-vertex reads, count(), small projections)
 * the two are equal. For streamed multi-message responses (traversals, path
 * queries, large result sets), the gremlin-javascript driver surfaces only
 * the FINAL message's attributes — and the final message's
 * `x-ms-request-charge` is typically 0 (its own delta) while
 * `x-ms-total-request-charge` carries the real cumulative charge.
 *
 * Therefore: always prefer the total. Falling back to the per-message value
 * with `??` (the previous behaviour) silently zeroed out every traversal
 * because 0 is not nullish.
 *
 * Verified against the Cosmos emulator with rate limiting enabled
 * (`local-tests/ru-raw-probe.mjs` 2026-05-25): a depth-2 path traversal
 * returns `{ x-ms-request-charge: 0, x-ms-total-request-charge: 29.72 }`.
 */
function extractRequestCharge(resultSet: gremlin.driver.ResultSet): number | undefined {
  const attrs = resultSet.attributes as Record<string, unknown> | undefined;
  if (!attrs) return undefined;
  const total = attrs['x-ms-total-request-charge'];
  if (typeof total === 'number') return total;
  const single = attrs['x-ms-request-charge'];
  if (typeof single === 'number') return single;
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
