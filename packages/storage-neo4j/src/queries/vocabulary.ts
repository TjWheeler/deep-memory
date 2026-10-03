// Vocabulary Cypher queries.
//
// Storage shape:
//   - A single `(:_Vocabulary {repositoryId})` node per repository holds the
//     JSON-stringified vocabulary blob in `vocabulary` and a copy of the blob's
//     version string in `version`. The node is created together with the
//     `_Repository` node by `createRepository`; nothing in this module creates
//     it.
//   - `version` lives outside the JSON so the database can compare it. Cypher
//     cannot read inside a JSON string without APOC (which the provider
//     deliberately does not depend on), so compare-and-set needs the version
//     as a native property. `saveVocabulary` writes the blob and the property
//     in the same `SET`, so the two never diverge on this code path.
//   - `saveVocabulary` is compare-and-set, and the node's write lock must be
//     taken BEFORE `version` is read. Neo4j runs at read-committed: a plain
//     `MATCH … WHERE v.version = $expected SET …` evaluates the predicate
//     without holding the lock, so concurrent writers that read the same base
//     version all pass the check, queue on the lock, and each apply their SET
//     in turn — every one reports success and only the last write survives.
//     Setting and removing a dummy property (`SET v._lock = true REMOVE
//     v._lock`) acquires the exclusive lock first; the version read that
//     follows in the same statement then sees the latest committed value, so
//     only one writer can match a given base version. The same lock-first
//     form guards the backfill's write.
//   - Change-log entries live as `(:_VocabularyChangeLog {repositoryId, ...})`
//     nodes. This module only reads them back, ordered by `proposedAt DESC`
//     to match the `VocabularyChangeRecord` audit semantic.

import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { PaginationOptions, PaginatedResult } from '@utaba/deep-memory/types';
import {
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { settledValue } from '../errors.js';
import { bigintToSafeNumber, changeRecordFromRecord } from '../mapping.js';

/** Page size for the backfill's keyset scan over `_Vocabulary` nodes. */
const BACKFILL_PAGE_SIZE = 500;

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
 * Decode the stored JSON blob. A missing, empty, or unparseable blob — or one
 * that parses to something other than a JSON object (`null`, an array, a
 * scalar) — decodes to the empty vocabulary. The backfill uses the same
 * decoder, so the `version` property it writes is exactly the version
 * `getVocabulary` reports — which is the `expectedVersion` the next
 * compare-and-set will carry.
 */
function parseStoredVocabulary(raw: unknown): MemoryVocabulary {
  if (typeof raw !== 'string' || raw === '') return emptyVocabulary();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyVocabulary();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return emptyVocabulary();
  }
  return parsed as MemoryVocabulary;
}

/**
 * Vocabulary read, together with whether the repository marker exists. The
 * marker lookup is a seek of its unique constraint index; `_Vocabulary` has
 * no index on `repositoryId`, so the vocabulary lookup is a label scan over
 * the vocabulary nodes (one per repository). Both matches are optional, so
 * the statement always returns one row. The marker decides existence, not
 * the vocabulary node: a delete removes the marker first and the vocabulary
 * last, so a vocabulary node without a marker belongs to a deleted
 * repository.
 */
export const VOCABULARY_READ_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
OPTIONAL MATCH (v:_Vocabulary {repositoryId: $rid})
RETURN repo IS NOT NULL AS repositoryExists, v.vocabulary AS json`;

/**
 * Read the vocabulary for a repository. Throws `RepositoryNotFoundError` when
 * the repository marker is absent, so a deleted repository is never mistaken
 * for one that has no types yet. A repository whose vocabulary node is
 * missing reads as the empty vocabulary (`createRepository` always seeds the
 * node, so this only covers data written outside this provider).
 *
 * Only the JSON `vocabulary` property is projected — the per-node `repositoryId`
 * and label are not needed by callers.
 */
export async function getVocabulary(
  conn: Neo4jConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  const result = await conn.executeQuery(VOCABULARY_READ_QUERY, {}, { repositoryId, routing: 'READ' });
  const record = result.records[0];
  if (record === undefined) throw new ProviderError('Neo4j vocabulary read returned no row.');
  if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  return parseStoredVocabulary(record.get('json'));
}

/**
 * Compare-and-set write of the vocabulary. The success path is one round-trip:
 * one statement takes the node's write lock, then compares the version, then
 * writes — the lock comes first so no concurrent writer can commit between
 * the comparison and the write (see the module header).
 *
 * Zero nodes written means either the vocabulary node is gone (the repository
 * was deleted, or never existed) or its version is stale. Only on that path
 * does a follow-up read (version property and blob together) decide which
 * typed error to throw:
 *
 *   - no node → `RepositoryNotFoundError`
 *   - node holding exactly the version and blob this call wrote → success.
 *     The driver transparently retries a write whose commit acknowledgement
 *     was lost; the retry finds our own committed write, which must not be
 *     reported as a conflict.
 *   - `version` property missing, or different from the blob's own version →
 *     `ProviderError`. The node was written by an earlier provider release
 *     (which updated only the blob) and `ensureSchema` has not repaired it.
 *     A version conflict would be misleading: callers read the version from
 *     the blob, so no re-read can ever produce a matching `expectedVersion`.
 *     The remedy is in the message itself because tool surfaces may drop
 *     the suggestion.
 *   - otherwise → `VocabularyVersionConflictError` carrying the stored version
 *
 * Never creates the node — `createRepository` seeds it, which is also what
 * stops a deleted repository's vocabulary from being recreated by a late
 * writer.
 *
 * Cache invalidation is the caller's responsibility (the provider's
 * `saveVocabulary` wrapper handles it so cache hits stay coherent with writes).
 */
export async function saveVocabulary(
  conn: Neo4jConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
  expectedVersion: string,
): Promise<void> {
  const json = JSON.stringify(vocabulary);
  const write = await conn.executeQuery(
    `MATCH (v:_Vocabulary {repositoryId: $rid})
     SET v._lock = true
     REMOVE v._lock
     WITH v, v.version = $expectedVersion AS ok
     FOREACH (_ IN CASE WHEN ok THEN [1] ELSE [] END |
       SET v.vocabulary = $json, v.version = $newVersion
     )
     RETURN sum(CASE WHEN ok THEN 1 ELSE 0 END) AS written`,
    {
      expectedVersion,
      json,
      newVersion: vocabulary.version,
    },
    { repositoryId },
  );
  // `sum()` over integers is a Cypher INTEGER — a BigInt under `useBigInt: true`.
  const written = bigintToSafeNumber(write.records[0]?.get('written') ?? 0);
  if (written > 0) return;

  const current = await conn.executeQuery(
    'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN v.version AS version, v.vocabulary AS json',
    {},
    { repositoryId, routing: 'READ' },
  );
  const record = current.records[0];
  if (record === undefined) {
    throw new RepositoryNotFoundError(repositoryId);
  }
  const actualVersion: unknown = record.get('version');
  const storedJson: unknown = record.get('json');
  // The driver retries a write whose commit acknowledgement was lost; the
  // retry then sees our own committed write and matches nothing. The node
  // holding exactly the version and blob this call wrote means the write
  // landed, so report success rather than a conflict against ourselves.
  if (actualVersion === vocabulary.version && storedJson === json) return;
  const blobVersion = parseStoredVocabulary(storedJson).version;
  if (typeof actualVersion !== 'string' || actualVersion !== blobVersion) {
    throw new ProviderError(
      `Vocabulary for repository "${repositoryId}" has a missing or stale version property (written by an earlier provider release); run ensureSchema() to repair it, then retry`,
      'Run ensureSchema() to repair the version property on vocabularies written by an earlier provider release, then retry.',
    );
  }
  throw new VocabularyVersionConflictError(repositoryId, expectedVersion, actualVersion);
}

/**
 * Repair the `version` property on `_Vocabulary` nodes so it matches the
 * version inside the stored blob. Called from `ensureSchema`.
 *
 * Two cases need repair, both left by earlier provider releases that wrote
 * only the blob: nodes that predate the property (no `version` at all), and
 * nodes whose blob an earlier release rewrote after the property was set
 * (`version` stale). Either way compare-and-set can never match, because
 * callers take `expectedVersion` from the blob. Running different provider
 * releases against one database is unsupported; this pass is what brings a
 * database back to a consistent state once only the current release writes.
 *
 * Every node is read and compared in JS (the blob cannot be parsed in Cypher
 * without APOC); nodes already consistent are skipped, so a second pass
 * writes nothing. Nodes are read in pages keyed on `repositoryId`, so the
 * pass holds at most one page in memory however many repositories exist.
 *
 * The per-node write takes the node's write lock before comparing the blob
 * (the same lock-first form as `saveVocabulary`; see the module header) and
 * only lands while the node still holds the exact blob that was decoded, so
 * a vocabulary write racing the repair cannot be stamped with the version of
 * the blob it replaced.
 *
 * One bad node never stops the pass: a node whose blob carries no usable
 * version is left alone, and a node whose repair fails is counted and
 * reported with a warning naming only its repository id. Such nodes keep
 * failing `saveVocabulary` with the repair message until they are fixed.
 */
export async function backfillVocabularyVersions(
  conn: Neo4jConnection,
): Promise<{ repaired: number; failed: number }> {
  let repaired = 0;
  let failed = 0;
  let after = '';

  while (true) {
    // Cross-repository: a repair pass over every repository's vocabulary
    // node, run only from ensureSchema. Keyset paging on repositoryId;
    // nodes without one cannot be addressed by a scoped write and are not
    // selected.
    const page = await conn.executeSystemQuery(
      `MATCH (v:_Vocabulary)
       WHERE v.repositoryId > $after
       RETURN v.repositoryId AS rid, v.version AS version, v.vocabulary AS json
       ORDER BY v.repositoryId
       LIMIT $pageSize`,
      // BigInt so LIMIT sees a Cypher INTEGER, not FLOAT.
      { after, pageSize: BigInt(BACKFILL_PAGE_SIZE) },
      { crossRepository: true, routing: 'READ' },
    );

    for (const record of page.records) {
      const rid: unknown = record.get('rid');
      if (typeof rid !== 'string' || rid === '') continue;
      after = rid;
      try {
        if (await repairVocabularyVersion(conn, rid, record.get('version'), record.get('json'))) {
          repaired += 1;
        }
      } catch (err) {
        failed += 1;
        const reason = err instanceof Error ? err.name : typeof err;
        console.warn('[neo4j] vocabulary version repair failed', { repositoryId: rid, reason });
      }
    }

    if (page.records.length < BACKFILL_PAGE_SIZE) break;
  }

  return { repaired, failed };
}

/**
 * Repair one node's `version` property. Returns `true` when a write landed.
 * Skips nodes already consistent with their blob, and nodes whose blob has
 * no non-empty string version (there is nothing correct to write).
 */
async function repairVocabularyVersion(
  conn: Neo4jConnection,
  repositoryId: string,
  storedVersion: unknown,
  raw: unknown,
): Promise<boolean> {
  const version: unknown = parseStoredVocabulary(raw).version;
  if (typeof version !== 'string' || version === '') return false;
  if (storedVersion === version) return false;

  // `coalesce` so a node with no blob at all still matches (null never
  // equals anything in Cypher); it decodes to the empty vocabulary.
  const json = typeof raw === 'string' ? raw : '';
  const result = await conn.executeQuery(
    `MATCH (v:_Vocabulary {repositoryId: $rid})
     SET v._lock = true
     REMOVE v._lock
     WITH v, coalesce(v.vocabulary, '') = $json AS unchanged
     FOREACH (_ IN CASE WHEN unchanged THEN [1] ELSE [] END |
       SET v.version = $version
     )
     RETURN sum(CASE WHEN unchanged THEN 1 ELSE 0 END) AS repaired`,
    { json, version },
    { repositoryId },
  );
  return bigintToSafeNumber(result.records[0]?.get('repaired') ?? 0) > 0;
}

/**
 * Change-log count, together with whether the repository marker exists. The
 * marker is a seek of its unique constraint index; the count runs only when
 * it exists and aggregates, so the statement always returns one row.
 * `_VocabularyChangeLog` has no index on `repositoryId`, so the count is a
 * label scan over the change-log nodes.
 */
export const VOCABULARY_CHANGE_LOG_COUNT_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
CALL (repo) {
  MATCH (e:_VocabularyChangeLog {repositoryId: $rid})
  WHERE repo IS NOT NULL
  RETURN count(e) AS total
}
RETURN repo IS NOT NULL AS repositoryExists, total`;

/**
 * Page the vocabulary change-log for a repository, newest first. Throws
 * `RepositoryNotFoundError` when the repository marker is absent; the marker
 * rides on the count statement (`VOCABULARY_CHANGE_LOG_COUNT_QUERY`), which
 * always runs and always returns one row.
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
 * driver, `BigInt` round-trips as `INTEGER` — the same binding `listRepositories`
 * uses.
 */
export async function getVocabularyChangeLog(
  conn: Neo4jConnection,
  repositoryId: string,
  options?: PaginationOptions,
): Promise<PaginatedResult<VocabularyChangeRecord>> {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;

  const [dataSettled, countSettled] = await Promise.allSettled([
    conn.executeQuery(
      `MATCH (e:_VocabularyChangeLog {repositoryId: $rid})
       RETURN e
       ORDER BY e.proposedAt DESC
       SKIP $offset LIMIT $limit`,
      { offset: BigInt(offset), limit: BigInt(limit) },
      { repositoryId, routing: 'READ' },
    ),
    conn.executeQuery(VOCABULARY_CHANGE_LOG_COUNT_QUERY, {}, { repositoryId, routing: 'READ' }),
  ]);

  // The count carries the marker check, so a missing repository is reported
  // ahead of a failed page.
  const context = { repositoryId, operation: 'getVocabularyChangeLog' };
  const countRecord = settledValue(countSettled, context).records[0];
  if (countRecord === undefined) throw new ProviderError('Neo4j vocabulary change-log count returned no row.');
  if (countRecord.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  const items = settledValue(dataSettled, context).records.map((record) => changeRecordFromRecord(record, 'e'));
  const total = bigintToSafeNumber(countRecord.get('total') ?? 0);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    limit,
    offset,
  };
}
