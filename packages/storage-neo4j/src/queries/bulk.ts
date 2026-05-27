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
//     chunk, never swallowed.

import type {
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
import { ProviderError } from '@utaba/deep-memory';

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
 * cardinality (same trade-off as `createRelationship` in Phase 7).
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
 * Error policy: a chunk-level failure (e.g. one duplicate row in a CREATE
 * chunk under `skipExistenceCheck: true`) falls back to per-row CREATE so
 * the surviving rows still land. Per-row errors land in `result.errors`;
 * successful rows count toward `entitiesImported` / `relationshipsImported`.
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

  const errors: Array<{ item: string; error: string }> = [];

  // Entity phase. Slice the flat list into UNWIND chunks; submit through the
  // bounded pool. The pool size is fixed (no adaptive controller — Neo4j has
  // no throttle signal to learn from).
  const entityChunks = sliceIntoChunks(allEntities, chunkSize);
  const entityResults = await runBounded(
    entityChunks,
    concurrency,
    (chunk) => importEntityChunk(conn, repositoryId, chunk, skipCheck),
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
    (group) => importRelationshipChunk(conn, repositoryId, group, skipCheck),
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
  errors: Array<{ item: string; error: string }>;
}

interface RelationshipChunk {
  relationshipType: string;
  rows: StoredRelationship[];
}

async function importEntityChunk(
  conn: Neo4jConnection,
  repositoryId: string,
  entities: StoredEntity[],
  skipCheck: boolean,
): Promise<ChunkResult> {
  if (entities.length === 0) return { imported: 0, errors: [] };

  // `repositoryId` is bound globally via the chokepoint's `$rid`; the row
  // map only carries per-entity fields. Keeping it off the row keeps the
  // Bolt payload smaller on large chunks.
  const rows = entities.map((entity) => ({
    ...entityToParams(entity),
    userProperties: entityUserPropertyParams(entity.properties),
  }));
  const query = skipCheck ? INSERT_ENTITIES_QUERY : UPSERT_ENTITIES_QUERY;

  try {
    await conn.executeQuery(query, { rows }, { repositoryId });
    return { imported: entities.length, errors: [] };
  } catch (err) {
    return fallbackPerEntity(conn, repositoryId, entities, skipCheck, err);
  }
}

/**
 * When a whole-chunk write fails (e.g. one constraint violation aborts the
 * entire MERGE/CREATE transaction), retry the chunk row-by-row so the rows
 * that would have succeeded still land. The per-row path is slower per call
 * but only runs when a chunk actually failed.
 */
async function fallbackPerEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entities: StoredEntity[],
  skipCheck: boolean,
  chunkError: unknown,
): Promise<ChunkResult> {
  const errors: Array<{ item: string; error: string }> = [];
  let imported = 0;
  const query = skipCheck ? INSERT_ENTITIES_QUERY : UPSERT_ENTITIES_QUERY;
  for (const entity of entities) {
    try {
      const rows = [
        {
          ...entityToParams(entity),
          userProperties: entityUserPropertyParams(entity.properties),
        },
      ];
      await conn.executeQuery(query, { rows }, { repositoryId });
      imported++;
    } catch (rowErr) {
      errors.push({
        item: `entity:${entity.id}`,
        error: rowErr instanceof Error ? rowErr.message : String(rowErr),
      });
    }
  }
  // If we successfully fell back and at least one row failed AND no errors
  // were collected, attach the original chunk error so the caller still gets
  // a signal. Otherwise the per-row errors are the actionable surface.
  if (errors.length === 0 && imported < entities.length) {
    errors.push({
      item: `entity-chunk`,
      error: chunkError instanceof Error ? chunkError.message : String(chunkError),
    });
  }
  return { imported, errors };
}

async function importRelationshipChunk(
  conn: Neo4jConnection,
  repositoryId: string,
  group: RelationshipChunk,
  skipCheck: boolean,
): Promise<ChunkResult> {
  if (group.rows.length === 0) return { imported: 0, errors: [] };

  // `repositoryId` is bound globally via the chokepoint's `$rid`; rows carry
  // only per-edge fields.
  const rows = group.rows.map((rel) => relationshipToParams(rel));
  const query = skipCheck
    ? buildInsertRelationshipsQuery(group.relationshipType)
    : buildUpsertRelationshipsQuery(group.relationshipType);

  try {
    const result = await conn.executeQuery(query, { rows }, { repositoryId });
    const importedIds = new Set<string>();
    for (const record of result.records) {
      const id = record.get('id');
      if (typeof id === 'string') importedIds.add(id);
    }
    const errors: Array<{ item: string; error: string }> = [];
    for (const rel of group.rows) {
      if (!importedIds.has(rel.id)) {
        errors.push({
          item: `relationship:${rel.id}`,
          error: `endpoint not found in repository (source=${rel.sourceEntityId}, target=${rel.targetEntityId})`,
        });
      }
    }
    return { imported: importedIds.size, errors };
  } catch (err) {
    return fallbackPerRelationship(conn, repositoryId, group, skipCheck, err);
  }
}

async function fallbackPerRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  group: RelationshipChunk,
  skipCheck: boolean,
  chunkError: unknown,
): Promise<ChunkResult> {
  const errors: Array<{ item: string; error: string }> = [];
  let imported = 0;
  const query = skipCheck
    ? buildInsertRelationshipsQuery(group.relationshipType)
    : buildUpsertRelationshipsQuery(group.relationshipType);
  for (const rel of group.rows) {
    try {
      const rows = [relationshipToParams(rel)];
      const result = await conn.executeQuery(query, { rows }, { repositoryId });
      if (result.records.length === 1) {
        imported++;
      } else {
        errors.push({
          item: `relationship:${rel.id}`,
          error: `endpoint not found in repository (source=${rel.sourceEntityId}, target=${rel.targetEntityId})`,
        });
      }
    } catch (rowErr) {
      errors.push({
        item: `relationship:${rel.id}`,
        error: rowErr instanceof Error ? rowErr.message : String(rowErr),
      });
    }
  }
  if (errors.length === 0 && imported < group.rows.length) {
    errors.push({
      item: `relationship-chunk:${group.relationshipType}`,
      error: chunkError instanceof Error ? chunkError.message : String(chunkError),
    });
  }
  return { imported, errors };
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
 * concurrency 1 this degenerates to sequential execution. Errors thrown by
 * `fn` reject the returned promise; the caller is responsible for catching
 * within `fn` if partial success is desired.
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
  const workers: Array<Promise<void>> = [];
  for (let w = 0; w < cap; w++) {
    workers.push(
      (async (): Promise<void> => {
        while (true) {
          const i = nextIndex++;
          if (i >= items.length) return;
          results[i] = await fn(items[i]!);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

// `bigintToSafeNumber` is re-exported indirectly via the mapping module; this
// module only needs it through its callers. The import keeps the dependency
// graph explicit for the unit test that grep-checks against `driver.session`.
export { bigintToSafeNumber };
