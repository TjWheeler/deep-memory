// Per-operation RU/call/retry accumulator, shared by every Cosmos endpoint.
//
// Extracted from CosmosDbConnection.ts so both the Gremlin client and the
// CosmosDocumentClient (added for the Cosmos SQL findEntities path) write
// usage into the same AsyncLocalStorage scope. That way a single public
// method on the provider — which may touch both endpoints in one call — still
// emits a single per-operation usage record with the combined totals.

import { AsyncLocalStorage } from 'node:async_hooks';

/** Per-operation RU accumulator kept in async-local storage. */
export interface UsageAccumulator {
  /** Total request charge (RU) across all submits in the current operation. */
  ru: number;
  /** Number of underlying client calls (gremlin submit() or document query()). */
  calls: number;
  /** Number of transient-retry waits observed. */
  retries: number;
}

/**
 * Module-level AsyncLocalStorage so any client call executed inside a
 * `usageScope.run(...)` block contributes its RU/retry counts to the active
 * accumulator. Providers wrap each public method in a scope and read the
 * aggregated result when the method returns.
 */
export const usageScope = new AsyncLocalStorage<UsageAccumulator>();
