// Vocabulary Gremlin queries
//
// Storage shape:
//   - One `_vocabulary` vertex per repository, id `vocab:<repositoryId>`, in
//     the repository's partition. It holds the JSON-stringified vocabulary in
//     `vocabulary` and a copy of the blob's version string in `version`. The
//     vertex is created by `createRepository`; nothing in this module creates
//     it.
//   - `version` lives outside the JSON so the database can compare it: the
//     Cosmos Gremlin subset has no in-step JSON traversal, so compare-and-set
//     needs the version as a native property. `saveVocabulary` writes the
//     blob and the property in the same traversal, so the two never diverge
//     on this code path.
//   - `saveVocabulary` is compare-and-set: the `has('version', expected)`
//     filter and the property writes are one traversal, so two writers that
//     read the same base version cannot both land — the second matches no
//     vertex and writes nothing.

import { cosmosStatusCode } from '../CosmosDbConnection.js';
import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { CosmosDocumentClient, CosmosQueryResult } from '../CosmosDocumentClient.js';
import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { PaginationOptions, PaginatedResult } from '@utaba/deep-memory/types';
import {
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import { changeRecordFromGremlin, pluckDocValue } from '../mapping.js';
import { vocabVertexId } from './ids.js';

/**
 * Whether a failed write lost a race rather than failed outright. The Cosmos
 * Gremlin engine applies a traversal's property writes as a read-modify-write
 * of the vertex document under optimistic concurrency: when another writer
 * replaces the document in between, the loser fails with 412
 * (precondition failed), and a write racing a drop of the vertex fails with
 * 404. Neither means the request was malformed — both mean "the vertex is not
 * in the state this write expected", which the callers below resolve by
 * re-reading it.
 */
function isLostWriteRace(err: unknown): boolean {
  const status = cosmosStatusCode(err);
  return status === 412 || status === 404;
}

const EMPTY_VOCABULARY = (): MemoryVocabulary => ({
  version: '0.0.0',
  lastModified: new Date().toISOString(),
  modifiedBy: 'system',
  entityTypes: [],
  relationshipTypes: [],
});

/**
 * Parse a stored JSON blob, returning `null` for anything that is not a JSON
 * object (missing, empty, unparseable, or a JSON scalar / array / `null`).
 */
function parseStoredObject(raw: unknown): MemoryVocabulary | null {
  if (typeof raw !== 'string' || raw === '') return null;
  let parsed: MemoryVocabulary | null;
  try {
    parsed = JSON.parse(raw) as MemoryVocabulary | null;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  return parsed;
}

/**
 * Decode a stored JSON blob for reading. Anything that is not a JSON object
 * decodes to the empty vocabulary — the forgiving read `getVocabulary` has
 * always offered.
 */
function parseStoredVocabulary(raw: unknown): MemoryVocabulary {
  return parseStoredObject(raw) ?? EMPTY_VOCABULARY();
}

/**
 * The version recorded inside a stored blob, or `null` when the blob is not a
 * JSON object or carries no non-empty string `version`. Used wherever the
 * native `version` property is checked against (or repaired from) the blob:
 * only a version the blob actually states is trusted.
 */
function storedBlobVersion(raw: unknown): string | null {
  const version: unknown = parseStoredObject(raw)?.version;
  return typeof version === 'string' && version !== '' ? version : null;
}

/** Read a string-valued projection field; anything else reads as empty. */
function stringField(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

export async function getVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  // We only ever read the JSON-stringified `vocabulary` property; the full
  // valueMap(true) shipped every property on the vocab vertex (label,
  // repositoryId, etc.) for no reason. `.values('vocabulary').limit(1)`
  // returns just the JSON string — smaller wire payload, single column read.
  //
  // `has('repositoryId', rid)` scopes the lookup to a single partition before
  // `hasId(vid)`; `hasId` is post-routing in Cosmos Gremlin and fans out
  // across all partitions without the partition predicate.
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').values('vocabulary').limit(1)",
    { vid: vocabVertexId(repositoryId), rid: repositoryId },
  );
  if (result.items.length === 0) return EMPTY_VOCABULARY();
  return parseStoredVocabulary(result.items[0]);
}

// Compare-and-set write. Partition predicate first (hasId alone fans out
// across partitions); the version filter sits before the property writes so
// a stale `expectedVersion` matches nothing and writes nothing. `count()`
// reports how many vertices were written: 1 on success, 0 otherwise.
export const VOCABULARY_SAVE_QUERY =
  "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').has('version', expectedVersion)" +
  ".property('version', newVersion).property('vocabulary', vocabJson).count()";

// Follow-up read on a compare-and-set miss. It reads the `version` property
// and the blob together: a vertex written by an earlier provider release has
// no `version` property, and `values('version')` alone would return nothing
// for it — indistinguishable from a missing vertex.
export const VOCABULARY_STATE_QUERY =
  "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary')" +
  ".project('version', 'json')" +
  ".by(coalesce(values('version'), constant('')))" +
  ".by(coalesce(values('vocabulary'), constant('')))";

/**
 * Compare-and-set write of the vocabulary. The success path is one round-trip:
 * the version filter and the property writes are a single traversal, so the
 * check cannot be separated from the write by a concurrent writer.
 *
 * Zero vertices written — or a 412 / 404 from a write that lost a race (see
 * `isLostWriteRace`) — means either the vocabulary vertex is gone (the
 * repository was deleted, or never existed), its version is stale, or the
 * connection retried a submit whose first attempt had already committed.
 * Only on that path does a follow-up read (version property and blob
 * together) decide the outcome:
 *
 *   - no vertex → `RepositoryNotFoundError`
 *   - the vertex holds exactly the blob and version this call wrote →
 *     success. A transient-error retry re-ran the compare-and-set after the
 *     first attempt landed, so the retry saw its own write as a newer
 *     version; reporting a conflict would make the caller redo a change
 *     that is already stored.
 *   - `version` property missing, or different from the blob's own version →
 *     `ProviderError`. The vertex was written by an earlier provider release
 *     (which updated only the blob) and `ensureSchema` has not repaired it.
 *     A version conflict would be misleading: callers read the version from
 *     the blob, so no re-read can ever produce a matching `expectedVersion`.
 *     The remedy is in the message itself because tool surfaces may drop
 *     the suggestion.
 *   - otherwise → `VocabularyVersionConflictError` carrying the stored version
 *
 * Never creates the vertex — `createRepository` seeds it, which is also what
 * stops a deleted repository's vocabulary from being recreated by a late
 * writer.
 *
 * Cache invalidation is the caller's responsibility (the provider's
 * `saveVocabulary` wrapper handles it).
 */
export async function saveVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
  expectedVersion: string,
): Promise<void> {
  const vid = vocabVertexId(repositoryId);
  const vocabJson = JSON.stringify(vocabulary);

  let written = 0;
  try {
    const write = await conn.submit(VOCABULARY_SAVE_QUERY, {
      rid: repositoryId,
      vid,
      expectedVersion,
      newVersion: vocabulary.version,
      vocabJson,
    });
    written = Number(write.items[0] ?? 0);
  } catch (err: unknown) {
    // A concurrent writer replaced the vertex between this traversal's
    // version check and its write (412), or the vertex was dropped under it
    // (404). Either way nothing was written; the read below says whether the
    // outcome is a conflict or a missing repository.
    if (!isLostWriteRace(err)) throw err;
  }
  if (written > 0) return;

  const current = await conn.submit(VOCABULARY_STATE_QUERY, { rid: repositoryId, vid });
  const row = current.items[0];
  if (row == null || typeof row !== 'object') {
    throw new RepositoryNotFoundError(repositoryId);
  }
  const state = row as Record<string, unknown>;
  const actualVersion = stringField(state, 'version');
  const storedJson = stringField(state, 'json');
  if (actualVersion === vocabulary.version && storedJson === vocabJson) return;

  const blobVersion = storedBlobVersion(storedJson);
  if (actualVersion === '' || actualVersion !== blobVersion) {
    throw new ProviderError(
      `Vocabulary for repository "${repositoryId}" has a missing or stale version property (written by an earlier provider release); run ensureSchema() to repair it, then retry`,
      'Run ensureSchema() to repair the version property on vocabularies written by an earlier provider release, then retry.',
    );
  }
  throw new VocabularyVersionConflictError(repositoryId, expectedVersion, actualVersion);
}

// Every system `_vocabulary` vertex in the container, read through the
// document (SQL) endpoint. A Gremlin vertex is stored as a document whose
// `label` token and partition key (`repositoryId`) are flat fields, while
// every other property is an array of `{ _value, id }` — so `version` and
// `vocabulary` are read from `[0]._value` (see `pluckDocValue`).
// `NOT IS_DEFINED(c.entityType)` keeps out tenant entities whose entity type
// happens to be named `_vocabulary`: entity vertices always carry
// `entityType`, the system vertex never does.
//
// This is a cross-partition query; it runs only from ensureSchema, as a
// repair pass, never on a request path. It is paged with the endpoint's
// continuation tokens, which walk a cross-partition result stably without an
// ORDER BY, so the pass holds at most one page of blobs in memory.
export const VOCABULARY_BACKFILL_SCAN_SQL =
  'SELECT c.repositoryId, c.version, c.vocabulary FROM c ' +
  'WHERE c.label = @label AND NOT IS_DEFINED(c.entityType)';

// Partition-scoped repair of one vertex. Guarded on the exact blob that was
// decoded, so a vocabulary write racing the repair (which replaces the blob)
// makes the guard miss instead of stamping the new blob with the old version.
export const VOCABULARY_BACKFILL_WRITE_QUERY =
  "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').hasNot('entityType')" +
  ".has('vocabulary', vocabJson).property('version', vocabVersion).count()";

/** A string-valued document property (`[0]._value`); anything else reads as empty. */
function docString(doc: Record<string, unknown>, key: string): string {
  const value = pluckDocValue(doc, key);
  return typeof value === 'string' ? value : '';
}

/**
 * Repair the `version` property on `_vocabulary` vertices so it matches the
 * version inside the stored blob. Called from `ensureSchema`.
 *
 * Two cases need repair, both left by earlier provider releases that wrote
 * only the blob: vertices that predate the property (no `version` at all),
 * and vertices whose blob an earlier release rewrote after the property was
 * set (`version` stale). Either way compare-and-set can never match, because
 * callers take `expectedVersion` from the blob. Running different provider
 * releases against one container is unsupported; this pass is what brings a
 * container back to a consistent state once only the current release writes.
 *
 * Every vertex is read and compared in JS (the blob cannot be parsed inside a
 * Cosmos query); vertices already consistent are skipped, so a second pass
 * writes nothing. A version is only ever written when the blob states one (a
 * non-empty string inside a JSON object).
 *
 * A repair write that loses a race (412 / 404 — see `isLostWriteRace`) is
 * skipped like a blob-guard miss: another writer changed or removed the
 * vertex, and the current release writes `version` itself. One vertex that
 * cannot be repaired — no `repositoryId`, a blob with no usable version, or a
 * write that fails for another reason — is recorded in `failures` and the
 * pass moves on, so a single bad vertex never blocks the repair of the rest
 * (or `ensureSchema` itself). An unrepaired vertex stays visible: a
 * `saveVocabulary` against it fails with a `ProviderError` that names the
 * problem. Failure to read a page of the scan propagates.
 */
export async function backfillVocabularyVersions(
  conn: CosmosDbConnection,
  docClient: CosmosDocumentClient,
): Promise<VocabularyBackfillResult> {
  const result: VocabularyBackfillResult = { scanned: 0, repaired: 0, failures: [] };

  let continuationToken: string | null = null;
  do {
    const page: CosmosQueryResult<unknown> = await docClient.query<unknown>(
      VOCABULARY_BACKFILL_SCAN_SQL,
      [{ name: '@label', value: '_vocabulary' }],
      { continuationToken },
    );
    for (const item of page.documents) {
      result.scanned++;
      await repairOne(conn, item, result);
    }
    continuationToken = page.continuationToken;
  } while (continuationToken);

  return result;
}

async function repairOne(
  conn: CosmosDbConnection,
  item: unknown,
  result: VocabularyBackfillResult,
): Promise<void> {
  const doc: Record<string, unknown> =
    item != null && typeof item === 'object' ? (item as Record<string, unknown>) : {};
  const rawRid = doc['repositoryId'];
  const rid = typeof rawRid === 'string' ? rawRid : '';
  try {
    const json = docString(doc, 'vocabulary');
    const version = storedBlobVersion(json);
    if (version !== null && docString(doc, 'version') === version) return;

    if (rid === '') {
      result.failures.push({ repositoryId: '', reason: 'the vertex has no repositoryId' });
      return;
    }
    if (version === null) {
      result.failures.push({
        repositoryId: rid,
        reason: 'the stored vocabulary is not a JSON object with a non-empty string version',
      });
      return;
    }
    const write = await conn.submit(VOCABULARY_BACKFILL_WRITE_QUERY, {
      rid,
      vid: vocabVertexId(rid),
      vocabJson: json,
      vocabVersion: version,
    });
    // Zero means the blob guard missed: the vocabulary was rewritten after
    // the scan, by a writer that sets `version` itself.
    result.repaired += Number(write.items[0] ?? 0);
  } catch (err: unknown) {
    if (isLostWriteRace(err)) return;
    result.failures.push({
      repositoryId: rid,
      reason: err instanceof Error ? err.message : String(err),
    });
  }
}

/** One `_vocabulary` vertex the version backfill could not repair. */
export interface VocabularyBackfillFailure {
  /** The vertex's `repositoryId`, or `''` when it has none. */
  repositoryId: string;
  reason: string;
}

/** Outcome of {@link backfillVocabularyVersions}. */
export interface VocabularyBackfillResult {
  /** Vocabulary vertices read by the scan. */
  scanned: number;
  /** Vertices whose `version` property was written. */
  repaired: number;
  /** Vertices that needed repair but could not be repaired. */
  failures: VocabularyBackfillFailure[];
}

export async function getVocabularyChangeLog(
  conn: CosmosDbConnection,
  repositoryId: string,
  options?: PaginationOptions,
): Promise<PaginatedResult<VocabularyChangeRecord>> {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;

  // Count and data round-trips are independent — run them in parallel. No
  // property filters here, so the count is exact and `total` is always a number.
  const [countResult, dataResult] = await Promise.all([
    conn.submit(
      "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').count()",
      { rid: repositoryId },
    ),
    conn.submit(
      "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').order().by('proposedAt', decr).range(rangeStart, rangeEnd).valueMap(true)",
      { rid: repositoryId, rangeStart: offset, rangeEnd: offset + limit },
    ),
  ]);

  const total = Number(countResult.items[0] ?? 0);
  const items = (dataResult.items as Record<string, unknown>[]).map(changeRecordFromGremlin);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    limit,
    offset,
  };
}
