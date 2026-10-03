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
//     is four entries total (entity CREATE, entity MERGE, relationship CREATE,
//     relationship MERGE) across every import in the system.
//   - `skipExistenceCheck: true` uses the CREATE branch. A duplicate row
//     causes the whole chunk to fail with
//     `Neo.ClientError.Schema.ConstraintValidationFailed`; the import falls
//     back to a per-row CREATE for that chunk so good rows still land. The
//     downside is one extra round-trip per failed-chunk; the upside is that
//     the success path is one round-trip per chunk regardless of chunk size.
//     Only row-shaped failures take the fallback; a timeout or connection
//     failure stops the import with its typed error.
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
//   - Bounded parallelism via `runBounded` — a hand-rolled minimal pool with
//     default concurrency 8. Neo4j Community has no throttle signal; the
//     adaptive-concurrency controller the Cosmos provider needs has no
//     analog. Chunks complete independently; their results aggregate into a
//     single `BulkImportResult` at the end. Per-row errors are collected per
//     chunk, never swallowed. The first chunk that rejects stops dispatch.

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
} from '../mapping.js';
import { DeepMemoryError, ProviderError } from '@utaba/deep-memory';
import {
  isMemoryLimitFailure,
  isRowShapedFailure,
  isTransactionMemoryLimit,
  mapDriverError,
  toTypedError,
  type DriverErrorContext,
} from '../errors.js';

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
 */
const INSERT_ENTITIES_QUERY = `
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
  n.modifiedFromMessage = row.modifiedFromMessage
SET n += row.userProperties
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
 */
const UPSERT_ENTITIES_QUERY = `
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
`;

/**
 * Build the relationship import Cypher for a given relationship type. Cypher
 * 25 cannot parameterise the relationship-type slot, so each distinct type
 * compiles to its own plan-cache entry. The vocabulary bounds the per-type
 * cardinality (the same trade-off `createRelationship` makes).
 *
 * `MATCH (s)` and `MATCH (t)` find the endpoint entities under the repository
 * scope before the edge is created; an endpoint outside the repository fails
 * the match and the row is silently skipped. The skipped row is then surfaced
 * to the caller via the row-count comparison in `importRelationshipChunk` so
 * the import result still reports the missing-endpoint condition.
 */
function buildInsertRelationshipsQuery(relationshipType: string): string {
  const safe = assertSafeRelationshipType(relationshipType);
  return `
UNWIND $rows AS row
MATCH (s:_Entity {repositoryId: $rid, id: row.sourceEntityId})
MATCH (t:_Entity {repositoryId: $rid, id: row.targetEntityId})
CREATE (s)-[r:${safe} {
  repositoryId: $rid,
  id: row.id,
  relationshipType: row.relationshipType,
  sourceEntityId: row.sourceEntityId,
  targetEntityId: row.targetEntityId,
  properties: row.properties,
  bidirectional: row.bidirectional,
  createdBy: row.createdBy,
  createdByType: row.createdByType,
  createdAt: row.createdAt,
  createdInConversation: row.createdInConversation,
  createdFromMessage: row.createdFromMessage,
  modifiedBy: row.modifiedBy,
  modifiedByType: row.modifiedByType,
  modifiedAt: row.modifiedAt,
  modifiedInConversation: row.modifiedInConversation,
  modifiedFromMessage: row.modifiedFromMessage
}]->(t)
RETURN row.id AS id
`;
}

function buildUpsertRelationshipsQuery(relationshipType: string): string {
  const safe = assertSafeRelationshipType(relationshipType);
  return `
UNWIND $rows AS row
MATCH (s:_Entity {repositoryId: $rid, id: row.sourceEntityId})
MATCH (t:_Entity {repositoryId: $rid, id: row.targetEntityId})
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
RETURN row.id AS id
`;
}

// ─── Import — public entry ───────────────────────────────────────────

/**
 * Run a bulk import. Returns a single aggregate result spanning every chunk
 * and every entity / relationship row across the entire input.
 *
 * Concurrency: chunks within a phase (entities or relationships) run through
 * a bounded pool. Entities are imported strictly before relationships across
 * the whole input — relationship MATCH on the source/target entities requires
 * those entities to exist, so cross-phase parallelism is not safe.
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

  const relationshipChunks = groupRelationshipsByTypeIntoChunks(allRelationships, chunkSize);
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
 * writing the rows one at a time can help — a row-shaped failure, or the
 * chunk running out of transaction memory (a single row needs far less).
 */
function rethrowUnlessChunkCanFallBack(error: unknown): void {
  if (!isRowShapedFailure(error) && !isMemoryLimitFailure(error)) {
    mapDriverError(error, { operation: 'importBulk' });
  }
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

  try {
    await conn.executeQuery(query, { rows: prepared.map((row) => row.params) }, { repositoryId });
    return { imported: prepared.length, errors };
  } catch (err) {
    rethrowUnlessChunkCanFallBack(err);
    const fallback = await fallbackPerEntity(conn, repositoryId, prepared, query, run);
    return { imported: fallback.imported, errors: [...errors, ...fallback.errors] };
  }
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
 * failure in a sibling chunk (the fallback stops at its next row).
 */
async function fallbackPerEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  prepared: ReadonlyArray<PreparedRow<StoredEntity>>,
  query: string,
  run: ImportRun,
): Promise<ChunkResult> {
  const errors: BulkImportItemError[] = [];
  let imported = 0;
  for (const { item: entity, params } of prepared) {
    if (run.stopped) break;
    try {
      await conn.executeQuery(query, { rows: [params] }, { repositoryId });
      imported++;
    } catch (rowErr) {
      rethrowUnlessRowFailure(rowErr);
      errors.push(
        rowError(`entity:${entity.id}`, rowErr, {
          kind: 'entity',
          entityId: entity.id,
          slug: entity.slug,
          entityType: entity.entityType,
          label: entity.label,
        }),
      );
    }
  }
  return { imported, errors };
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

  try {
    const result = await conn.executeQuery(query, { rows: prepared.map((row) => row.params) }, { repositoryId });
    const importedIds = new Set<string>();
    for (const record of result.records) {
      const id = record.get('id');
      if (typeof id === 'string') importedIds.add(id);
    }
    const errors: BulkImportItemError[] = [];
    for (const rel of group.rows) {
      if (!importedIds.has(rel.id)) errors.push(missingEndpointError(rel));
    }
    return { imported: importedIds.size, errors };
  } catch (err) {
    rethrowUnlessChunkCanFallBack(err);
    return fallbackPerRelationship(conn, repositoryId, prepared, query, run);
  }
}

async function fallbackPerRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  prepared: ReadonlyArray<PreparedRow<StoredRelationship>>,
  query: string,
  run: ImportRun,
): Promise<ChunkResult> {
  const errors: BulkImportItemError[] = [];
  let imported = 0;
  for (const { item: rel, params } of prepared) {
    if (run.stopped) break;
    try {
      const result = await conn.executeQuery(query, { rows: [params] }, { repositoryId });
      if (result.records.length === 1) {
        imported++;
      } else {
        errors.push(missingEndpointError(rel));
      }
    } catch (rowErr) {
      rethrowUnlessRowFailure(rowErr);
      errors.push(
        rowError(`relationship:${rel.id}`, rowErr, {
          kind: 'relationship',
          relationshipId: rel.id,
        }),
      );
    }
  }
  return { imported, errors };
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
