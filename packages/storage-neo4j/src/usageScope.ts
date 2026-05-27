// Per-operation usage scope — the bridge between the chokepoint
// (`Neo4jConnection`, which observes each round-trip's `ResultSummary`) and
// the Proxy on `Neo4jStorageProvider` (which emits one `OperationUsage`
// record per public method call).
//
// Threaded through async boundaries via `AsyncLocalStorage` so individual
// `Neo4jConnection` methods do not need to thread a scope argument through
// their public signature. The trade-off: scopes only carry across awaits
// within the same async context, which is exactly how every CRUD method here
// is structured.

import { AsyncLocalStorage } from 'node:async_hooks';
import { bigintToSafeNumber } from './mapping.js';

/**
 * Mutable bag accumulated as round-trips complete inside a single tracked
 * operation. The provider Proxy creates one of these, runs the method inside
 * `runInUsageScope`, then reads the bag to emit the sink record.
 */
export interface UsageScope {
  /** Number of round-trips inside the operation. */
  calls: number;
  /** Sum of records returned across every round-trip. */
  recordCount: number;
  /**
   * Sum of `summary.resultConsumedAfter` in milliseconds — the primary cost
   * signal exposed as `OperationUsage.value` with `unit: 'server_ms'`.
   */
  serverMs: number;
  /**
   * Sum of `summary.resultAvailableAfter` in milliseconds. Surfaced under
   * `details` for operators who want to see how soon the first row arrived
   * vs the full stream.
   */
  availableAfterMs: number;
  /**
   * Aggregated `QueryStatistics` counters across every round-trip. Keys are
   * the canonical names emitted by the driver: `nodesCreated`,
   * `nodesDeleted`, `relationshipsCreated`, `relationshipsDeleted`,
   * `propertiesSet`, `labelsAdded`, `labelsRemoved`, `indexesAdded`,
   * `indexesRemoved`, `constraintsAdded`, `constraintsRemoved`.
   *
   * Probe P1 confirmed counters arrive as plain `number` under `useBigInt`,
   * so straight addition is safe.
   */
  counters: Record<string, number>;
}

const COUNTER_KEYS = [
  'nodesCreated',
  'nodesDeleted',
  'relationshipsCreated',
  'relationshipsDeleted',
  'propertiesSet',
  'labelsAdded',
  'labelsRemoved',
  'indexesAdded',
  'indexesRemoved',
  'constraintsAdded',
  'constraintsRemoved',
] as const;

const store = new AsyncLocalStorage<UsageScope>();

/** Create a fresh scope with zeroed accumulators. */
export function createUsageScope(): UsageScope {
  return {
    calls: 0,
    recordCount: 0,
    serverMs: 0,
    availableAfterMs: 0,
    counters: {},
  };
}

/**
 * Run `fn` with `scope` as the active usage scope. Round-trips executed via
 * `Neo4jConnection` while `fn` runs will write into the scope; reads via
 * `getCurrentUsageScope` outside the function return `undefined`.
 *
 * Mirrors `AsyncLocalStorage.run` directly — exposed as a thin wrapper so
 * callers don't need to import `node:async_hooks`.
 */
export function runInUsageScope<T>(scope: UsageScope, fn: () => T): T {
  return store.run(scope, fn);
}

/**
 * Look up the active scope, or `undefined` if none is set. The Connection
 * uses this to no-op when the caller did not arrange a scope (e.g. lifecycle
 * methods like `verifyConnectivity`).
 */
export function getCurrentUsageScope(): UsageScope | undefined {
  return store.getStore();
}

/**
 * Minimal shape this module needs from the driver's `ResultSummary` /
 * `QueryStatistics`. The two integer fields are widened to `unknown` because
 * the driver's static signature is `ResultSummary<Integer>` where `Integer`
 * is the legacy class; at runtime with `useBigInt: true` they are `BigInt`s.
 * `bigintToSafeNumber` performs the narrowing.
 *
 * Kept local so this file does not import `neo4j-driver` directly, preserving
 * the chokepoint enforcement (D3b layer 2).
 */
export interface RoundTripSummary {
  resultAvailableAfter?: unknown;
  resultConsumedAfter?: unknown;
  counters?: {
    updates(): Record<string, number>;
  };
}

/**
 * Add one round-trip's worth of cost to the active scope. Called by
 * `Neo4jConnection` after every successful query. Silently no-ops when no
 * scope is active.
 *
 * `recordCount` is the size of the returned record array — passed in
 * separately because `summary` does not carry it directly.
 */
export function recordRoundTrip(summary: RoundTripSummary, recordCount: number): void {
  const scope = store.getStore();
  if (scope === undefined) return;
  scope.calls += 1;
  scope.recordCount += recordCount;
  if (summary.resultConsumedAfter !== undefined) {
    scope.serverMs += bigintToSafeNumber(summary.resultConsumedAfter);
  }
  if (summary.resultAvailableAfter !== undefined) {
    scope.availableAfterMs += bigintToSafeNumber(summary.resultAvailableAfter);
  }
  const stats = summary.counters !== undefined ? summary.counters.updates() : undefined;
  if (stats !== undefined) {
    for (const key of COUNTER_KEYS) {
      const value = stats[key];
      if (typeof value === 'number' && value !== 0) {
        scope.counters[key] = (scope.counters[key] ?? 0) + value;
      }
    }
  }
}

/**
 * Build the `details` payload for an `OperationUsage` record from a scope.
 *
 * Always emits `calls`, `recordCount`, `availableAfterMs`. Counter fields are
 * included only when they accumulated non-zero values — keeps the record
 * compact for the read-heavy paths.
 */
export function buildUsageDetails(scope: UsageScope): Record<string, number> {
  const details: Record<string, number> = {
    calls: scope.calls,
    recordCount: scope.recordCount,
    availableAfterMs: scope.availableAfterMs,
  };
  for (const [key, value] of Object.entries(scope.counters)) {
    if (value !== 0) details[key] = value;
  }
  return details;
}
