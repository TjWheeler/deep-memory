// Relationship CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { CosmosDocumentClient } from '../CosmosDocumentClient.js';
import type { StoredRelationship, RelationshipQueryOptions } from '@utaba/deep-memory/types';
import type { PaginatedResult } from '@utaba/deep-memory/types';
import {
  buildRelationshipPropertyLadder,
  relationshipFromGremlin,
  relationshipToLadderBindings,
  relationshipUserPropertyParams,
} from '../mapping.js';
import {
  DuplicateRelationshipError,
  EntityNotFoundError,
  ProviderError,
  RelationshipNotFoundError,
  RepositoryNotFoundError,
  matchesPropertyFilters,
  buildEdgeProjectChain,
} from '@utaba/deep-memory';
import { repoVertexId } from './ids.js';
import { submitCreate } from './create.js';
import { bucketIds, deleteRelationshipsByIds } from './deleteByIds.js';
import { alongsideMarkerRead, assertRepositoryMarker, markerCheckedRead, rowsPastMarker } from './marker.js';

// Sentinels the create query returns in place of the new edge; the caller
// translates them — single round-trip either way. Mirrors entity.ts:
//   - NO_REPOSITORY_SENTINEL: the repository's `_repository` marker vertex is
//     absent, so nothing was written.
//   - NO_SOURCE_SENTINEL: the marker exists but the source entity does not,
//     so nothing was written.
//   - NO_TARGET_SENTINEL: the marker and the source exist but the target
//     entity does not, so nothing was written.
// Each missing endpoint throws `EntityNotFoundError` naming it, the source
// ahead of the target when both are missing — unless the relationship id is
// already taken (see `createRelationship`).
const NO_REPOSITORY_SENTINEL = '__no_repository';
const NO_SOURCE_SENTINEL = '__no_source';
const NO_TARGET_SENTINEL = '__no_target';

// Prefix shared by every relationship-create query:
//
//   1. One indexed lookup fetches the repository marker, the source and the
//      target by id (`hasId(within(repoVid, srcId, tgtId))`, partition-scoped)
//      and folds them into one list. Every later step works on that list, so
//      the statement has no mid-traversal `V()`, whose cost grows with the
//      partition's size.
//   2. Gate on the marker: `deleteRepository` drops the `_repository` vertex
//      before its chunked drain, so a create that runs after that point finds
//      no marker and writes nothing. Checking the marker in the same request
//      as the `addE` leaves no gap between the check and the write for the
//      drop to land in. `hasNot('entityType')` keeps an entity typed
//      `_repository` from passing for the marker.
//   3. Create: the target is labelled `t`, then `addE` runs from the source
//      to it, with the schema-managed edge property ladder. A missing source
//      or target leaves the create branch empty.
//
// The relationship id needs no check here: all of a repository's vertices and
// edges share its partition, and Cosmos refuses a second document with the
// same id in a partition (an edge, an entity or a system vertex) with a 409,
// which `submitCreate` maps to `DuplicateRelationshipError`. The 409 is also
// what a create racing another with the same id gets.
//
// Per-call user-property scalars append after the ladder (between the prefix
// and `RELATIONSHIP_CREATE_CLOSE`). When the caller has no native-storable
// user properties, the empty suffix collapses the emitted string to the
// canonical `RELATIONSHIP_CREATE_QUERY` value below, so the plan cache keeps a
// single warm entry for the dominant shape.
//
// A create already executing when `deleteRepository` drops the marker can
// still land after the drain has passed it; re-running `deleteRepository`
// removes such a straggler.
const RELATIONSHIP_CREATE_PREFIX =
  `g.V().has('repositoryId', rid).hasId(within(repoVid, srcId, tgtId)).fold().as('vs')` +
  `.coalesce(__.unfold().hasLabel('_repository').hasNot('entityType').coalesce(` +
  `__.select('vs').unfold().hasId(tgtId).has('entityType').as('t')` +
  `.select('vs').unfold().hasId(srcId).has('entityType')` +
  `.addE(edgeLabel).to('t')` +
  `.property('id', relId).property('repositoryId', rid)${buildRelationshipPropertyLadder()}`;

// Closes the create branch, then supplies the fallbacks, tried in order once
// the create branch has written nothing:
//   - past the marker, the source is in the list, so the target was missing;
//   - past the marker, so the source was missing;
//   - the marker itself is absent.
const RELATIONSHIP_CREATE_CLOSE =
  `,__.select('vs').unfold().hasId(srcId).has('entityType').constant('${NO_TARGET_SENTINEL}')` +
  `,__.constant('${NO_SOURCE_SENTINEL}')),__.constant('${NO_REPOSITORY_SENTINEL}'))`;

// Canonical empty-user-properties form. Exported so the unit test can pin the
// invariant that every create without native-storable user properties emits
// this one string.
export const RELATIONSHIP_CREATE_QUERY = `${RELATIONSHIP_CREATE_PREFIX}${RELATIONSHIP_CREATE_CLOSE}`;

// Whether any document in the repository's partition — an edge, an entity,
// the marker or a vocabulary vertex — already has the id: the same rule the
// store applies when it refuses the create's `addE` with a 409. Read through
// the Document endpoint, pinned to the partition, only after the create found
// an endpoint missing.
export const RELATIONSHIP_ID_TAKEN_SQL = 'SELECT VALUE COUNT(1) FROM c WHERE c.id = @relId';

/**
 * Create a relationship in one request on the success path. The outcomes
 * follow the precedence repository → id → source → target:
 *   - no marker → `RepositoryNotFoundError`;
 *   - the id taken by any document in the repository's partition (an edge,
 *     an entity, the marker, a vocabulary vertex) →
 *     `DuplicateRelationshipError` (a 409 from the store when both endpoints
 *     exist; otherwise the id read below, which applies the same rule);
 *   - a missing source, then a missing target → `EntityNotFoundError`.
 * When an endpoint is missing, a partition-pinned id read decides between the
 * duplicate and the missing endpoint. It runs whether core minted the id or
 * the caller supplied it: it costs a round trip only on that failure path.
 */
export async function createRelationship(
  conn: CosmosDbConnection,
  docClient: CosmosDocumentClient,
  repositoryId: string,
  relationship: StoredRelationship,
): Promise<StoredRelationship> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    repoVid: repoVertexId(repositoryId),
    relId: relationship.id,
    srcId: relationship.sourceEntityId,
    tgtId: relationship.targetEntityId,
    edgeLabel: relationship.relationshipType,
    ...relationshipToLadderBindings(relationship),
  };

  // Dual-write: the JSON blob lives in the `properties` ladder slot above
  // (round-trip authoritative); native-storable scalars also project to per-
  // key edge properties so server-side predicates and aggregations can reach
  // them. Validation runs before any round-trip — reserved-key collisions
  // (including the Gremlin 'label' token) and unsafe identifiers raise
  // ProviderError synchronously.
  const userProps = relationshipUserPropertyParams(relationship.properties ?? {});
  let query: string;
  if (userProps.length === 0) {
    query = RELATIONSHIP_CREATE_QUERY;
  } else {
    let suffix = '';
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      suffix += `.property('${key}', p_user_${i})`;
      bindings[`p_user_${i}`] = value;
    }
    query = `${RELATIONSHIP_CREATE_PREFIX}${suffix}${RELATIONSHIP_CREATE_CLOSE}`;
  }

  const result = await submitCreate(
    conn,
    query,
    bindings,
    (cause) => new DuplicateRelationshipError(relationship.id, { cause }),
  );

  // Every branch of the statement emits a row (the new edge or a sentinel),
  // so no row is a malformed response.
  const outcome = result.items[0];
  if (outcome === undefined) throw new ProviderError('Cosmos relationship create returned no row.');
  if (outcome === NO_REPOSITORY_SENTINEL) {
    throw new RepositoryNotFoundError(repositoryId);
  }
  if (outcome === NO_SOURCE_SENTINEL || outcome === NO_TARGET_SENTINEL) {
    const taken = await docClient.query<number>(
      RELATIONSHIP_ID_TAKEN_SQL,
      [{ name: '@relId', value: relationship.id }],
      { partitionKey: repositoryId },
    );
    // `COUNT(1)` always emits a row, so no row is a malformed response.
    const count = taken.documents[0];
    if (count === undefined) throw new ProviderError('Cosmos relationship id read returned no row.');
    const matches = Number(count);
    if (!Number.isFinite(matches)) throw new ProviderError('Cosmos relationship id read returned a count that is not a number.');
    if (matches > 0) throw new DuplicateRelationshipError(relationship.id);
    throw new EntityNotFoundError(
      outcome === NO_SOURCE_SENTINEL ? relationship.sourceEntityId : relationship.targetEntityId,
    );
  }

  return relationship;
}

/**
 * Read one relationship by id. An edge lookup cannot fetch the repository
 * marker in its first step, so a marker point read runs alongside it.
 *
 * @throws RepositoryNotFoundError when the marker is absent.
 */
export async function getRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<StoredRelationship | null> {
  const projection = buildEdgeProjectChain();
  // Edge-id lookup: g.E().hasId(relId) is engine-routed by doc id; the
  // `has('repositoryId', rid)` predicate after it still doesn't push partition
  // routing down. When the source vertex id is known, callers should
  // partition-route via the vertex instead.
  const result = await alongsideMarkerRead(conn, repositoryId, () =>
    conn.submit(`g.E().hasId(relId).has('repositoryId', rid).${projection}`, {
      relId: relationshipId,
      rid: repositoryId,
    }),
  );
  if (result.items.length === 0) return null;
  return relationshipFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function getEntityRelationships(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  options?: RelationshipQueryOptions,
): Promise<PaginatedResult<StoredRelationship>> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const direction = options?.direction ?? 'both';
  const hasPropertyFilters =
    options?.propertyFilters != null && options.propertyFilters.length > 0;

  const baseBindings: Record<string, unknown> = {
    rid: repositoryId,
    eid: entityId,
  };

  // Filter by relationship types
  let typeFilter = '';
  if (options?.relationshipTypes && options.relationshipTypes.length > 0) {
    const typeParams: string[] = [];
    options.relationshipTypes.forEach((t, i) => {
      const paramName = `rtype${i}`;
      baseBindings[paramName] = t;
      typeParams.push(paramName);
    });
    typeFilter = `.hasLabel(${typeParams.join(', ')})`;
  }

  // Edge steps from the entity. For bidirectional support in outbound /
  // inbound: direction 'out' also takes inbound edges that are
  // bidirectional, and 'in' takes outbound ones.
  let edgeSteps: string;
  switch (direction) {
    case 'out':
      edgeSteps = `union(__.outE()${typeFilter}, __.inE()${typeFilter}.has('bidirectional', true))`;
      break;
    case 'in':
      edgeSteps = `union(__.inE()${typeFilter}, __.outE()${typeFilter}.has('bidirectional', true))`;
      break;
    case 'both':
    default:
      edgeSteps = `bothE()${typeFilter}`;
      break;
  }

  const projection = buildEdgeProjectChain();

  // Count and data round-trips are independent — run them in parallel to halve
  // wall-clock latency. The data read fetches the repository marker with the
  // entity in its first, indexed step, so a deleted repository is refused
  // ahead of the page and the count: both are settled, and the data read's
  // outcome (its failure, or a missing marker) is raised before a failed
  // count. When `propertyFilters` is set the
  // filter runs client-side after the fetch, so a server-side count would
  // overstate the matched total — match the findEntities pattern and surface
  // `total: undefined` in that case.
  const dataBindings = {
    ...baseBindings,
    mid: repoVertexId(repositoryId),
    rangeStart: offset,
    rangeEnd: offset + limit,
  };
  const [countSettled, dataSettled] = await Promise.allSettled([
    hasPropertyFilters
      ? Promise.resolve(null)
      : conn.submit(
          `g.V().has('repositoryId', rid).hasId(eid).has('entityType').${edgeSteps}.dedup().count()`,
          baseBindings,
        ),
    conn.submit(
      markerCheckedRead(
        'hasId(within(mid, eid))',
        `${edgeSteps}.dedup().range(rangeStart, rangeEnd).${projection}`,
      ),
      dataBindings,
    ),
  ]);

  if (dataSettled.status === 'rejected') throw dataSettled.reason;
  const rawItems = rowsPastMarker(dataSettled.value.items, repositoryId) as Record<string, unknown>[];
  if (countSettled.status === 'rejected') throw countSettled.reason;
  const countResult = countSettled.value;
  let items = rawItems.map(relationshipFromGremlin);

  if (hasPropertyFilters) {
    items = items.filter(rel => matchesPropertyFilters(rel.properties, options!.propertyFilters!));
  }

  const total = countResult ? Number(countResult.items[0] ?? 0) : undefined;
  const hasMore = total != null ? offset + rawItems.length < total : rawItems.length === limit;

  return {
    items,
    total,
    hasMore,
    limit,
    offset,
  };
}

/**
 * Delete one relationship through the marker-checked delete
 * (`deleteRelationshipsByIds`). A missing repository marker →
 * `RepositoryNotFoundError`; an id with no relationship in an existing
 * repository → `RelationshipNotFoundError`.
 */
export async function deleteRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<void> {
  const { notFound } = await deleteRelationshipsByIds(conn, repositoryId, [relationshipId]);
  if (notFound.length > 0) throw new RelationshipNotFoundError(relationshipId);
}


/** Edges dropped per batch of a by-type delete. */
export const RELATIONSHIP_TYPE_DELETE_BATCH_SIZE = 500;

/**
 * One batch of a relationship-type delete: up to `batchSize` edges of the
 * type, dropped in one request that reports their ids (the bucket records the
 * ids before the drop).
 */
export const RELATIONSHIP_TYPE_BATCH_DROP_QUERY =
  "g.E().has('repositoryId', rid).hasLabel(rtype).limit(batchSize)" +
  ".aggregate('found').by('id').drop().cap('found')";

/**
 * Drop every edge of a type in batches, until a batch drops nothing, and
 * report how many were dropped: the sum of the batches' buckets, each the ids
 * its request found and dropped. The sum is never more than were removed, and
 * may be fewer: when a transient error (429 / 503) makes the connection
 * re-send a batch that had already partly applied, the re-sent request
 * reports only the edges still there. A single request over the whole type grows
 * with the type's population and can outlast the request timeout; a bounded
 * batch costs the same whatever the type's size, and a delete stopped
 * part-way is finished by calling it again.
 *
 * An edge traversal cannot fetch the repository marker in its first step, so
 * a marker point read runs before each batch. Cosmos Gremlin has no
 * transaction across requests: a `deleteRepository` that drops the marker
 * between the read and the drop lets that batch go ahead on edges its drain
 * would have removed, and the call reports them instead of
 * `RepositoryNotFoundError`. The next batch's read then finds the marker gone.
 *
 * @throws RepositoryNotFoundError when the marker is absent; the batch whose
 *   read finds it absent drops nothing.
 */
export async function deleteRelationshipsByType(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipType: string,
): Promise<{ deletedRelationships: number }> {
  let deletedRelationships = 0;
  while (true) {
    await assertRepositoryMarker(conn, repositoryId);
    const result = await conn.submit(RELATIONSHIP_TYPE_BATCH_DROP_QUERY, {
      rid: repositoryId,
      rtype: relationshipType,
      batchSize: RELATIONSHIP_TYPE_DELETE_BATCH_SIZE,
    });
    const dropped = bucketIds(result.items, 'relationship type delete').length;
    if (dropped === 0) return { deletedRelationships };
    deletedRelationships += dropped;
  }
}
