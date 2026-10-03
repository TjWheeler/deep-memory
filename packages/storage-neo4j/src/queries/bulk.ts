// Bulk export / import Cypher queries.
//
// Storage shape and isolation rules carry over from entity / relationship
// CRUD; this module differs only in batching strategy:
//
// Export:
//   - Cursor-based pagination via `WHERE n.id > $cursor ORDER BY n.id LIMIT
//     $batchSize`. Cursor cost stays flat (or trends down) as offset grows
//     because the `(repositoryId, id)` uniqueness constraint's backing index
//     range-scans from the seek point. `SKIP $offset` is O(n) per page and
//     O(n²) across the full sweep; on a 100k-entity repository the gap is the
//     difference between a flat-line export and a quadratic blow-up.
//   - Embedding INCLUDED in the projection so a re-import is field-for-field
//     faithful. This is the one read path that intentionally keeps the heavy
//     `embedding` column on the wire — every other entity read defaults to
//     `loadEmbeddings: false`.
//   - Async generator yields 100-record `ExportChunk`s, entities first then
//     relationships. The cursor resets between phases. Each chunk's `isLast`
//     is determined by `records.length < batchSize`. An empty repository
//     yields one empty terminal chunk so consumers always see at least one
//     yield (matches the Cosmos shape).
//
// Import:
//   - Fixed-shape `UNWIND $rows AS row …` templates so the planner caches one
//     plan per template regardless of `$rows` contents. Plan-cache footprint
//     is one entity insert, one entity upsert, and one relationship insert and
//     upsert per relationship type, across every import in the system.
//   - `skipExistenceCheck: true` uses the insert branch: entities are
//     CREATEd, relationships are MERGEd on `{repositoryId, id, _attempt}`. A
//     duplicate entity row causes the whole chunk to fail with
//     `Neo.ClientError.Schema.ConstraintValidationFailed`; the import falls
//     back to writing that chunk row by row so good rows still land. The
//     downside is one extra round-trip per failed-chunk; the upside is that
//     the success path is one round-trip per chunk regardless of chunk size.
//     Only row-shaped failures take the fallback; a timeout or connection
//     failure stops the import with its typed error.
//   - The insert branch writes a token per statement (`_attempt`) on every
//     record it writes. The driver re-runs a statement whose commit
//     acknowledgement was lost; the token lets the re-run, and the per-row
//     fallback after it, recognise rows the first run committed instead of
//     reporting them as duplicates or writing them twice. Relationships
//     MERGE on the token rather than CREATE so a re-run matches the edge its
//     own first run wrote, while an edge any other call wrote, which carries
//     a different token or none, never matches.
//   - `skipExistenceCheck: false` uses the MERGE branch. `NodeUniqueIndexSeek`
//     on the `(repositoryId, id)` constraint backs the MERGE so the per-row
//     cost is O(log n) — re-imports are idempotent without paying a full scan.
//   - Default chunk size is 500. The throughput sweep showed the per-chunk
//     wall-time is flat from 50 → 500 rows, so chunkSize 500 amortises the
//     round-trip across 5× the rows of the Cosmos default without inflating
//     latency. Callers override via `BulkImportOptions.chunkSize`. (Public
//     surface — the `BulkImportOptions` interface currently exposes
//     adaptive-concurrency knobs only; chunk size lives in a private
//     extension here.)
//   - Bounded dispatch via `runBounded` — a hand-rolled minimal pool with
//     default concurrency 8. Neo4j Community has no throttle signal; the
//     adaptive-concurrency controller the Cosmos provider needs has no
//     analog. Every chunk statement write-locks the repository marker, so
//     the chunks of one repository's import serialise on the server; the
//     pool overlaps their round-trips and client-side work, not their
//     writes. Chunks complete independently; their results aggregate into a
//     single `BulkImportResult` at the end. Per-row errors are collected per
//     chunk, never swallowed. The first chunk that rejects stops dispatch.

import { randomUUID } from 'node:crypto';
import type {
  BulkImportItemError,
  BulkImportOptions,
  BulkImportResult,
  ExportChunk,
  ImportChunk,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import {
  assertSafeRelationshipType,
  bigintToSafeNumber,
  buildEntityProjection,
  buildRelationshipProjection,
  entityFromRecord,
  entityToParams,
  entityUserPropertyParams,
  relationshipFromRecord,
  relationshipToParams,
  WRITE_ATTEMPT_PROPERTY,
} from '../mapping.js';
import {
  DeepMemoryError,
  DuplicateEntityError,
  DuplicateRelationshipError,
  ProviderError,
  RepositoryNotFoundError,
  SlugConflictError,
} from '@utaba/deep-memory';
import {
  isDeletedEntityFailure,
  isEntityUniquenessViolation,
  isMemoryLimitFailure,
  isRowShapedFailure,
  isTransactionMemoryLimit,
  mapDriverError,
  toTypedError,
  type DriverErrorContext,
} from '../errors.js';
import { LOCK_REPOSITORY_MARKER } from './repositoryLock.js';

/** What `Neo4jConnection.executeQuery` resolves to. */
type QueryResult = Awaited<ReturnType<Neo4jConnection['executeQuery']>>;

/**
 * Streaming-export chunk size. Each yielded `ExportChunk` carries at most
 * `EXPORT_BATCH_SIZE` records. Matches the Cosmos provider default — the
 * consumer is an async iterable, smaller chunks reduce peak memory pressure
 * while the cursor pagination keeps server cost flat regardless of position
 * in the sweep.
 */
const EXPORT_BATCH_SIZE = 100;

/**
 * Default chunk size for `importBulk`. The throughput sweep against
 * `neo4j:5-community` defaults found per-chunk wall time flat from 50 →
 * 500 rows; chunkSize 500 amortises the round-trip across 5× the rows of
 * the Cosmos default (100) with no per-chunk latency penalty. Callers can
 * override via the private `chunkSize` extension on `BulkImportOptions`.
 */
const DEFAULT_IMPORT_CHUNK_SIZE = 500;

/**
 * Default bounded-parallelism level for `importBulk`. Neo4j Community has
 * no per-query throttle signal so the adaptive controller used by the Cosmos
 * provider has no analog. A fixed pool of 8 in-flight chunks matches the
 * driver's default connection pool capacity and saturates the server
 * comfortably without overwhelming the local instance during verify runs.
 */
const DEFAULT_IMPORT_CONCURRENCY = 8;

/**
 * Internal extension to `BulkImportOptions` accepted by this provider only.
 * The public `BulkImportOptions` interface omits these knobs because they
 * are Neo4j-specific; callers passing them through the public `importBulk`
 * surface land on the right branch via the `options as` cast in the
 * implementation below. Documented here so the extension is discoverable
 * from the source.
 */
interface Neo4jBulkImportExtension {
  /** Rows per `UNWIND` chunk. Default 500. */
  chunkSize?: number;
  /** In-flight chunks. Default 8. */
  concurrency?: number;
}

// ─── Export ──────────────────────────────────────────────────────────

const EXPORT_ENTITY_PROJECTION = buildEntityProjection({ loadEmbeddings: true });
const EXPORT_RELATIONSHIP_PROJECTION = buildRelationshipProjection();

const EXPORT_ENTITIES_FIRST_PAGE = `
MATCH (n:_Entity {repositoryId: $rid})
RETURN ${EXPORT_ENTITY_PROJECTION}
ORDER BY n.id
LIMIT $batchSize
`;

const EXPORT_ENTITIES_NEXT_PAGE = `
MATCH (n:_Entity {repositoryId: $rid})
WHERE n.id > $cursor
RETURN ${EXPORT_ENTITY_PROJECTION}
ORDER BY n.id
LIMIT $batchSize
`;

const EXPORT_RELATIONSHIPS_FIRST_PAGE = `
MATCH (:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]->(:_Entity {repositoryId: $rid})
RETURN ${EXPORT_RELATIONSHIP_PROJECTION}
ORDER BY r.id
LIMIT $batchSize
`;

const EXPORT_RELATIONSHIPS_NEXT_PAGE = `
MATCH (:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]->(:_Entity {repositoryId: $rid})
WHERE r.id > $cursor
RETURN ${EXPORT_RELATIONSHIP_PROJECTION}
ORDER BY r.id
LIMIT $batchSize
`;

/**
 * Stream every entity then every relationship in the repository, in
 * cursor-ordered pages of `EXPORT_BATCH_SIZE`. Each yielded chunk includes a
 * monotonic `sequence` and an `isLast` flag (true on the final entity chunk
 * and the final relationship chunk). An empty repository still yields one
 * terminal entity chunk so consumers always observe at least one item — the
 * Cosmos provider behaves the same way.
 *
 * The projection includes the embedding because a faithful round-trip is
 * the export-side contract; every other entity read defaults to embedding-off.
 */
export async function* exportAll(
  conn: Neo4jConnection,
  repositoryId: string,
): AsyncIterable<ExportChunk> {
  let sequence = 0;

  let cursor: string | undefined;
  while (true) {
    const query = cursor === undefined ? EXPORT_ENTITIES_FIRST_PAGE : EXPORT_ENTITIES_NEXT_PAGE;
    const params: Record<string, unknown> =
      cursor === undefined
        ? { batchSize: BigInt(EXPORT_BATCH_SIZE) }
        : { cursor, batchSize: BigInt(EXPORT_BATCH_SIZE) };
    const result = await conn.executeQuery(query, params, { repositoryId, routing: 'READ' });
    const entities = result.records.map((record) => entityFromRecord(record));
    const isLast = entities.length < EXPORT_BATCH_SIZE;
    if (entities.length > 0) {
      cursor = entities[entities.length - 1]!.id;
      yield {
        type: 'entities',
        data: entities,
        sequence: sequence++,
        isLast,
      };
    }
    if (isLast) break;
  }

  let relCursor: string | undefined;
  while (true) {
    const query =
      relCursor === undefined ? EXPORT_RELATIONSHIPS_FIRST_PAGE : EXPORT_RELATIONSHIPS_NEXT_PAGE;
    const params: Record<string, unknown> =
      relCursor === undefined
        ? { batchSize: BigInt(EXPORT_BATCH_SIZE) }
        : { cursor: relCursor, batchSize: BigInt(EXPORT_BATCH_SIZE) };
    const result = await conn.executeQuery(query, params, { repositoryId, routing: 'READ' });
    const relationships = result.records.map((record) => relationshipFromRecord(record));
    const isLast = relationships.length < EXPORT_BATCH_SIZE;
    if (relationships.length > 0) {
      relCursor = relationships[relationships.length - 1]!.id;
      yield {
        type: 'relationships',
        data: relationships,
        sequence: sequence++,
        isLast,
      };
    }
    if (isLast) break;
  }

  if (sequence === 0) {
    yield {
      type: 'entities',
      data: [],
      sequence: 0,
      isLast: true,
    };
  }
}

// ─── Import — fixed-shape templates ──────────────────────────────────
//
// Every template opens with `LOCK_REPOSITORY_MARKER`: the chunk write-locks
// the `_Repository` marker and writes only while the marker still exists,
// so a chunk cannot commit after `deleteRepository` has drained the
// repository (see `repositoryLock.ts`). The lock is held per chunk, so the
// chunks of one import — and any other create in the repository — serialise
// on the marker for the length of each chunk's statement. A missing marker
// writes nothing and the template says so in its result (`written` = 0 for
// entities, no rows for relationships); the import then stops with
// `RepositoryNotFoundError`.

/**
 * `INSERT_ENTITIES_QUERY` — `skipExistenceCheck: true` branch. One CREATE
 * per row, no existence check; the caller asserts rows are fresh. Constraint
 * violations surface as `Neo.ClientError.Schema.ConstraintValidationFailed`
 * on chunk commit. The Cypher is byte-identical across every chunk in every
 * import, so the planner caches one plan total.
 *
 * User-supplied scalar properties are written through a separate `SET n +=
 * row.userProperties` clause — the row payload carries the user-property
 * map under a single binding so the Cypher string stays fixed regardless of
 * which keys are populated. The JSON-stringified `properties` blob remains
 * authoritative for `entity.properties` round-trip (per O1); the user-property
 * scalars exist for `findEntities` predicate queries only.
 *
 * Every node carries the statement's write token (`$writeAttempt`), so a
 * refusal of a re-run can be told apart from a genuine clash (see
 * `importEntityChunk`).
 *
 * Returns one row: `written`, the number of rows written — 0 when the
 * repository marker is missing.
 */
const INSERT_ENTITIES_QUERY = `${LOCK_REPOSITORY_MARKER}
UNWIND $rows AS row
CREATE (n:_Entity)
SET
  n.id = row.id,
  n.repositoryId = $rid,
  n.entityType = row.entityType,
  n.label = row.label,
  n.slug = row.slug,
  n.summary = row.summary,
  n.properties = row.properties,
  n.data = row.data,
  n.dataFormat = row.dataFormat,
  n.embedding = row.embedding,
  n.createdBy = row.createdBy,
  n.createdByType = row.createdByType,
  n.createdAt = row.createdAt,
  n.createdInConversation = row.createdInConversation,
  n.createdFromMessage = row.createdFromMessage,
  n.modifiedBy = row.modifiedBy,
  n.modifiedByType = row.modifiedByType,
  n.modifiedAt = row.modifiedAt,
  n.modifiedInConversation = row.modifiedInConversation,
  n.modifiedFromMessage = row.modifiedFromMessage,
  n.${WRITE_ATTEMPT_PROPERTY} = $writeAttempt
SET n += row.userProperties
RETURN count(*) AS written
`;

/**
 * How many of a chunk's ids hold an entity carrying the chunk statement's
 * write token. Seeks the `(repositoryId, id)` unique index for each id.
 */
export const ENTITY_WRITE_ATTEMPT_COUNT_QUERY = `MATCH (n:_Entity {repositoryId: $rid})
WHERE n.id IN $ids AND n.${WRITE_ATTEMPT_PROPERTY} = $writeAttempt
RETURN count(n) AS carrying
`;

/**
 * The write token stored on each of the given ids' entities, for the
 * per-row fallback to tell rows a re-run refused from genuine clashes in
 * one round trip. Seeks the `(repositoryId, id)` unique index for each id;
 * an id with no entity returns no row.
 */
export const ENTITY_WRITE_ATTEMPTS_QUERY = `MATCH (n:_Entity {repositoryId: $rid})
WHERE n.id IN $ids
RETURN n.id AS id, n.${WRITE_ATTEMPT_PROPERTY} AS writeAttempt
`;

/**
 * `UPSERT_ENTITIES_QUERY` — `skipExistenceCheck: false` branch. MERGE keyed
 * on `(repositoryId, id)` so re-imports are idempotent. The
 * `NodeUniqueIndexSeek(Locking)` operator on the uniqueness constraint's
 * backing index makes the per-row cost O(log n).
 *
 * `ON CREATE` and `ON MATCH` SET the same field set — re-import overwrites
 * the existing row with the imported values, matching the Cosmos provider's
 * coalesce-style upsert semantic. The user-property `SET n += row.userProperties`
 * lives unconditionally so the Cypher string stays fixed; an empty
 * user-property map is a Cypher no-op.
 *
 * Returns one row: `written`, as for `INSERT_ENTITIES_QUERY`.
 */
const UPSERT_ENTITIES_QUERY = `${LOCK_REPOSITORY_MARKER}
UNWIND $rows AS row
MERGE (n:_Entity {repositoryId: $rid, id: row.id})
ON CREATE SET
  n.entityType = row.entityType,
  n.label = row.label,
  n.slug = row.slug,
  n.summary = row.summary,
  n.properties = row.properties,
  n.data = row.data,
  n.dataFormat = row.dataFormat,
  n.embedding = row.embedding,
  n.createdBy = row.createdBy,
  n.createdByType = row.createdByType,
  n.createdAt = row.createdAt,
  n.createdInConversation = row.createdInConversation,
  n.createdFromMessage = row.createdFromMessage,
  n.modifiedBy = row.modifiedBy,
  n.modifiedByType = row.modifiedByType,
  n.modifiedAt = row.modifiedAt,
  n.modifiedInConversation = row.modifiedInConversation,
  n.modifiedFromMessage = row.modifiedFromMessage
ON MATCH SET
  n.entityType = row.entityType,
  n.label = row.label,
  n.slug = row.slug,
  n.summary = row.summary,
  n.properties = row.properties,
  n.data = row.data,
  n.dataFormat = row.dataFormat,
  n.embedding = row.embedding,
  n.createdBy = row.createdBy,
  n.createdByType = row.createdByType,
  n.createdAt = row.createdAt,
  n.createdInConversation = row.createdInConversation,
  n.createdFromMessage = row.createdFromMessage,
  n.modifiedBy = row.modifiedBy,
  n.modifiedByType = row.modifiedByType,
  n.modifiedAt = row.modifiedAt,
  n.modifiedInConversation = row.modifiedInConversation,
  n.modifiedFromMessage = row.modifiedFromMessage
SET n += row.userProperties
RETURN count(*) AS written
`;

/** Per-row outcome a relationship import template reports. */
const RELATIONSHIP_ROW_OUTCOME = {
  written: 'written',
  endpointMissing: 'endpoint-missing',
  idExists: 'id-exists',
} as const;

/**
 * Head of the insert relationship template: the marker lock, then each
 * row's endpoints matched under the repository scope. A missing marker
 * leaves no row to unwind, so the statement returns nothing.
 */
const RELATIONSHIP_INSERT_HEAD = `${LOCK_REPOSITORY_MARKER}
UNWIND $rows AS row
OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: row.sourceEntityId})
OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: row.targetEntityId})
`;

/**
 * Head of the upsert relationship template. After the marker lock it
 * collects, in one pass over the repository's edges, every edge that already
 * carries one of the chunk's ids (`held`), then matches each row's
 * endpoints under the repository scope. `$ids` holds the chunk's row ids.
 *
 * Relationship ids are unique across every type in the repository, and
 * Neo4j relationship indexes and constraints cover one type only, so the
 * lookup is anchored on the repository's entities. Naming the anchor and
 * requiring `e.id IS NOT NULL` lets the planner seek the `(repositoryId, id)`
 * unique index for the repository's entities instead of scanning every
 * `_Entity` in the database, and `repositoryId` on the edge pattern admits
 * only the repository's own edges. Collecting once per chunk keeps the cost
 * to one pass over the repository's edges per chunk rather than one per
 * row. `held` reflects the store before the chunk writes, so the caller
 * writes a chunk that repeats an id in waves of distinct ids.
 *
 * Grouping the collect by `live` keeps a missing marker at zero rows: an
 * aggregate with a grouping key emits nothing for empty input.
 */
const RELATIONSHIP_UPSERT_HEAD = `${LOCK_REPOSITORY_MARKER}
OPTIONAL MATCH (e:_Entity {repositoryId: $rid})-[held {repositoryId: $rid}]->()
WHERE e.id IS NOT NULL AND held.id IN $ids
WITH live, collect(held) AS held
UNWIND $rows AS row
OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: row.sourceEntityId})
OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: row.targetEntityId})
`;

/**
 * Build the relationship import Cypher for a given relationship type —
 * `skipExistenceCheck: true` branch. Cypher 25 cannot parameterise the
 * relationship-type slot, so each distinct type compiles to its own
 * plan-cache entry. The vocabulary bounds the per-type cardinality (the same
 * trade-off `createRelationship` makes).
 *
 * Each row reports its outcome: `written`, or `endpoint-missing` (the source
 * or target is not in the repository — an endpoint in another repository
 * fails the scoped match the same way). Only a `written` row is created. A
 * missing repository marker returns no rows at all.
 *
 * The statement does not look for the row's id among the repository's
 * existing edges: with `skipExistenceCheck: true` the caller vouches that
 * its ids are new to the store, and checking each chunk against every edge
 * in the repository would make a large import quadratic. `importBulk` still
 * refuses an id repeated within the one call.
 *
 * The edge is MERGEd on its id together with the statement's write token
 * (`$writeAttempt`). A re-run of a statement whose commit acknowledgement
 * was lost, or the per-row fallback reusing the chunk's token, matches the
 * edge the first run wrote instead of writing a second one. An edge written
 * by any other statement carries another token, so it never matches and the
 * row still writes: the template trusts the caller about stored ids exactly
 * as a plain CREATE would.
 */
export function buildInsertRelationshipsQuery(relationshipType: string): string {
  const safe = assertSafeRelationshipType(relationshipType);
  const o = RELATIONSHIP_ROW_OUTCOME;
  return `${RELATIONSHIP_INSERT_HEAD}
WITH row, s, t,
  CASE
    WHEN s IS NULL OR t IS NULL THEN '${o.endpointMissing}'
    ELSE '${o.written}'
  END AS outcome
FOREACH (_ IN CASE WHEN outcome = '${o.written}' THEN [1] ELSE [] END |
  MERGE (s)-[r:${safe} {repositoryId: $rid, id: row.id, ${WRITE_ATTEMPT_PROPERTY}: $writeAttempt}]->(t)
  ON CREATE SET
    r.relationshipType = row.relationshipType,
    r.sourceEntityId = row.sourceEntityId,
    r.targetEntityId = row.targetEntityId,
    r.properties = row.properties,
    r.bidirectional = row.bidirectional,
    r.createdBy = row.createdBy,
    r.createdByType = row.createdByType,
    r.createdAt = row.createdAt,
    r.createdInConversation = row.createdInConversation,
    r.createdFromMessage = row.createdFromMessage,
    r.modifiedBy = row.modifiedBy,
    r.modifiedByType = row.modifiedByType,
    r.modifiedAt = row.modifiedAt,
    r.modifiedInConversation = row.modifiedInConversation,
    r.modifiedFromMessage = row.modifiedFromMessage
)
RETURN row.id AS id, outcome
`;
}

/**
 * `skipExistenceCheck: false` branch: as `buildInsertRelationshipsQuery`,
 * but the row MERGEs on `(source)-[type {repositoryId, id}]->(target)`, so
 * re-importing an edge updates it in place. The statement checks the row's
 * id against the repository's existing edges (`held`, see
 * `RELATIONSHIP_UPSERT_HEAD`): the id counts as in use — and the row is
 * refused with `id-exists` — when an edge carrying it is not the one the
 * MERGE would match, i.e. it has a different type or different endpoints.
 */
export function buildUpsertRelationshipsQuery(relationshipType: string): string {
  const safe = assertSafeRelationshipType(relationshipType);
  const o = RELATIONSHIP_ROW_OUTCOME;
  return `${RELATIONSHIP_UPSERT_HEAD}
WITH row, s, t,
  CASE
    WHEN s IS NULL OR t IS NULL THEN '${o.endpointMissing}'
    WHEN any(x IN held WHERE x.id = row.id
      AND NOT (type(x) = row.relationshipType AND startNode(x) = s AND endNode(x) = t))
      THEN '${o.idExists}'
    ELSE '${o.written}'
  END AS outcome
FOREACH (_ IN CASE WHEN outcome = '${o.written}' THEN [1] ELSE [] END |
  MERGE (s)-[r:${safe} {repositoryId: $rid, id: row.id}]->(t)
  ON CREATE SET
    r.relationshipType = row.relationshipType,
    r.sourceEntityId = row.sourceEntityId,
    r.targetEntityId = row.targetEntityId,
    r.properties = row.properties,
    r.bidirectional = row.bidirectional,
    r.createdBy = row.createdBy,
    r.createdByType = row.createdByType,
    r.createdAt = row.createdAt,
    r.createdInConversation = row.createdInConversation,
    r.createdFromMessage = row.createdFromMessage,
    r.modifiedBy = row.modifiedBy,
    r.modifiedByType = row.modifiedByType,
    r.modifiedAt = row.modifiedAt,
    r.modifiedInConversation = row.modifiedInConversation,
    r.modifiedFromMessage = row.modifiedFromMessage
  ON MATCH SET
    r.properties = row.properties,
    r.bidirectional = row.bidirectional,
    r.modifiedBy = row.modifiedBy,
    r.modifiedByType = row.modifiedByType,
    r.modifiedAt = row.modifiedAt,
    r.modifiedInConversation = row.modifiedInConversation,
    r.modifiedFromMessage = row.modifiedFromMessage
)
RETURN row.id AS id, outcome
`;
}

// ─── Import — public entry ───────────────────────────────────────────

/**
 * Run a bulk import. Returns a single aggregate result spanning every chunk
 * and every entity / relationship row across the entire input.
 *
 * Concurrency: chunks within a phase (entities or relationships) are
 * dispatched through a bounded pool. Every chunk statement write-locks the
 * repository marker, so the chunks of one repository's import serialise on
 * that lock as they reach the server — the pool overlaps client-side work
 * and round-trips, not the writes themselves. Entities are imported strictly
 * before relationships across the whole input — relationship MATCH on the
 * source/target entities requires those entities to exist, so cross-phase
 * parallelism is not safe.
 *
 * Relationship ids:
 * - `skipExistenceCheck: true` (insert) trusts the caller that its ids are
 *   not already in the store; the statement does not look. An id repeated
 *   within the one call is refused: its first occurrence is attempted, and
 *   each later one is recorded with `RELATIONSHIP_ALREADY_EXISTS` whatever
 *   the first occurrence's outcome.
 * - `skipExistenceCheck: false` (upsert) checks each id against the
 *   repository's existing edges, whatever their type. An edge with the same
 *   id, type and endpoints is updated in place; one whose type or endpoints
 *   differ makes the row fail with `RELATIONSHIP_ALREADY_EXISTS`. The
 *   endpoints are checked before the id, because telling "the same edge"
 *   from "another edge" needs the bound source and target: a row with a
 *   missing endpoint reports `ENTITY_NOT_FOUND` even when its id is in use.
 *   An id repeated within one chunk is applied in input order, each
 *   occurrence meeting the edge the one before it wrote. Occurrences in
 *   different chunks (a different type, or more than a chunk apart) are
 *   applied in no defined order, but each still meets the others' writes,
 *   so the id never ends up on two edges.
 *
 * Error policy:
 * - A row the mapping refuses (an unsafe or reserved property key, a
 *   relationship type that is not a safe identifier) is recorded in
 *   `result.errors` with the typed error's `code` and left out of the write.
 * - A chunk that fails because of its rows (a uniqueness clash, a value the
 *   server refuses — see `isRowShapedFailure`) or runs out of transaction
 *   memory is retried row by row so the surviving rows still land; each
 *   failing row is recorded with its `code`. A single row over the
 *   per-transaction memory limit is a row error; an exhausted server-wide
 *   memory pool is a store failure.
 * - A relationship whose source or target is not in the repository is
 *   recorded with `ENTITY_NOT_FOUND`; one refused for its id (see above)
 *   with `RELATIONSHIP_ALREADY_EXISTS`. Neither is written, and the rest of
 *   the chunk still lands.
 * - A chunk refused with `Neo.ClientError.Statement.EntityNotFound` (a node
 *   it locked or matched was deleted by a concurrent transaction while it
 *   waited) is retried row by row: each re-run reads the committed state, so
 *   a deleted endpoint becomes an `ENTITY_NOT_FOUND` row and a deleted
 *   marker stops the import (below). A single row still refused that way is
 *   recorded with `ENTITY_NOT_FOUND` once a read confirms the marker is
 *   still there.
 * - A missing repository marker — the repository does not exist, or was
 *   deleted while the import ran — stops the import with
 *   `RepositoryNotFoundError`.
 *
 * `result.errors` lists entity rows before relationship rows. Among the
 * relationships, the repeats an insert refuses come first, then each
 * chunk's failures in chunk order (chunks are grouped by type), so the list
 * is not in input order; each record's `item` names its row.
 * - Any other failure — a `QueryTimeoutError`, an unavailable or expired
 *   connection — means the store itself is failing: retrying every row would
 *   multiply the load and hide the cause, so the import stops dispatching
 *   chunks (and per-row fallbacks already running stop at their next row) and
 *   rejects with the typed error. Rows written before that point stay
 *   written.
 */
export async function importBulk(
  conn: Neo4jConnection,
  repositoryId: string,
  data: ImportChunk[],
  options?: BulkImportOptions,
): Promise<BulkImportResult> {
  const skipCheck = options?.skipExistenceCheck === true;
  const ext = (options ?? {}) as BulkImportOptions & Neo4jBulkImportExtension;
  const chunkSize = ext.chunkSize ?? DEFAULT_IMPORT_CHUNK_SIZE;
  const concurrency = ext.concurrency ?? DEFAULT_IMPORT_CONCURRENCY;

  const allEntities: StoredEntity[] = [];
  const allRelationships: StoredRelationship[] = [];
  for (const chunk of data) {
    if (chunk.entities) allEntities.push(...chunk.entities);
    if (chunk.relationships) allRelationships.push(...chunk.relationships);
  }

  const errors: BulkImportItemError[] = [];
  const run: ImportRun = { stopped: false };
  const stopOnFailure = <T, R>(fn: (item: T) => Promise<R>) => async (item: T): Promise<R> => {
    try {
      return await fn(item);
    } catch (err) {
      run.stopped = true;
      throw err;
    }
  };

  // Entity phase. Slice the flat list into UNWIND chunks; submit through the
  // bounded pool. The pool size is fixed (no adaptive controller — Neo4j has
  // no throttle signal to learn from).
  const entityChunks = sliceIntoChunks(allEntities, chunkSize);
  const entityResults = await runBounded(
    entityChunks,
    concurrency,
    stopOnFailure((chunk: StoredEntity[]) => importEntityChunk(conn, repositoryId, chunk, skipCheck, run)),
  );

  let entitiesImported = 0;
  for (const res of entityResults) {
    entitiesImported += res.imported;
    errors.push(...res.errors);
  }

  // Insert mode keeps a repeated id out of the store here, because its
  // statement does not check ids: the first occurrence goes on to be
  // attempted and every later one is refused, whether or not the first is
  // written. Upsert's statement handles repeats.
  let relationshipsToWrite = allRelationships;
  if (skipCheck) {
    const split = splitRepeatedIds(allRelationships);
    relationshipsToWrite = split.first;
    for (const rel of split.repeats) {
      errors.push(refusedRow(`relationship:${rel.id}`, new DuplicateRelationshipError(rel.id)));
    }
  }

  const relationshipChunks = groupRelationshipsByTypeIntoChunks(relationshipsToWrite, chunkSize);
  const relationshipResults = await runBounded(
    relationshipChunks,
    concurrency,
    stopOnFailure((group: RelationshipChunk) =>
      importRelationshipChunk(conn, repositoryId, group, skipCheck, run),
    ),
  );

  let relationshipsImported = 0;
  for (const res of relationshipResults) {
    relationshipsImported += res.imported;
    errors.push(...res.errors);
  }

  return { entitiesImported, relationshipsImported, errors };
}

interface ChunkResult {
  imported: number;
  errors: BulkImportItemError[];
}

interface RelationshipChunk {
  relationshipType: string;
  rows: StoredRelationship[];
}

/**
 * Shared by every chunk of one import. Set once any chunk rejects, so a
 * sibling chunk's per-row fallback stops at its next row instead of writing
 * on against a failing store.
 */
interface ImportRun {
  stopped: boolean;
}

/**
 * After a whole-chunk write fails: rethrow `error` as a typed error unless
 * writing the rows one at a time can help — a row-shaped failure, the chunk
 * running out of transaction memory (a single row needs far less), or a node
 * the chunk touched being deleted while it waited (each re-run reads the
 * committed state and reports the missing endpoint or marker as an outcome).
 */
function rethrowUnlessChunkCanFallBack(error: unknown): void {
  if (!isRowShapedFailure(error) && !isMemoryLimitFailure(error) && !isDeletedEntityFailure(error)) {
    mapDriverError(error, { operation: 'importBulk' });
  }
}

/**
 * Reads whether the repository marker exists, after a single-row write was
 * refused on a node a concurrent transaction deleted. The refusal does not
 * name the node, and a deleted marker must stop the import rather than be
 * recorded against the row.
 */
const REPOSITORY_MARKER_EXISTS_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
RETURN repo IS NOT NULL AS repositoryExists
`;

/**
 * The row error for a single-row write refused because a node it touched was
 * deleted by a concurrent transaction. Throws `RepositoryNotFoundError` when
 * that node was the repository marker, which stops the import as a missing
 * marker does anywhere else in it.
 */
async function deletedNodeRowError(
  conn: Neo4jConnection,
  repositoryId: string,
  item: string,
  detail: string,
): Promise<BulkImportItemError> {
  let check: QueryResult;
  try {
    check = await conn.executeQuery(REPOSITORY_MARKER_EXISTS_QUERY, {}, { repositoryId });
  } catch (err) {
    mapDriverError(err, { operation: 'importBulk' });
  }
  const exists: unknown = check.records[0]?.get('repositoryExists');
  if (typeof exists !== 'boolean') {
    throw new ProviderError('Neo4j import repository check returned no row.');
  }
  if (!exists) throw new RepositoryNotFoundError(repositoryId);
  return { item, error: `${detail} was deleted by a concurrent transaction`, code: 'ENTITY_NOT_FOUND' };
}

/**
 * After a single-row write fails: rethrow `error` as a typed error unless it
 * belongs to that row — a row-shaped failure, or the row alone exceeding the
 * per-transaction memory limit. An exhausted server-wide memory pool is a
 * state of the store, so it stops the import.
 */
function rethrowUnlessRowFailure(error: unknown): void {
  if (!isRowShapedFailure(error) && !isTransactionMemoryLimit(error)) {
    mapDriverError(error, { operation: 'importBulk' });
  }
}

/** A per-row error record carrying the typed error's message and code. */
function rowError(item: string, error: unknown, context: DriverErrorContext): BulkImportItemError {
  const typed = toTypedError(error, { ...context, operation: 'importBulk' });
  return { item, error: typed.message, code: typed.code };
}

/** A row the mapping refused before any round-trip. */
function refusedRow(item: string, error: DeepMemoryError): BulkImportItemError {
  return { item, error: error.message, code: error.code };
}

async function importEntityChunk(
  conn: Neo4jConnection,
  repositoryId: string,
  chunk: StoredEntity[],
  skipCheck: boolean,
  run: ImportRun,
): Promise<ChunkResult> {
  if (chunk.length === 0) return { imported: 0, errors: [] };

  // Build each row's params on its own so a row the mapping refuses (an
  // unsafe or reserved property key) is recorded against that row and the
  // rest of the chunk still lands. `repositoryId` is bound globally via the
  // chokepoint's `$rid`; the row map only carries per-entity fields, which
  // keeps the Bolt payload smaller on large chunks.
  const errors: BulkImportItemError[] = [];
  const prepared: Array<PreparedRow<StoredEntity>> = [];
  for (const entity of chunk) {
    try {
      prepared.push({
        item: entity,
        params: { ...entityToParams(entity), userProperties: entityUserPropertyParams(entity.properties) },
      });
    } catch (err) {
      if (!(err instanceof DeepMemoryError)) throw err;
      errors.push(refusedRow(`entity:${entity.id}`, err));
    }
  }
  if (prepared.length === 0) return { imported: 0, errors };
  const query = skipCheck ? INSERT_ENTITIES_QUERY : UPSERT_ENTITIES_QUERY;
  // The insert template writes one token for the whole chunk statement.
  const writeAttempt = skipCheck ? randomUUID() : undefined;

  let result: QueryResult;
  try {
    result = await conn.executeQuery(
      query,
      { rows: prepared.map((row) => row.params), ...(writeAttempt === undefined ? {} : { writeAttempt }) },
      { repositoryId },
    );
  } catch (err) {
    rethrowUnlessChunkCanFallBack(err);
    // The driver re-runs a chunk whose commit acknowledgement was lost, and
    // the re-run trips the id or slug constraint on the rows its own first
    // run committed. Every row's id holding an entity with this chunk's
    // token proves the whole chunk landed (a chunk commits all its rows or
    // none). Anything less — a genuine clash, an id repeated within the
    // chunk, a row a concurrent delete removed since — goes row by row.
    if (
      writeAttempt !== undefined &&
      isEntityUniquenessViolation(err) &&
      (await countEntitiesCarrying(conn, repositoryId, prepared, writeAttempt)) === prepared.length
    ) {
      return { imported: prepared.length, errors };
    }
    const fallback = await fallbackPerEntity(conn, repositoryId, prepared, query, run, writeAttempt);
    return { imported: fallback.imported, errors: [...errors, ...fallback.errors] };
  }
  assertEntityRowsWritten(result, repositoryId);
  return { imported: prepared.length, errors };
}

/**
 * How many of the rows' ids hold an entity carrying `writeAttempt`. Ids are
 * unique in the repository, so this equals the row count only when the rows
 * are distinct and every one of them was written with that token.
 */
async function countEntitiesCarrying(
  conn: Neo4jConnection,
  repositoryId: string,
  prepared: ReadonlyArray<PreparedRow<StoredEntity>>,
  writeAttempt: string,
): Promise<number> {
  let result: QueryResult;
  try {
    result = await conn.executeQuery(
      ENTITY_WRITE_ATTEMPT_COUNT_QUERY,
      { ids: prepared.map((row) => row.item.id), writeAttempt },
      { repositoryId },
    );
  } catch (err) {
    mapDriverError(err, { operation: 'importBulk' });
  }
  const carrying = result.records[0]?.get('carrying');
  if (carrying === undefined || carrying === null) {
    throw new ProviderError('Neo4j entity import token count returned no row.');
  }
  return bigintToSafeNumber(carrying);
}

/**
 * The entity templates report `written`, the rows the statement wrote. Zero
 * for a non-empty chunk means the repository marker was missing.
 */
function assertEntityRowsWritten(result: QueryResult, repositoryId: string): void {
  const written = result.records[0]?.get('written');
  if (written === undefined || written === null) {
    throw new ProviderError('Neo4j entity import returned no written count.');
  }
  if (bigintToSafeNumber(written) === 0) throw new RepositoryNotFoundError(repositoryId);
}

/** A row to import, paired with the Cypher params built from it. */
interface PreparedRow<T> {
  item: T;
  params: Record<string, unknown>;
}

/**
 * When a whole-chunk write fails because of its rows (e.g. one constraint
 * violation aborts the entire MERGE/CREATE transaction), retry the chunk
 * row-by-row so the rows that would have succeeded still land. The per-row
 * path is slower per call but only runs when a chunk actually failed. A
 * store failure on any row stops the fallback and propagates; so does a
 * failure in a sibling chunk (the fallback stops at its next row), and so
 * does a missing repository.
 *
 * For the insert template (`chunkWriteAttempt` set), each row is written
 * with a token of its own. A row refused for its id or slug counts as
 * imported when the entity stored under its id carries its own token (the
 * driver re-ran the row after a lost acknowledgement) or the chunk's token
 * (the chunk statement committed it). Rows need their own tokens because an
 * entity id repeated within one call is not refused up front: with a shared
 * token, a later repeat would read the earlier occurrence's entity as its
 * own and be reported imported instead of `ENTITY_ALREADY_EXISTS`.
 */
async function fallbackPerEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  prepared: ReadonlyArray<PreparedRow<StoredEntity>>,
  query: string,
  run: ImportRun,
  chunkWriteAttempt: string | undefined,
): Promise<ChunkResult> {
  // Rows refused for their id or slug are resolved after the pass with one
  // token read; their slot keeps the reported error order identical to the
  // row order.
  const outcomes: Array<BulkImportItemError | RefusedEntityRow> = [];
  let imported = 0;
  for (const { item: entity, params } of prepared) {
    if (run.stopped) break;
    const rowWriteAttempt = chunkWriteAttempt === undefined ? undefined : randomUUID();
    let result: QueryResult;
    try {
      result = await conn.executeQuery(
        query,
        { rows: [params], ...(rowWriteAttempt === undefined ? {} : { writeAttempt: rowWriteAttempt }) },
        { repositoryId },
      );
    } catch (rowErr) {
      if (isDeletedEntityFailure(rowErr)) {
        outcomes.push(
          await deletedNodeRowError(
            conn,
            repositoryId,
            `entity:${entity.id}`,
            `a node the row for entity "${entity.id}" touches`,
          ),
        );
        continue;
      }
      rethrowUnlessRowFailure(rowErr);
      const refusal = toTypedError(rowErr, {
        kind: 'entity',
        entityId: entity.id,
        slug: entity.slug,
        entityType: entity.entityType,
        label: entity.label,
        operation: 'importBulk',
      });
      if (
        rowWriteAttempt !== undefined &&
        (refusal instanceof DuplicateEntityError || refusal instanceof SlugConflictError)
      ) {
        outcomes.push({ entityId: entity.id, rowWriteAttempt, refusal });
        continue;
      }
      outcomes.push(refusedRow(`entity:${entity.id}`, refusal));
      continue;
    }
    assertEntityRowsWritten(result, repositoryId);
    imported++;
  }

  const refused = outcomes.filter(isRefusedEntityRow);
  // A concurrent delete of the entity between the refusal and the read-back
  // leaves no token to read, so the refusal stands.
  const stored =
    refused.length === 0
      ? new Map<string, string>()
      : await readEntityWriteAttempts(
          conn,
          repositoryId,
          refused.map((row) => row.entityId),
        );
  const errors: BulkImportItemError[] = [];
  for (const outcome of outcomes) {
    if (!isRefusedEntityRow(outcome)) {
      errors.push(outcome);
      continue;
    }
    const token = stored.get(outcome.entityId);
    if (token !== undefined && (token === outcome.rowWriteAttempt || token === chunkWriteAttempt)) {
      imported++;
      continue;
    }
    errors.push(refusedRow(`entity:${outcome.entityId}`, outcome.refusal));
  }
  return { imported, errors };
}

/** An insert-mode fallback row refused for its id or slug, awaiting its token read. */
interface RefusedEntityRow {
  entityId: string;
  rowWriteAttempt: string;
  refusal: DuplicateEntityError | SlugConflictError;
}

function isRefusedEntityRow(outcome: BulkImportItemError | RefusedEntityRow): outcome is RefusedEntityRow {
  return 'refusal' in outcome;
}

/**
 * The write token stored on each given id's entity, keyed by id. An id with
 * no entity, or whose entity carries no token, is absent from the map.
 */
async function readEntityWriteAttempts(
  conn: Neo4jConnection,
  repositoryId: string,
  entityIds: ReadonlyArray<string>,
): Promise<Map<string, string>> {
  let result: QueryResult;
  try {
    result = await conn.executeQuery(ENTITY_WRITE_ATTEMPTS_QUERY, { ids: [...new Set(entityIds)] }, { repositoryId });
  } catch (err) {
    mapDriverError(err, { operation: 'importBulk' });
  }
  const stored = new Map<string, string>();
  for (const record of result.records) {
    const id: unknown = record.get('id');
    const writeAttempt: unknown = record.get('writeAttempt');
    if (typeof id === 'string' && typeof writeAttempt === 'string') stored.set(id, writeAttempt);
  }
  return stored;
}

async function importRelationshipChunk(
  conn: Neo4jConnection,
  repositoryId: string,
  group: RelationshipChunk,
  skipCheck: boolean,
  run: ImportRun,
): Promise<ChunkResult> {
  if (group.rows.length === 0) return { imported: 0, errors: [] };

  // The relationship type is compiled into the Cypher, so a type the guard
  // refuses fails every row of its group: record each one and write none.
  let query: string;
  try {
    query = skipCheck
      ? buildInsertRelationshipsQuery(group.relationshipType)
      : buildUpsertRelationshipsQuery(group.relationshipType);
  } catch (err) {
    if (!(err instanceof DeepMemoryError)) throw err;
    return {
      imported: 0,
      errors: group.rows.map((rel) => refusedRow(`relationship:${rel.id}`, err)),
    };
  }

  // `repositoryId` is bound globally via the chokepoint's `$rid`; rows carry
  // only per-edge fields.
  const prepared = group.rows.map((rel) => ({ item: rel, params: relationshipToParams(rel) }));

  // The upsert statement's id check sees the store as it was before the
  // statement, so an upsert chunk that repeats an id is written in waves of
  // distinct ids: a repeat then meets the edge its first occurrence wrote,
  // exactly as it would in another chunk. Waves keep input order within the
  // chunk; chunks themselves complete in no defined order, but the marker
  // lock serialises them, so each meets the others' writes. Insert chunks
  // never repeat an id (`importBulk` refuses repeats up front) and are
  // written in one go.
  const waves = skipCheck ? [prepared] : wavesOfDistinctIds(prepared);
  // The insert template's write token: one per chunk statement, reused by
  // that chunk's per-row fallback. Reusing it is what keeps a row the chunk
  // statement already committed from being written a second time; it is safe
  // because insert chunks never repeat an id, so a row can only ever match
  // its own edge.
  const writeAttempt = skipCheck ? randomUUID() : undefined;
  let imported = 0;
  const errors: BulkImportItemError[] = [];
  for (const wave of waves) {
    if (run.stopped) break;
    let result: QueryResult;
    try {
      result = await conn.executeQuery(query, relationshipChunkParams(wave, writeAttempt), { repositoryId });
    } catch (err) {
      rethrowUnlessChunkCanFallBack(err);
      const fallback = await fallbackPerRelationship(conn, repositoryId, wave, query, writeAttempt, run);
      imported += fallback.imported;
      errors.push(...fallback.errors);
      continue;
    }
    const outcomes = relationshipRowOutcomes(result, wave, repositoryId);
    for (const { item: rel } of wave) {
      const rowFailure = relationshipRowFailure(rel, outcomes.get(rel.id));
      if (rowFailure === undefined) imported++;
      else errors.push(rowFailure);
    }
  }
  return { imported, errors };
}

async function fallbackPerRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  prepared: ReadonlyArray<PreparedRow<StoredRelationship>>,
  query: string,
  writeAttempt: string | undefined,
  run: ImportRun,
): Promise<ChunkResult> {
  const errors: BulkImportItemError[] = [];
  let imported = 0;
  for (const row of prepared) {
    if (run.stopped) break;
    const rel = row.item;
    let result: QueryResult;
    try {
      result = await conn.executeQuery(query, relationshipChunkParams([row], writeAttempt), { repositoryId });
    } catch (rowErr) {
      if (isDeletedEntityFailure(rowErr)) {
        errors.push(
          await deletedNodeRowError(
            conn,
            repositoryId,
            `relationship:${rel.id}`,
            `an endpoint (source=${rel.sourceEntityId}, target=${rel.targetEntityId})`,
          ),
        );
        continue;
      }
      rethrowUnlessRowFailure(rowErr);
      errors.push(
        rowError(`relationship:${rel.id}`, rowErr, {
          kind: 'relationship',
          relationshipId: rel.id,
        }),
      );
      continue;
    }
    const rowFailure = relationshipRowFailure(rel, relationshipRowOutcomes(result, [row], repositoryId).get(rel.id));
    if (rowFailure === undefined) imported++;
    else errors.push(rowFailure);
  }
  return { imported, errors };
}

/**
 * Params for a relationship template: the rows, plus the insert template's
 * write token (`writeAttempt`, set only for that template) or, for the
 * upsert template, which checks ids against the store, the rows' ids.
 */
function relationshipChunkParams(
  rows: ReadonlyArray<PreparedRow<StoredRelationship>>,
  writeAttempt: string | undefined,
): Record<string, unknown> {
  const params: Record<string, unknown> = { rows: rows.map((row) => row.params) };
  if (writeAttempt === undefined) params['ids'] = rows.map((row) => row.item.id);
  else params['writeAttempt'] = writeAttempt;
  return params;
}

/**
 * Split relationships into the first occurrence of each id, in input order,
 * and every later occurrence.
 */
function splitRepeatedIds(
  relationships: readonly StoredRelationship[],
): { first: StoredRelationship[]; repeats: StoredRelationship[] } {
  const seen = new Set<string>();
  const first: StoredRelationship[] = [];
  const repeats: StoredRelationship[] = [];
  for (const rel of relationships) {
    if (seen.has(rel.id)) {
      repeats.push(rel);
    } else {
      seen.add(rel.id);
      first.push(rel);
    }
  }
  return { first, repeats };
}

/**
 * Split rows into consecutive waves in which every id appears once,
 * preserving order. A chunk without repeated ids is a single wave.
 */
function wavesOfDistinctIds<T extends PreparedRow<StoredRelationship>>(rows: readonly T[]): T[][] {
  const waves: T[][] = [];
  const seenPerWave: Array<Set<string>> = [];
  for (const row of rows) {
    let index = seenPerWave.findIndex((seen) => !seen.has(row.item.id));
    if (index === -1) {
      index = waves.length;
      waves.push([]);
      seenPerWave.push(new Set());
    }
    waves[index]!.push(row);
    seenPerWave[index]!.add(row.item.id);
  }
  return waves;
}

type RelationshipRowOutcome = (typeof RELATIONSHIP_ROW_OUTCOME)[keyof typeof RELATIONSHIP_ROW_OUTCOME];

const RELATIONSHIP_ROW_OUTCOMES: ReadonlySet<string> = new Set(Object.values(RELATIONSHIP_ROW_OUTCOME));

function isRelationshipRowOutcome(value: unknown): value is RelationshipRowOutcome {
  return typeof value === 'string' && RELATIONSHIP_ROW_OUTCOMES.has(value);
}

/**
 * Each row's outcome from a relationship template, keyed by id (ids are
 * distinct within one statement). No rows at all for a non-empty statement
 * means the repository marker was missing; a row whose outcome is not one
 * the template emits is a fault below the data model.
 */
function relationshipRowOutcomes(
  result: QueryResult,
  rows: ReadonlyArray<PreparedRow<StoredRelationship>>,
  repositoryId: string,
): Map<string, RelationshipRowOutcome> {
  if (rows.length > 0 && result.records.length === 0) throw new RepositoryNotFoundError(repositoryId);
  const outcomes = new Map<string, RelationshipRowOutcome>();
  for (const record of result.records) {
    const id: unknown = record.get('id');
    const outcome: unknown = record.get('outcome');
    if (typeof id !== 'string' || !isRelationshipRowOutcome(outcome)) {
      throw new ProviderError(
        `Neo4j relationship import returned an unrecognised row ` +
          `(id ${JSON.stringify(id ?? null)}, outcome ${JSON.stringify(outcome ?? null)}).`,
      );
    }
    outcomes.set(id, outcome);
  }
  return outcomes;
}

/** The row error for a relationship row's outcome, or `undefined` when it was written. */
function relationshipRowFailure(
  rel: StoredRelationship,
  outcome: RelationshipRowOutcome | undefined,
): BulkImportItemError | undefined {
  switch (outcome) {
    case RELATIONSHIP_ROW_OUTCOME.written:
      return undefined;
    case RELATIONSHIP_ROW_OUTCOME.endpointMissing:
      return missingEndpointError(rel);
    case RELATIONSHIP_ROW_OUTCOME.idExists:
      return refusedRow(`relationship:${rel.id}`, new DuplicateRelationshipError(rel.id));
    case undefined:
      throw new ProviderError(`Neo4j relationship import returned no outcome for relationship "${rel.id}".`);
  }
}

/** Row record for a relationship whose source or target is not in the repository. */
function missingEndpointError(rel: StoredRelationship): BulkImportItemError {
  return {
    item: `relationship:${rel.id}`,
    error: `endpoint not found in repository (source=${rel.sourceEntityId}, target=${rel.targetEntityId})`,
    code: 'ENTITY_NOT_FOUND',
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────

function sliceIntoChunks<T>(items: T[], chunkSize: number): T[][] {
  if (items.length === 0) return [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    out.push(items.slice(i, i + chunkSize));
  }
  return out;
}

/**
 * Group relationships by their type, then slice each group into chunks of
 * `chunkSize`. Cypher 25 cannot parameterise the relationship-type slot, so
 * a single UNWIND chunk must hold rows of one type — the relationship-type
 * appears in the compiled Cypher string. Mixing types in one chunk would
 * mean one round-trip per type per chunk; the grouping turns that into one
 * round-trip per chunk.
 */
function groupRelationshipsByTypeIntoChunks(
  relationships: StoredRelationship[],
  chunkSize: number,
): RelationshipChunk[] {
  const grouped = new Map<string, StoredRelationship[]>();
  for (const rel of relationships) {
    const list = grouped.get(rel.relationshipType);
    if (list) list.push(rel);
    else grouped.set(rel.relationshipType, [rel]);
  }
  const out: RelationshipChunk[] = [];
  for (const [relationshipType, rows] of grouped) {
    for (let i = 0; i < rows.length; i += chunkSize) {
      out.push({ relationshipType, rows: rows.slice(i, i + chunkSize) });
    }
  }
  return out;
}

/**
 * Hand-rolled bounded-parallelism helper — equivalent to `p-limit`'s
 * `Promise.all` over a worker pool, without the dependency. Items run in
 * order but complete in whatever order the server returns them; the result
 * array preserves the input order so callers can pair results with inputs.
 *
 * Concurrency is the maximum number of in-flight tasks at any point. With
 * concurrency 1 this degenerates to sequential execution. The first error
 * thrown by `fn` stops dispatch of further items; tasks already in flight
 * are awaited (so nothing keeps writing after the call settles) and the
 * returned promise then rejects with that first error. The caller is
 * responsible for catching within `fn` if partial success is desired.
 */
export async function runBounded<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (concurrency < 1) {
    throw new ProviderError(`runBounded: concurrency must be >= 1 (got ${concurrency}).`);
  }
  const cap = Math.min(concurrency, items.length);
  const results: R[] = new Array(items.length);
  let nextIndex = 0;
  let failure: { error: unknown } | undefined;
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < cap; w++) {
    workers.push(
      (async (): Promise<void> => {
        while (failure === undefined) {
          const i = nextIndex++;
          if (i >= items.length) return;
          try {
            results[i] = await fn(items[i]!);
          } catch (err) {
            failure ??= { error: err };
          }
        }
      })(),
    );
  }
  await Promise.all(workers);
  if (failure !== undefined) throw failure.error;
  return results;
}

// `bigintToSafeNumber` is re-exported indirectly via the mapping module; this
// module only needs it through its callers. The import keeps the dependency
// graph explicit for the unit test that grep-checks against `driver.session`.
export { bigintToSafeNumber };
