// Shared submit for create statements.

import type { DeepMemoryError } from '@utaba/deep-memory';
import { cosmosStatusCode, type CosmosDbConnection, type GremlinResult } from '../CosmosDbConnection.js';

/** Cosmos status for a write whose document id already exists in the partition. */
const CONFLICT_STATUS = 409;

/**
 * Submit a create statement, turning a 409 into the caller's duplicate
 * error with the driver error as `cause`.
 *
 * Cosmos enforces one document per id per partition itself. A create's own
 * existence check runs in the same request but is not transactional, so a
 * create racing another with the same id can pass the check and still be
 * refused by the store with a 409 — which is the same outcome the check
 * reports, and is mapped to the same typed error.
 */
export async function submitCreate(
  conn: CosmosDbConnection,
  query: string,
  bindings: Record<string, unknown>,
  duplicate: (cause: unknown) => DeepMemoryError,
): Promise<GremlinResult> {
  try {
    return await conn.submit(query, bindings);
  } catch (err: unknown) {
    if (cosmosStatusCode(err) === CONFLICT_STATUS) throw duplicate(err);
    throw err;
  }
}
