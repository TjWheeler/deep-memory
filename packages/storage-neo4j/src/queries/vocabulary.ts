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
//   - Change-log entries live as `(:_VocabularyChangeLog {repositoryId,
//     changeId, ...})` nodes, unique on `(repositoryId, changeId)`
//     (`dm_vocabulary_change_unique`). `saveVocabulary` writes one in the same
//     statement as the vocabulary it describes, and only when that write
//     lands. Reads come back ordered by `proposedAt DESC` to match the
//     `VocabularyChangeRecord` audit semantic, with `changeId DESC` breaking
//     ties so records proposed in the same millisecond page in a stable
//     order. Every change-log statement
//     reaches the nodes through the constraint's index: equality on
//     `repositoryId` plus `changeId IS NOT NULL` lets the planner seek it,
//     where `repositoryId` alone has no index to use and scans every
//     repository's change log.
//   - Every vocabulary statement reaches the `_Vocabulary` node through the
//     `dm_vocabulary_repository` index on `repositoryId`, so a read or write
//     costs the same however many repositories the store holds.

import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { PaginationOptions, PaginatedResult } from '@utaba/deep-memory/types';
import {
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { isDeletedEntityFailure, mapDriverError, settledValue } from '../errors.js';
import { bigintToSafeNumber, changeRecordFromRecord, changeRecordToProperties } from '../mapping.js';
import { LOCK_REPOSITORY_MARKER } from './repositoryLock.js';

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
 * marker lookup is a seek of its unique constraint index and the vocabulary
 * lookup a seek of `dm_vocabulary_repository`. Both matches are optional, so
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
 * and label are not needed by callers. A driver failure is raised as a typed
 * error.
 */
export async function getVocabulary(
  conn: Neo4jConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  let result: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
  try {
    result = await conn.executeQuery(VOCABULARY_READ_QUERY, {}, { repositoryId, routing: 'READ' });
  } catch (err) {
    mapDriverError(err, { repositoryId, operation: 'getVocabulary' });
  }
  const record = result.records[0];
  if (record === undefined) throw new ProviderError('Neo4j vocabulary read returned no row.');
  if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  return parseStoredVocabulary(record.get('json'));
}

/**
 * The compare-and-set write, with the change record that describes it.
 *
 * The statement write-locks the repository marker first and goes on only
 * while it still exists (`LOCK_REPOSITORY_MARKER`). `deleteRepository`
 * deletes the marker before it drains the change log, so a save holding the
 * lock commits its record before the drain starts and the drain removes it,
 * while a save that waited on the delete finds the marker gone and writes
 * nothing. A save that only read the marker could commit its record after
 * the drain had passed, and the record would then turn up in the change log
 * of a repository later created under the same id.
 *
 * It then takes the vocabulary node's write lock before reading `version`
 * (see the module header). When the version matches, the vocabulary and, if
 * `$change` is not null, its change record are written together; when it
 * does not, neither is. The record is a `MERGE` on `(repositoryId,
 * changeId)` rather than a `CREATE`: a re-run of a committed write that still
 * matches (a save that keeps the version unchanged) finds the record it
 * already wrote instead of adding a second one. `written` is 1 when the
 * write landed and 0 otherwise — including when the marker is missing,
 * because the aggregate returns its row even when the matches return none.
 */
export const VOCABULARY_SAVE_QUERY = `${LOCK_REPOSITORY_MARKER}
MATCH (v:_Vocabulary {repositoryId: $rid})
SET v._lock = true
REMOVE v._lock
WITH v, v.version = $expectedVersion AS ok
FOREACH (_ IN CASE WHEN ok THEN [1] ELSE [] END |
  SET v.vocabulary = $json, v.version = $newVersion
)
FOREACH (_ IN CASE WHEN ok AND $change IS NOT NULL THEN [1] ELSE [] END |
  MERGE (c:_VocabularyChangeLog {repositoryId: $rid, changeId: $change.changeId})
  SET c += $change
)
RETURN sum(CASE WHEN ok THEN 1 ELSE 0 END) AS written`;

/**
 * Why a compare-and-set wrote nothing: whether the marker exists, and the
 * vocabulary's version property and blob. The marker is a seek of its unique
 * constraint index and the vocabulary a seek of `dm_vocabulary_repository`;
 * both matches are optional, so the statement always returns one row.
 */
export const VOCABULARY_SAVE_OUTCOME_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
OPTIONAL MATCH (v:_Vocabulary {repositoryId: $rid})
RETURN repo IS NOT NULL AS repositoryExists, v IS NOT NULL AS vocabularyExists, v.version AS version, v.vocabulary AS json`;

/**
 * Compare-and-set write of the vocabulary, and of `changeRecord` with it when
 * one is given (`VOCABULARY_SAVE_QUERY`). The success path is one round-trip:
 * one statement locks the repository marker, then takes the vocabulary
 * node's write lock, then compares the version, then writes — the locks come
 * first so no concurrent writer or repository delete can commit between the
 * comparison and the write (see the module header). The record lands only
 * when the vocabulary does, so a failed compare-and-set or a missing
 * repository leaves the change log as it was.
 *
 * Zero nodes written means the repository marker or its vocabulary node is
 * gone (the repository was deleted, or never existed) or the version is
 * stale. Only on that path does a follow-up read
 * (`VOCABULARY_SAVE_OUTCOME_QUERY`) decide which typed error to throw:
 *
 *   - no marker, or no vocabulary node → `RepositoryNotFoundError`
 *   - node holding exactly the version and blob this call wrote → success.
 *     The driver transparently retries a write whose commit acknowledgement
 *     was lost; the retry finds our own committed write, which must not be
 *     reported as a conflict. The change record committed with that write.
 *   - `version` property missing, or different from the blob's own version →
 *     `ProviderError`. The node was written by an earlier provider release
 *     (which updated only the blob) and `ensureSchema` has not repaired it.
 *     A version conflict would be misleading: callers read the version from
 *     the blob, so no re-read can ever produce a matching `expectedVersion`.
 *     The remedy is in the message itself because tool surfaces may drop
 *     the suggestion.
 *   - otherwise → `VocabularyVersionConflictError` carrying the stored version
 *
 * A write refused because a node it waited to lock was deleted meanwhile
 * (`isDeletedEntityFailure`) is a repository delete that won the race →
 * `RepositoryNotFoundError`. Any other driver failure of either statement is
 * raised as a typed error.
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
  changeRecord?: VocabularyChangeRecord,
): Promise<void> {
  const json = JSON.stringify(vocabulary);
  const context = { repositoryId, operation: 'saveVocabulary' };
  let write: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
  try {
    write = await conn.executeQuery(
      VOCABULARY_SAVE_QUERY,
      {
        expectedVersion,
        json,
        newVersion: vocabulary.version,
        change: changeRecord !== undefined ? changeRecordToProperties(changeRecord) : null,
      },
      { repositoryId },
    );
  } catch (err) {
    // The statement locks the repository marker before anything else, and
    // the vocabulary node only while the marker exists; a delete removes the
    // marker first and the vocabulary node last. So a server that refuses a
    // lock on a node deleted while the statement waited is reporting a
    // deleted repository.
    if (isDeletedEntityFailure(err)) throw new RepositoryNotFoundError(repositoryId);
    mapDriverError(err, context);
  }
  // `sum()` over integers is a Cypher INTEGER — a BigInt under `useBigInt: true`.
  const written = bigintToSafeNumber(write.records[0]?.get('written') ?? 0);
  if (written > 0) return;

  let current: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
  try {
    current = await conn.executeQuery(VOCABULARY_SAVE_OUTCOME_QUERY, {}, { repositoryId, routing: 'READ' });
  } catch (err) {
    mapDriverError(err, context);
  }
  const record = current.records[0];
  if (record === undefined) throw new ProviderError('Neo4j vocabulary save outcome read returned no row.');
  if (record.get('repositoryExists') !== true || record.get('vocabularyExists') !== true) {
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
 * it exists and aggregates, so the statement always returns one row. The
 * records are a seek of the `(repositoryId, changeId)` constraint index (see
 * the module header).
 */
export const VOCABULARY_CHANGE_LOG_COUNT_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
CALL (repo) {
  MATCH (e:_VocabularyChangeLog {repositoryId: $rid})
  WHERE repo IS NOT NULL AND e.changeId IS NOT NULL
  RETURN count(e) AS total
}
RETURN repo IS NOT NULL AS repositoryExists, total`;

/**
 * One page of the change log, newest first. The records are a seek of the
 * `(repositoryId, changeId)` constraint index; the page is sorted from the
 * repository's records only.
 */
export const VOCABULARY_CHANGE_LOG_PAGE_QUERY = `MATCH (e:_VocabularyChangeLog {repositoryId: $rid})
WHERE e.changeId IS NOT NULL
RETURN e
ORDER BY e.proposedAt DESC, e.changeId DESC
SKIP $offset LIMIT $limit`;

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
      VOCABULARY_CHANGE_LOG_PAGE_QUERY,
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
