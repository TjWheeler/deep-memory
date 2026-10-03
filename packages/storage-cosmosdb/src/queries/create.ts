// Shared submit for create statements.

import type { DeepMemoryError } from '@utaba/deep-memory';
import { cosmosStatusCode, type CosmosDbConnection, type GremlinResult } from '../CosmosDbConnection.js';

/** Cosmos status for a write whose document id already exists in the partition. */
const CONFLICT_STATUS = 409;

/**
 * Submit a create statement, turning a 409 into the caller's duplicate
 * error with the driver error as `cause`.
 *
 * Cosmos enforces one document per id per partition itself, and refuses a
 * second one with a 409. A relationship create relies on that 409 alone to
 * refuse a taken id. An entity create also checks its id in the same request,
 * but that check is not transactional, so a create racing another with the
 * same id can pass it and still be refused by the store — the same outcome
 * the check reports, mapped to the same typed error.
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
