// Bulk export/import Gremlin queries — optimized for throughput
//
// Import optimizations:
//   1. Parallel execution with concurrency limiter (avoids sequential round-trips)
//   2. Direct addV/addE when skipExistenceCheck is true (no existence query needed)
//   3. Gremlin coalesce pattern for atomic upserts when existence checks are needed
//      (1 query instead of 2)
//
// Export optimizations:
//   1. Cursor-based pagination using ID ordering instead of offset-based range()
//      (avoids O(n²) scan on large repositories)
//
// `valueMap(true)` exception: this is the one read path that intentionally
// keeps it. Export must include every stored property — including the
// embedding — so a re-import is field-for-field faithful. Do not migrate to
// the project-chain helpers used elsewhere; they strip fields the import path
// expects.

import {
  cosmosStatusCode,
  isTransientError,
  type CosmosDbConnection,
  type GremlinResult,
} from '../CosmosDbConnection.js';
import type { ExportChunk, ImportChunk, BulkImportOptions } from '@utaba/deep-memory/types';
import type {
  BulkImportItemError,
  BulkImportResult,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import { DeepMemoryError, DuplicateRelationshipError, ProviderError } from '@utaba/deep-memory';
import type { DeepMemoryErrorCode } from '@utaba/deep-memory';
import {
  buildEntityPropertyLadder,
  buildRelationshipPropertyLadder,
  entityFromGremlin,
  entityToLadderBindings,
  entityUserPropertyParams,
  relationshipFromGremlin,
  relationshipToLadderBindings,
  relationshipUserPropertyParams,
} from '../mapping.js';
import { resolveController, runAdaptive } from './adaptive-import.js';
import { assertRepositoryMarker } from './marker.js';

const EXPORT_BATCH_SIZE = 100;

// ─── Export ──────────────────────────────────────────────────────

/**
 * Stream every entity, then every relationship. The repository marker is
 * read (a partition-scoped point read) before the first page, so a deleted
 * repository is refused on the first iteration. A delete that starts while
 * the export runs is not detected: later pages return what its drain has not
 * removed yet.
 *
 * @throws RepositoryNotFoundError on the first iteration when the marker is absent.
 */
export async function* exportAll(
  conn: CosmosDbConnection,
  repositoryId: string,
): AsyncIterable<ExportChunk> {
  await assertRepositoryMarker(conn, repositoryId);
  let sequence = 0;

  // Export entities using cursor-based pagination (ordered by id)
  let cursor = '';
  while (true) {
    const result = cursor === ''
      ? await conn.submit(
          "g.V().has('repositoryId', rid).has('entityType').order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, batchSize: EXPORT_BATCH_SIZE },
        )
      : await conn.submit(
          "g.V().has('repositoryId', rid).has('entityType').has('id', gt(cursor)).order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, cursor, batchSize: EXPORT_BATCH_SIZE },
        );

    const entities = (result.items as Record<string, unknown>[]).map(entityFromGremlin);
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

  // Export relationships using cursor-based pagination (ordered by id)
  cursor = '';
  while (true) {
    const result = cursor === ''
      ? await conn.submit(
          "g.E().has('repositoryId', rid).order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, batchSize: EXPORT_BATCH_SIZE },
        )
      : await conn.submit(
          "g.E().has('repositoryId', rid).has('id', gt(cursor)).order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, cursor, batchSize: EXPORT_BATCH_SIZE },
        );

    const relationships = (result.items as Record<string, unknown>[]).map(relationshipFromGremlin);
    const isLast = relationships.length < EXPORT_BATCH_SIZE;

    if (relationships.length > 0) {
      cursor = relationships[relationships.length - 1]!.id;
      yield {
        type: 'relationships',
        data: relationships,
        sequence: sequence++,
        isLast,
      };
    }

    if (isLast) break;
  }

  // If nothing was yielded, yield an empty final chunk
  if (sequence === 0) {
    yield {
      type: 'entities',
      data: [],
      sequence: 0,
      isLast: true,
    };
  }
}

// ─── Import ─────────────────────────────────────────────────────

/**
 * Import entities, then relationships, one write per row through the
 * adaptive pool.
 *
 * Relationship ids:
 * - `skipExistenceCheck: true` (insert) writes each edge without looking for
 *   its id. A repository's vertices and edges share its partition, where ids
 *   are unique, so an id already stored — or repeated within the call — is
 *   refused by the store with a 409 and recorded as
 *   `RELATIONSHIP_ALREADY_EXISTS`.
 * - `skipExistenceCheck: false` (upsert) updates an existing edge in place
 *   when it has the row's id, type and endpoints. An id held by an edge of
 *   another type or between other endpoints (or by a vertex) is refused with
 *   `RELATIONSHIP_ALREADY_EXISTS` and nothing is written, so the stored
 *   `relationshipType`, `sourceEntityId` and `targetEntityId` always agree
 *   with the edge's label and endpoints. The endpoints are checked first: a
 *   row with a missing endpoint reports `ENTITY_NOT_FOUND` even when its id
 *   is in use. A row refused with a 409 is submitted once more, so an id
 *   repeated within the call with the same type and endpoints updates the
 *   edge its first occurrence wrote rather than being refused.
 *
 * Error policy:
 * - A row that fails because of its own contents — a property the mapping
 *   refuses, a write the server rejects for that document (see
 *   `isRowShapedSubmitFailure`), or a relationship whose endpoint is not in
 *   the repository — lands in `result.errors` with a `code` and the import
 *   carries on.
 * - Throttling or unavailability that outlived the connection's retries is
 *   rethrown unchanged: the adaptive pool counts it as a throttle and runs
 *   the row again, and its circuit breaker (`ImportThrottleAbortError`) is
 *   the only stop for sustained throttling.
 * - Any other failure means the store itself is failing (a lost connection,
 *   a missing database or container): recording it against every remaining
 *   row would hide the cause and keep loading a failing store, so the import
 *   stops dispatching rows and rejects with a ProviderError. Rows written
 *   before that point stay written.
 *
 * Deleted repositories: before each chunk (and once for an empty list) a
 * partition-scoped point read checks the repository marker and throws
 * `RepositoryNotFoundError` when it is gone, so a repository deleted before
 * the call writes nothing. The row writes themselves are not gated on the
 * marker, and Cosmos Gremlin has no transaction across requests: when a
 * `deleteRepository` drops the marker while a chunk is being written, that
 * chunk's remaining rows still land (the next chunk is refused), and rows
 * written after the delete's drain has passed them stay behind until
 * `deleteRepository` runs again.
 */
export async function importBulk(
  conn: CosmosDbConnection,
  repositoryId: string,
  data: ImportChunk[],
  options?: BulkImportOptions,
): Promise<BulkImportResult> {
  let entitiesImported = 0;
  let relationshipsImported = 0;
  const errors: BulkImportItemError[] = [];
  const skipCheck = options?.skipExistenceCheck ?? false;

  // Resolve the controller from the caller-supplied handle if any, so the
  // controller's learned state (concurrency level, success streak, cooldown,
  // soft ceiling) carries across multiple importBulk calls within a single
  // import operation. Without a handle, each importBulk call gets a fresh
  // controller — fine for single-shot usage but wrong for streaming imports
  // that issue one importBulk call per chunk. RepositoryImporter creates a
  // handle per import and threads it through automatically.
  const controller = resolveController(options?.adaptiveConcurrency, options?.adaptiveConcurrencyHandle);

  if (data.length === 0) await assertRepositoryMarker(conn, repositoryId);
  for (const chunk of data) {
    await assertRepositoryMarker(conn, repositoryId);
    if (chunk.entities && chunk.entities.length > 0) {
      const results = await runAdaptive(
        chunk.entities,
        controller,
        (entity) =>
          writeRow(conn, {
            item: `entity:${entity.id}`,
            conflictCode: 'ENTITY_ALREADY_EXISTS',
            buildStatement: () =>
              skipCheck
                ? insertEntityStatement(repositoryId, entity)
                : upsertEntityStatement(repositoryId, entity),
          }),
      );

      for (const failure of results) {
        if (failure === undefined) {
          entitiesImported++;
        } else {
          errors.push(failure);
        }
      }
    }

    if (chunk.relationships && chunk.relationships.length > 0) {
      const results = await runAdaptive(
        chunk.relationships,
        controller,
        (rel) =>
          writeRow(conn, {
            item: `relationship:${rel.id}`,
            conflictCode: 'RELATIONSHIP_ALREADY_EXISTS',
            conflictMessage: new DuplicateRelationshipError(rel.id).message,
            buildStatement: () =>
              skipCheck
                ? insertRelationshipStatement(repositoryId, rel)
                : upsertRelationshipStatement(repositoryId, rel),
            resubmitOnConflict: !skipCheck,
            // Both statements start from the source vertex and attach to the
            // target vertex; when either is missing they match nothing, write
            // nothing and return no rows.
            onEmptyResult: () => ({
              item: `relationship:${rel.id}`,
              error: `endpoint not found in repository (source=${rel.sourceEntityId}, target=${rel.targetEntityId})`,
              code: 'ENTITY_NOT_FOUND',
            }),
          }),
      );

      for (const failure of results) {
        if (failure === undefined) {
          relationshipsImported++;
        } else {
          errors.push(failure);
        }
      }
    }
  }

  return { entitiesImported, relationshipsImported, errors };
}

/** A fixed-shape Gremlin statement and its bindings, ready to submit. */
interface GremlinStatement {
  query: string;
  bindings: Record<string, unknown>;
}

/**
 * Cosmos status codes that report a problem with the one document a write
 * touched rather than with the store: 400 (the server refused a value), 409
 * (the id already exists), 413 (the document is too large). A 404 is not
 * among them: on a write it means the database or container is gone.
 */
const ROW_SHAPED_STATUS_CODES: ReadonlySet<number> = new Set([400, 409, 413]);

/** True when a failed submit was caused by the row it carried. */
export function isRowShapedSubmitFailure(err: unknown): boolean {
  const status = cosmosStatusCode(err);
  return status !== undefined && ROW_SHAPED_STATUS_CODES.has(status);
}

interface RowWrite {
  /** The row, as recorded in `result.errors` (`entity:<id>` / `relationship:<id>`). */
  item: string;
  /** Code for a 409: the row's id is already taken. */
  conflictCode: DeepMemoryErrorCode;
  /**
   * Message for a 409, in place of the store's own wording, so the row error
   * reads the same as the other providers report it.
   */
  conflictMessage?: string;
  /**
   * Submit the statement once more after a 409. An upsert's update branch
   * only sees an edge that existed when its request ran, so a row whose id
   * another row of the same import created a moment earlier takes the
   * create branch and is refused; the second submit finds that edge and
   * updates it when it is the same edge, and is refused again when it is not.
   */
  resubmitOnConflict?: boolean;
  buildStatement: () => GremlinStatement;
  /** The row's error when the statement succeeds but returns nothing. */
  onEmptyResult?: () => BulkImportItemError;
}

/**
 * Write one row. Resolves to `undefined` on success or to the row's error
 * record for a row-shaped failure. Rethrows a transient error unchanged (the
 * adaptive pool runs the row again) and rejects with a ProviderError when
 * the store itself fails.
 */
async function writeRow(conn: CosmosDbConnection, row: RowWrite): Promise<BulkImportItemError | undefined> {
  const { item } = row;
  let statement: GremlinStatement;
  try {
    statement = row.buildStatement();
  } catch (err: unknown) {
    // The mapping refused one of this row's properties before any round-trip.
    if (!(err instanceof DeepMemoryError)) throw err;
    return { item, error: err.message, code: err.code };
  }

  let result: GremlinResult | undefined;
  for (let attempt = 1; result === undefined; attempt++) {
    try {
      result = await conn.submit(statement.query, statement.bindings);
    } catch (err: unknown) {
      if (err instanceof DeepMemoryError || isTransientError(err)) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (isRowShapedSubmitFailure(err)) {
        const conflict = cosmosStatusCode(err) === 409;
        if (conflict && row.resubmitOnConflict === true && attempt === 1) continue;
        if (conflict) return { item, error: row.conflictMessage ?? message, code: row.conflictCode };
        return { item, error: message, code: 'PROVIDER_ERROR' };
      }
      throw new ProviderError(
        `CosmosDB import stopped at ${item}: ${message}`,
        'The store failed rather than this row; rows written before it remain. Check the CosmosDB account, database and container are reachable, then re-run the import (an upsert import is idempotent).',
        { cause: err },
      );
    }
  }
  if (result.items.length === 0 && row.onEmptyResult !== undefined) return row.onEmptyResult();
  return undefined;
}

// ─── Fixed-shape query templates ─────────────────────────────────
//
// Same Gremlin string across every entity/relationship write regardless of
// which optional fields are populated, so the Cosmos plan cache reuses one
// compiled plan. Computed once at module load. The upsert update branch
// reuses the SAME ladder as the create branch — Cosmos already rejects
// `.property('repositoryId', ...)` after `unfold()`, and the ladder excludes
// `id` and `repositoryId` (both written explicitly only on the create branch).

const ENTITY_LADDER_CHAIN = buildEntityPropertyLadder();
const RELATIONSHIP_LADDER_CHAIN = buildRelationshipPropertyLadder();

const INSERT_ENTITY_QUERY =
  `g.addV(vertexLabel).property('id', vid).property('repositoryId', rid)${ENTITY_LADDER_CHAIN}`;

const INSERT_RELATIONSHIP_QUERY =
  `g.V().has('repositoryId', rid).hasId(srcId).has('entityType')` +
  `.addE(edgeLabel)` +
  `.to(g.V().has('repositoryId', rid).hasId(tgtId).has('entityType'))` +
  `.property('id', relId).property('repositoryId', rid)${RELATIONSHIP_LADDER_CHAIN}`;

// Upsert query is split into the open / branch-separator / close fragments so
// the per-call user-property suffix can append to BOTH branches of the
// coalesce. When the caller has no native-storable user properties, the empty
// suffix collapses each per-call query to the canonical fixed string below
// (byte-identical to the historical shape), keeping the dominant plan-cache
// entry warm.

const UPSERT_ENTITY_OPEN =
  `g.V().has('repositoryId', rid).hasId(vid).has('entityType').fold().coalesce(` +
  `unfold()${ENTITY_LADDER_CHAIN}`;

const UPSERT_ENTITY_CREATE_BRANCH =
  `, addV(vertexLabel).property('id', vid).property('repositoryId', rid)${ENTITY_LADDER_CHAIN}`;

const UPSERT_ENTITY_QUERY =
  `${UPSERT_ENTITY_OPEN}${UPSERT_ENTITY_CREATE_BRANCH})`;

// The relationship upsert fetches both endpoints in its first, index-backed
// step, labels the target `t` and continues from the source. The update
// branch matches only the edge the row describes: the row's id, leaving the
// source with the row's label and arriving at the row's target. An id held
// by anything else (an edge of another type or between other endpoints, or
// a vertex) fails that branch, and the create branch's `addE` is refused by
// the store with a 409, because a repository's vertices and edges share its
// partition and the id is unique there. So the update never rewrites
// `relationshipType`, `sourceEntityId` or `targetEntityId` to values that
// contradict the edge's label and endpoints. A missing endpoint leaves no
// traverser and the statement returns no rows.
const UPSERT_RELATIONSHIP_OPEN =
  `g.V().has('repositoryId', rid).hasId(within(srcId, tgtId)).has('entityType').fold().as('vs')` +
  `.unfold().hasId(tgtId).as('t')` +
  `.select('vs').unfold().hasId(srcId)` +
  `.coalesce(__.outE(edgeLabel).hasId(relId).where(__.inV().hasId(tgtId))${RELATIONSHIP_LADDER_CHAIN}`;

const UPSERT_RELATIONSHIP_CREATE_BRANCH =
  `, __.addE(edgeLabel).to('t')` +
  `.property('id', relId).property('repositoryId', rid)${RELATIONSHIP_LADDER_CHAIN}`;

const UPSERT_RELATIONSHIP_QUERY =
  `${UPSERT_RELATIONSHIP_OPEN}${UPSERT_RELATIONSHIP_CREATE_BRANCH})`;

// ─── Direct insert (no existence check) ─────────────────────────

/**
 * Build the statement that inserts an entity directly — assumes it does not exist.
 *
 * User-property dual-write contract: native-storable values in
 * `entity.properties` also project to per-key vertex properties so server-
 * side predicates and aggregations can reach them. The suffix appends to
 * the fixed `addV(...)` ladder with `p_user_<i>` bindings beside the
 * existing ladder bindings. Validation (reserved-name collisions, unsafe
 * identifiers) runs synchronously via `entityUserPropertyParams` before
 * any round-trip — the contract matches the `createEntity` and
 * `upsertEntity` write paths so every dual-write entry point produces the
 * same scalar shape. When the caller's properties contain no native-
 * storable values, the empty suffix collapses the query to the canonical
 * fixed `INSERT_ENTITY_QUERY` string (byte-identical to the historical
 * shape), keeping the dominant plan-cache entry warm.
 */
function insertEntityStatement(
  repositoryId: string,
  entity: StoredEntity,
): GremlinStatement {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    vid: entity.id,
    vertexLabel: entity.entityType,
    ...entityToLadderBindings(entity),
  };

  const userProps = entityUserPropertyParams(entity.properties ?? {});
  let query: string;
  if (userProps.length === 0) {
    query = INSERT_ENTITY_QUERY;
  } else {
    let suffix = '';
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      suffix += `.property('${key}', p_user_${i})`;
      bindings[`p_user_${i}`] = value;
    }
    query = `${INSERT_ENTITY_QUERY}${suffix}`;
  }

  return { query, bindings };
}

/**
 * Build the statement that inserts a relationship directly — assumes it does not exist.
 *
 * User-property dual-write contract: same shape as `insertEntity` above —
 * native-storable values in `relationship.properties` project to per-key
 * edge properties via a suffix appended to the fixed `addE(...)` ladder.
 * The relationship reserved set additionally guards against the Gremlin
 * `'label'` token, which would collide with the edge-label slot set at
 * `addE(edgeLabel)`. Empty-properties insert hits the byte-identical
 * fixed `INSERT_RELATIONSHIP_QUERY` string.
 */
function insertRelationshipStatement(
  repositoryId: string,
  rel: StoredRelationship,
): GremlinStatement {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    relId: rel.id,
    srcId: rel.sourceEntityId,
    tgtId: rel.targetEntityId,
    edgeLabel: rel.relationshipType,
    ...relationshipToLadderBindings(rel),
  };

  const userProps = relationshipUserPropertyParams(rel.properties ?? {});
  let query: string;
  if (userProps.length === 0) {
    query = INSERT_RELATIONSHIP_QUERY;
  } else {
    let suffix = '';
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      suffix += `.property('${key}', p_user_${i})`;
      bindings[`p_user_${i}`] = value;
    }
    query = `${INSERT_RELATIONSHIP_QUERY}${suffix}`;
  }

  return { query, bindings };
}

// ─── Atomic upsert (single query with coalesce) ─────────────────

/**
 * Build the statement that upserts an entity using Gremlin's coalesce pattern — single query.
 * Replaces the old 2-query check-then-create/update approach.
 *
 * Both branches share the same fixed-shape entity ladder (which omits `id`
 * and `repositoryId`). The create branch prepends `.property('id',
 * vid).property('repositoryId', rid)` to addV; the update branch (after
 * `unfold`) relies on those system properties already being set. Cosmos
 * rejects `.property('repositoryId', ...)` after `unfold()` at parse time,
 * so excluding `repositoryId` from the ladder is required for correctness
 * as well as plan-cache shape.
 *
 * User-property dual-write contract: native-storable values in
 * `entity.properties` also project to per-key vertex properties so server-
 * side predicates and aggregations can reach them. The suffix appends to
 * BOTH coalesce branches so a brand-new entity (create branch) and a pre-
 * existing one (update branch) end up with the same scalar shape; the
 * `p_user_<i>` bindings are shared across the two halves. Validation
 * (reserved-name collisions, unsafe identifiers) runs synchronously via
 * `entityUserPropertyParams` before any round-trip — the contract matches
 * the per-entity `createEntity` write path. Bulk import does NOT pre-read
 * the existing entity, so the update branch ADDS and OVERWRITES scalars
 * but does NOT DROP stale ones: keys present on the pre-existing entity
 * and absent from the new payload stay as orphan scalars. The canonical
 * JSON `properties` blob (the ladder slot) stays the read-side source of
 * truth, so round-trip is unaffected by that asymmetry. Callers needing
 * exact drop-on-omit semantics from a bulk path should fall back to
 * per-entity `updateEntity` instead.
 */
function upsertEntityStatement(
  repositoryId: string,
  entity: StoredEntity,
): GremlinStatement {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    vid: entity.id,
    vertexLabel: entity.entityType,
    ...entityToLadderBindings(entity),
  };

  const userProps = entityUserPropertyParams(entity.properties ?? {});
  let query: string;
  if (userProps.length === 0) {
    query = UPSERT_ENTITY_QUERY;
  } else {
    let suffix = '';
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      suffix += `.property('${key}', p_user_${i})`;
      bindings[`p_user_${i}`] = value;
    }
    query = `${UPSERT_ENTITY_OPEN}${suffix}${UPSERT_ENTITY_CREATE_BRANCH}${suffix})`;
  }

  return { query, bindings };
}

/**
 * Build the statement that upserts a relationship using Gremlin's coalesce pattern — single query.
 *
 * Every lookup is scoped by repositoryId, so an edge with the same id in a
 * different repository cannot be matched and overwritten. An existing edge
 * is updated only when it has the row's type and endpoints; an id in use by
 * anything else is refused by the store with a 409 (see
 * `UPSERT_RELATIONSHIP_OPEN`), recorded as `RELATIONSHIP_ALREADY_EXISTS`.
 *
 * User-property dual-write contract: same shape as `upsertEntity` above —
 * native-storable values in `relationship.properties` project to per-key
 * edge properties via a suffix appended to BOTH coalesce branches, and the
 * `p_user_<i>` bindings are shared across the two halves. The relationship
 * reserved set additionally guards against the Gremlin `'label'` token,
 * which would collide with the edge-label slot set at `addE(edgeLabel)`.
 * Same add-and-overwrite asymmetry on the update branch — orphan scalars
 * from a prior shape are not dropped, because bulk import skips the pre-
 * read. The canonical JSON `properties` blob remains the read-side source
 * of truth.
 */
function upsertRelationshipStatement(
  repositoryId: string,
  rel: StoredRelationship,
): GremlinStatement {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    relId: rel.id,
    srcId: rel.sourceEntityId,
    tgtId: rel.targetEntityId,
    edgeLabel: rel.relationshipType,
    ...relationshipToLadderBindings(rel),
  };

  const userProps = relationshipUserPropertyParams(rel.properties ?? {});
  let query: string;
  if (userProps.length === 0) {
    query = UPSERT_RELATIONSHIP_QUERY;
  } else {
    let suffix = '';
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      suffix += `.property('${key}', p_user_${i})`;
      bindings[`p_user_${i}`] = value;
    }
    query = `${UPSERT_RELATIONSHIP_OPEN}${suffix}${UPSERT_RELATIONSHIP_CREATE_BRANCH}${suffix})`;
  }

  return { query, bindings };
}
