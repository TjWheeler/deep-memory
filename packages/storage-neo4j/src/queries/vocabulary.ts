// Vocabulary Cypher queries.
//
// Storage shape (per D4 / D6 / D7):
//   - A single `(:_Vocabulary {repositoryId})` node holds the JSON-stringified
//     vocabulary blob in `vocabulary`. No uniqueness constraint exists for this
//     label — `saveVocabulary` upserts via `MERGE` keyed on `repositoryId`.
//   - Change-log entries live as `(:_VocabularyChangeLog {repositoryId, ...})`
//     nodes. Writes are append-only and land in `proposeVocabularyExtension`
//     (out of scope here); this module only reads them back, ordered by
//     `proposedAt DESC` to match the `VocabularyChangeRecord` audit semantic.

import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { PaginationOptions, PaginatedResult } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { bigintToSafeNumber, changeRecordFromRecord } from '../mapping.js';

function emptyVocabulary(): MemoryVocabulary {
  return {
    version: '0.0.0',
    lastModified: new Date().toISOString(),
    modifiedBy: 'system',
    entityTypes: [],
    relationshipTypes: [],
  };
}

/**
 * Read the vocabulary for a repository. Returns an empty vocabulary when no
 * `_Vocabulary` node exists yet — mirrors the Cosmos and SQL Server providers'
 * forgiving-read contract so callers can compose `getVocabulary` into traversal
 * compilation without pre-seeding the node.
 *
 * Only the JSON `vocabulary` property is projected — the per-node `repositoryId`
 * and label are not needed by callers.
 */
export async function getVocabulary(
  conn: Neo4jConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  const result = await conn.executeQuery(
    'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN v.vocabulary AS json',
    {},
    { repositoryId, routing: 'READ' },
  );
  const record = result.records[0];
  if (record === undefined) return emptyVocabulary();
  const raw = record.get('json');
  if (typeof raw !== 'string' || raw === '') return emptyVocabulary();
  try {
    return JSON.parse(raw) as MemoryVocabulary;
  } catch {
    return emptyVocabulary();
  }
}

/**
 * Upsert the vocabulary for a repository. One round-trip — the D7 decision to
 * skip a uniqueness constraint on `_Vocabulary` means `MERGE` keyed on
 * `(label, repositoryId)` is the entire idempotency story; no separate
 * existence check is needed.
 *
 * Cache invalidation is the caller's responsibility (the provider's
 * `saveVocabulary` wrapper handles it so cache hits stay coherent with writes).
 */
export async function saveVocabulary(
  conn: Neo4jConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
): Promise<void> {
  await conn.executeQuery(
    'MERGE (v:_Vocabulary {repositoryId: $rid}) SET v.vocabulary = $json',
    { json: JSON.stringify(vocabulary) },
    { repositoryId },
  );
}

/**
 * Page the vocabulary change-log for a repository, newest first.
 *
 * Data and count round-trips are independent — fire them in parallel. There
 * are no property filters beyond the repository scope, so the count is always
 * exact.
 *
 * `proposedAt` is the canonical "when" field on `VocabularyChangeRecord`
 * (matches the Cosmos `'order().by('proposedAt', decr)'` and SQL Server
 * `ORDER BY proposed_at DESC` precedents). `SKIP` / `LIMIT` take Cypher
 * `INTEGER`; plain JS numbers send `FLOAT` and the planner rejects them with
 * `Neo.ClientError.Statement.ArgumentError`. With `useBigInt: true` on the
 * driver, `BigInt` round-trips as `INTEGER` — same fix Phase 4 applied to
 * `listRepositories`.
 */
export async function getVocabularyChangeLog(
  conn: Neo4jConnection,
  repositoryId: string,
  options?: PaginationOptions,
): Promise<PaginatedResult<VocabularyChangeRecord>> {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;

  const [dataResult, countResult] = await Promise.all([
    conn.executeQuery(
      `MATCH (e:_VocabularyChangeLog {repositoryId: $rid})
       RETURN e
       ORDER BY e.proposedAt DESC
       SKIP $offset LIMIT $limit`,
      { offset: BigInt(offset), limit: BigInt(limit) },
      { repositoryId, routing: 'READ' },
    ),
    conn.executeQuery(
      'MATCH (e:_VocabularyChangeLog {repositoryId: $rid}) RETURN count(e) AS total',
      {},
      { repositoryId, routing: 'READ' },
    ),
  ]);

  const items = dataResult.records.map((record) => changeRecordFromRecord(record, 'e'));
  const totalRaw = countResult.records[0]?.get('total');
  const total = totalRaw === undefined ? 0 : bigintToSafeNumber(totalRaw);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    limit,
    offset,
  };
}
