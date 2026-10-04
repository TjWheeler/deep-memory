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
//   - Each change record is a `_vocabularyChangeLog` vertex, id
//     `vocablog:<changeId>`, in the repository's partition. Only
//     `saveVocabulary` writes one, in the same traversal as the vocabulary
//     write it describes. `deleteRepository` drains it with the other system
//     vertices; `deleteAllContents` keeps it, with the vocabulary.

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
import {
  buildChangeRecordPropertyLadder,
  changeRecordFromGremlin,
  changeRecordToLadderBindings,
  pluckDocValue,
} from '../mapping.js';
import { changeLogVertexId, repoVertexId, vocabVertexId } from './ids.js';

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
 * Decode a stored JSON blob for reading. A blob that is not a JSON object
 * (missing, empty, unparseable, or a JSON scalar / array / `null`) decodes to
 * the empty vocabulary. This covers only the blob's decoding: a missing
 * repository is reported by `getVocabulary` before any blob is decoded.
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

// Vocabulary read together with the repository marker: one partition-scoped
// fetch of the two system vertices by their fixed ids, each projected to its
// id and the vocabulary blob (empty for the marker). Only the JSON-stringified
// `vocabulary` property is read; `valueMap(true)` would ship every property.
//
// `has('repositoryId', rid)` scopes the lookup to a single partition before
// `hasId(...)`; `hasId` is post-routing in Cosmos Gremlin and fans out across
// all partitions without the partition predicate.
//
// `hasNot('entityType')` keeps entity vertices out: entity types are vertex
// labels, so an entity can carry the `_repository` or `_vocabulary` label,
// and only entity vertices carry `entityType`.
export const VOCABULARY_READ_QUERY =
  "g.V().has('repositoryId', rid).hasId(within(mid, vid)).hasLabel('_repository', '_vocabulary').hasNot('entityType')" +
  ".project('id', 'json').by(id).by(coalesce(values('vocabulary'), constant('')))";

/**
 * Read the vocabulary for a repository. Throws `RepositoryNotFoundError` when
 * the `_repository` marker is absent, so a deleted repository is never
 * mistaken for one with no types yet: a delete drops the marker first and the
 * vocabulary vertex last, so a vocabulary without a marker belongs to a
 * repository being deleted. A repository whose vocabulary vertex is missing
 * reads as the empty vocabulary (`createRepository` always seeds it, so this
 * only covers data written outside this provider).
 */
export async function getVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  const markerId = repoVertexId(repositoryId);
  const vocabularyId = vocabVertexId(repositoryId);
  const result = await conn.submit(VOCABULARY_READ_QUERY, { rid: repositoryId, mid: markerId, vid: vocabularyId });
  let repositoryExists = false;
  let json: unknown = '';
  for (const item of result.items) {
    if (item === null || typeof item !== 'object') continue;
    // The driver hands a projection back as a Map or a plain object.
    const field = (key: string): unknown =>
      item instanceof Map ? item.get(key) : (item as Record<string, unknown>)[key];
    const id = field('id');
    if (id === markerId) repositoryExists = true;
    else if (id === vocabularyId) json = field('json');
  }
  if (!repositoryExists) throw new RepositoryNotFoundError(repositoryId);
  return parseStoredVocabulary(json);
}

// Compare-and-set write, up to and including the vocabulary property writes.
// The marker and the vocabulary vertex are fetched by id in the first,
// partition-scoped step (hasId alone fans out across partitions) and folded;
// the traversal continues only past the marker, so a repository whose marker
// a delete has already dropped is not written. The version filter sits before
// the property writes, so a stale `expectedVersion` matches nothing and writes
// nothing. `hasNot('entityType')` keeps entity vertices from passing for
// either system vertex (an entity's type is its label, so one can carry
// either label).
const VOCABULARY_CAS_WRITE =
  "g.V().has('repositoryId', rid).hasId(within(mid, vid)).fold().as('vs')" +
  ".unfold().hasLabel('_repository').hasNot('entityType')" +
  ".select('vs').unfold().hasId(vid).hasLabel('_vocabulary').hasNot('entityType').has('version', expectedVersion)" +
  ".property('version', newVersion).property('vocabulary', vocabJson)";

// The change-record vertex the compare-and-set write adds, with its fixed
// `vocablog:<changeId>` id (bound as `lid`) and its partition key. The id and
// the partition key are written only when the vertex is added.
const CHANGE_RECORD_ADD = "addV('_vocabularyChangeLog').property('id', lid).property('repositoryId', rid)";

// The record's properties. The ladder's optional slots are `choose` steps,
// and each one that writes is a document write of its own, so a request that
// fails part-way can leave a record holding only some of its properties.
const CHANGE_RECORD_LADDER = buildChangeRecordPropertyLadder();

// The compare-and-set write without a change record. `count()` reports how
// many vertices were written: 1 on success, 0 otherwise.
export const VOCABULARY_SAVE_QUERY = `${VOCABULARY_CAS_WRITE}.count()`;

// The compare-and-set write with its change record, in one traversal: the
// record vertex is added only by the traverser that passed the marker and the
// version filter and wrote the vocabulary, so a missing repository or a stale
// version writes neither. The record is added after the vocabulary writes: a
// write that loses a race for the vocabulary vertex fails (412) before the
// record exists. `count()` is 1 when both landed, 0 when nothing was written.
export const VOCABULARY_SAVE_WITH_CHANGE_QUERY = `${VOCABULARY_CAS_WRITE}.${CHANGE_RECORD_ADD}${CHANGE_RECORD_LADDER}.count()`;

// Follow-up read on a compare-and-set miss: the marker and the vocabulary
// vertex by id, each projected to its id, `version` property and blob. It reads
// the `version` property and the blob together: a vertex written by an earlier
// provider release has no `version` property, and `values('version')` alone
// would return nothing for it — indistinguishable from a missing vertex.
export const VOCABULARY_STATE_QUERY =
  "g.V().has('repositoryId', rid).hasId(within(mid, vid)).hasLabel('_repository', '_vocabulary').hasNot('entityType')" +
  ".project('id', 'version', 'json').by(id)" +
  ".by(coalesce(values('version'), constant('')))" +
  ".by(coalesce(values('vocabulary'), constant('')))";

// Write the change record unless it is already stored, only while the marker
// exists: the marker and the record are fetched by id in the first step, and
// past the marker `coalesce` finds an existing record or adds one. Used when a
// retried compare-and-set finds its own vocabulary already stored, so the
// record lands exactly once whether or not the first attempt wrote it. The
// property ladder sits after the `coalesce`, so it is written on a found
// record too: an attempt that stopped part-way through the ladder leaves a
// record missing properties, and this request completes it with the same
// values. An entity holding the record's id does not pass for the record; the
// add then fails (409) rather than reporting a record that was never written.
// `count()` is 1 when the record is stored, 0 when the marker is gone.
export const CHANGE_RECORD_ENSURE_QUERY =
  "g.V().has('repositoryId', rid).hasId(within(mid, lid)).fold().as('vs')" +
  ".unfold().hasLabel('_repository').hasNot('entityType')" +
  ".select('vs').coalesce(" +
  "__.unfold().hasId(lid).hasLabel('_vocabularyChangeLog').hasNot('entityType'), " +
  `__.${CHANGE_RECORD_ADD})${CHANGE_RECORD_LADDER}.count()`;

/**
 * Compare-and-set write of the vocabulary, with its change record when one is
 * given. The success path is one round-trip: the marker check, the version
 * filter, the property writes and the record's vertex are a single traversal,
 * so the check cannot be separated from the write by a concurrent writer, and
 * a write that matches nothing adds no record.
 *
 * The traversal is not a transaction: its writes are separate document
 * writes. A failure after the vocabulary write (other than a lost race, which
 * fails before it) can leave the vocabulary changed without its record; the
 * error propagates to the caller.
 *
 * Zero vertices written — or a 412 / 404 from a write that lost a race (see
 * `isLostWriteRace`) — means either the marker or the vocabulary vertex is
 * gone (the repository was deleted, is being deleted, or never existed), its
 * version is stale, or the connection retried a submit whose first attempt
 * had already committed. Only on that path does a follow-up read (the marker,
 * and the vocabulary's version property and blob together) decide the
 * outcome:
 *
 *   - no marker, or no vocabulary vertex → `RepositoryNotFoundError`
 *   - the vertex holds exactly the blob and version this call wrote →
 *     success. A transient-error retry re-ran the compare-and-set after the
 *     first attempt landed, so the retry saw its own write as a newer
 *     version; reporting a conflict would make the caller redo a change
 *     that is already stored. The change record, if any, is then added
 *     unless it is already stored, and its properties written either way
 *     (`CHANGE_RECORD_ENSURE_QUERY`): the first attempt may have stopped
 *     between the vocabulary write and the record, or part-way through the
 *     record's properties.
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
  changeRecord?: VocabularyChangeRecord,
): Promise<void> {
  const mid = repoVertexId(repositoryId);
  const vid = vocabVertexId(repositoryId);
  const vocabJson = JSON.stringify(vocabulary);
  const recordBindings =
    changeRecord === undefined
      ? undefined
      : { lid: changeLogVertexId(changeRecord.changeId), ...changeRecordToLadderBindings(changeRecord) };

  let written = 0;
  try {
    const write = await conn.submit(
      recordBindings === undefined ? VOCABULARY_SAVE_QUERY : VOCABULARY_SAVE_WITH_CHANGE_QUERY,
      {
        rid: repositoryId,
        mid,
        vid,
        expectedVersion,
        newVersion: vocabulary.version,
        vocabJson,
        ...recordBindings,
      },
    );
    written = Number(write.items[0] ?? 0);
  } catch (err: unknown) {
    // A concurrent writer replaced the vertex between this traversal's
    // version check and its write (412), or the vertex was dropped under it
    // (404). Either way nothing was written; the read below says whether the
    // outcome is a conflict or a missing repository.
    if (!isLostWriteRace(err)) throw err;
  }
  if (written > 0) return;

  const current = await conn.submit(VOCABULARY_STATE_QUERY, { rid: repositoryId, mid, vid });
  let repositoryExists = false;
  let state: Record<string, unknown> | null = null;
  for (const item of current.items) {
    if (item === null || typeof item !== 'object') continue;
    // The driver hands a projection back as a Map or a plain object.
    const row: Record<string, unknown> =
      item instanceof Map ? Object.fromEntries(item) : (item as Record<string, unknown>);
    if (row['id'] === mid) repositoryExists = true;
    else if (row['id'] === vid) state = row;
  }
  if (!repositoryExists || state === null) {
    throw new RepositoryNotFoundError(repositoryId);
  }
  const actualVersion = stringField(state, 'version');
  const storedJson = stringField(state, 'json');
  if (actualVersion === vocabulary.version && storedJson === vocabJson) {
    if (recordBindings !== undefined) {
      const ensured = await conn.submit(CHANGE_RECORD_ENSURE_QUERY, { rid: repositoryId, mid, ...recordBindings });
      if (Number(ensured.items[0] ?? 0) === 0) throw new RepositoryNotFoundError(repositoryId);
    }
    return;
  }

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

// The change-log reads. `hasNot('entityType')` keeps out entities: an entity
// typed `_vocabularyChangeLog` carries the record label, and only entity
// vertices carry `entityType`.
export const CHANGE_LOG_COUNT_QUERY =
  "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').hasNot('entityType').count()";
// Newest first by `proposedAt`; records proposed in the same millisecond are
// ordered by `changeId`, descending, so pages do not overlap or skip.
export const CHANGE_LOG_PAGE_QUERY =
  "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').hasNot('entityType')" +
  ".order().by('proposedAt', decr).by('changeId', decr).range(rangeStart, rangeEnd).valueMap(true)";

/**
 * Page the repository's change records, newest first by `proposedAt`, then
 * by `changeId` descending. The provider runs a marker point read alongside
 * (the read starts from a label, not an id).
 */
export async function getVocabularyChangeLog(
  conn: CosmosDbConnection,
  repositoryId: string,
  options?: PaginationOptions,
): Promise<PaginatedResult<VocabularyChangeRecord>> {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;

  // Count and data round-trips are independent — run them in parallel. No
  // property filters here, so the count is exact and `total` is always a number.
  // Both settle before either failure is raised, the page's first, so the
  // error does not depend on which round trip failed sooner.
  const [countSettled, dataSettled] = await Promise.allSettled([
    conn.submit(CHANGE_LOG_COUNT_QUERY, { rid: repositoryId }),
    conn.submit(CHANGE_LOG_PAGE_QUERY, { rid: repositoryId, rangeStart: offset, rangeEnd: offset + limit }),
  ]);
  if (dataSettled.status === 'rejected') throw dataSettled.reason;
  if (countSettled.status === 'rejected') throw countSettled.reason;

  const total = Number(countSettled.value.items[0] ?? 0);
  const items = (dataSettled.value.items as Record<string, unknown>[]).map(changeRecordFromGremlin);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    limit,
    offset,
  };
}
