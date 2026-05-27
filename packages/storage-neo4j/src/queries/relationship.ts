// Relationship CRUD Cypher queries.
//
// Storage shape (per D5 / D7):
//   - Each relationship is a directed Cypher edge whose type is the
//     vocabulary slug uppercased per Cypher convention (D5 — `WORKS_AT`,
//     `KNOWS`, …). The relationship-type slot cannot be parameterised in
//     Cypher 25, so the slug is interpolated into the query string after
//     passing `assertSafeRelationshipType` — vocabulary cardinality bounds
//     the per-type plan-cache footprint (cheat sheet "Indexes" / Phase plan
//     D7).
//   - `bidirectional: true` is a read-time hint: the edge is still stored as
//     a single directed edge, and `getEntityRelationships` exposes it from
//     both ends by UNION-ing the inverse-direction match for bidirectional
//     edges. Writers do not duplicate the edge.
//   - Relationship `properties` round-trip as a JSON blob on the
//     `r.properties` field (no per-scalar storage and no relationship index
//     by property — relationships are not the indexed surface). Server-side
//     filtering by property therefore requires JSON parsing inside Cypher
//     (APOC), so `propertyFilters` is applied client-side after fetch and
//     `total` is reported as `undefined` in that case, matching the Cosmos
//     contract for the same pattern.
//
// Isolation invariant (D3b layer 3):
//   - `createRelationship` MATCHes both endpoint nodes under the scoping
//     `$rid` predicate before issuing `CREATE`. A cross-repository edge is
//     therefore structurally unwritable: the endpoint MATCH for the
//     out-of-scope side returns zero rows and the `FOREACH` conditional
//     skips the CREATE.
//   - Every read / delete carries the `$rid` predicate on the relationship
//     property map so reachability is bounded by the scope discriminator,
//     not the graph topology.

import type { Neo4jConnection } from '../Neo4jConnection.js';
import type {
  PaginatedResult,
  RelationshipQueryOptions,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import {
  EntityNotFoundError,
  matchesPropertyFilters,
} from '@utaba/deep-memory';
import {
  assertSafeRelationshipType,
  bigintToSafeNumber,
  buildRelationshipProjection,
  relationshipFromRecord,
  relationshipToParams,
} from '../mapping.js';

// Shared projections — computed once at module load so the planner keys off
// byte-identical strings regardless of which read path emits the query.
const RELATIONSHIP_PROJECTION = buildRelationshipProjection();

/**
 * Create a relationship. Single-round-trip pattern: `OPTIONAL MATCH` both
 * endpoints under the repository scope, then `FOREACH` the `CREATE` only when
 * both are present, finally `RETURN` existence flags so the caller can
 * discriminate missing-source vs missing-target without a follow-up query.
 *
 * The relationship-type slot is interpolated into the Cypher string after
 * validation by `assertSafeRelationshipType` — Cypher 25 cannot parameterise
 * the type slot, and unbounded values would widen the injection surface. The
 * vocabulary's bounded cardinality keeps the plan cache footprint linear in
 * the type count.
 *
 * Cross-repository edges are structurally impossible: an endpoint in a
 * different repository fails its `(repositoryId, id)` MATCH and lands in the
 * `sMissing`/`tMissing` branch as if the entity did not exist at all.
 */
export async function createRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  relationship: StoredRelationship,
): Promise<StoredRelationship> {
  const relType = assertSafeRelationshipType(relationship.relationshipType);

  const cypher = `
OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: $sourceEntityId})
OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: $targetEntityId})
WITH s, t
FOREACH (_ IN CASE WHEN s IS NOT NULL AND t IS NOT NULL THEN [1] ELSE [] END |
  CREATE (s)-[r:${relType} {
    repositoryId: $rid,
    id: $id,
    relationshipType: $relationshipType,
    sourceEntityId: $sourceEntityId,
    targetEntityId: $targetEntityId,
    properties: $properties,
    bidirectional: $bidirectional,
    createdBy: $createdBy,
    createdByType: $createdByType,
    createdAt: $createdAt,
    createdInConversation: $createdInConversation,
    createdFromMessage: $createdFromMessage,
    modifiedBy: $modifiedBy,
    modifiedByType: $modifiedByType,
    modifiedAt: $modifiedAt,
    modifiedInConversation: $modifiedInConversation,
    modifiedFromMessage: $modifiedFromMessage
  }]->(t)
)
RETURN s IS NULL AS sMissing, t IS NULL AS tMissing
`;

  const result = await conn.executeQuery(
    cypher,
    relationshipToParams(relationship),
    { repositoryId },
  );

  const record = result.records[0];
  if (record === undefined) {
    // The OPTIONAL MATCH + FOREACH path always emits exactly one row.
    // Reaching this branch indicates the driver dropped the row, which
    // would be a driver-layer fault rather than a data-model condition.
    throw new EntityNotFoundError(relationship.sourceEntityId);
  }
  const sMissing = record.get('sMissing') === true;
  const tMissing = record.get('tMissing') === true;
  if (sMissing) throw new EntityNotFoundError(relationship.sourceEntityId);
  if (tMissing) throw new EntityNotFoundError(relationship.targetEntityId);
  return relationship;
}

/**
 * Look up a relationship by id. The implicit-direction pattern
 * `()-[r {...}]-()` finds the edge from either endpoint; the
 * `(repositoryId, id)` predicate is the application-level dedup key (D7).
 * Returns `null` on miss — contract is `null`-on-miss, not throw.
 */
export async function getRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<StoredRelationship | null> {
  // Edges are written directionally (D5) — the `->` pattern matches each
  // relationship exactly once. The undirected `-[r]-` variant enumerates both
  // endpoint perspectives and yields each edge twice, which is wasted work
  // for a unique-by-id lookup.
  const result = await conn.executeQuery(
    `MATCH ()-[r {repositoryId: $rid, id: $relId}]->() RETURN ${RELATIONSHIP_PROJECTION}`,
    { relId: relationshipId },
    { repositoryId, routing: 'READ' },
  );
  const record = result.records[0];
  if (record === undefined) return null;
  return relationshipFromRecord(record);
}

/**
 * Page an entity's incident relationships with direction + type + property
 * filters. Direction semantics relative to `entityId`:
 *
 *   - `'both'` — every incident edge (single MATCH, no UNION required).
 *   - `'out'`  — outbound edges, plus inbound edges flagged
 *                `bidirectional: true` (read-time exposure of the bidir
 *                hint; writers store one directed edge).
 *   - `'in'`   — inbound edges, plus outbound `bidirectional: true` edges.
 *
 * Property filters apply client-side because relationship `properties` is a
 * single JSON blob (no per-scalar storage on the relationship surface).
 * When `propertyFilters` is set, `total` is reported as `undefined` —
 * mirrors the Cosmos contract for the same pattern.
 *
 * Data and count round-trips run in parallel under one Bolt connection;
 * the driver multiplexes so wall-clock latency approximates one round-trip.
 */
export async function getEntityRelationships(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
  options?: RelationshipQueryOptions,
): Promise<PaginatedResult<StoredRelationship>> {
  const limit = options?.limit ?? 50;
  const offset = options?.offset ?? 0;
  const direction = options?.direction ?? 'both';
  const propertyFilters = options?.propertyFilters;
  const hasPropertyFilters = propertyFilters != null && propertyFilters.length > 0;

  // SKIP / LIMIT take Cypher INTEGER; under `useBigInt: true` plain JS numbers
  // round-trip as FLOAT and the planner rejects with
  // `Neo.ClientError.Statement.ArgumentError`. BigInt round-trips as INTEGER
  // — same fix the vocabulary change-log query already applies.
  const params: Record<string, unknown> = {
    eid: entityId,
    offset: BigInt(offset),
    limit: BigInt(limit),
  };
  const typeFilter: string = options?.relationshipTypes != null && options.relationshipTypes.length > 0
    ? buildTypeFilter(options.relationshipTypes, params)
    : '';

  const { dataCypher, countCypher } = buildEntityRelationshipQueries(direction, typeFilter);

  const [dataResult, countResult] = await Promise.all([
    conn.executeQuery(dataCypher, params, { repositoryId, routing: 'READ' }),
    hasPropertyFilters
      ? Promise.resolve(null)
      : conn.executeQuery(countCypher, params, { repositoryId, routing: 'READ' }),
  ]);

  let items = dataResult.records.map((record) => relationshipFromRecord(record));
  if (hasPropertyFilters) {
    items = items.filter((rel) => matchesPropertyFilters(rel.properties, propertyFilters));
  }

  let total: number | undefined;
  if (countResult !== null) {
    const totalRecord = countResult.records[0];
    total = totalRecord !== undefined
      ? bigintToSafeNumber(totalRecord.get('total') ?? 0)
      : 0;
  }
  const hasMore =
    total !== undefined ? offset + dataResult.records.length < total : dataResult.records.length === limit;

  return { items, total, hasMore, limit, offset };
}

/**
 * Drop a single relationship by id. No-op on miss — mirrors the Cosmos
 * contract (the public surface returns `void`, not a deleted-row count).
 */
export async function deleteRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<void> {
  // Directional pattern: edges are stored directionally so `->` matches each
  // relationship once. `-[r]-` would enumerate both endpoint perspectives
  // and re-issue DELETE against an already-removed edge, which is wasted
  // work even though the operation remains idempotent.
  await conn.executeQuery(
    'MATCH ()-[r {repositoryId: $rid, id: $relId}]->() DELETE r',
    { relId: relationshipId },
    { repositoryId },
  );
}

/**
 * Bulk delete by ids — single round-trip. Returns the ids actually deleted
 * (drawn from the `DELETE` operator's RETURN slice); the caller computes
 * the `notFound` set via set difference against the input ids. Empty input
 * short-circuits without a round-trip.
 */
export async function deleteRelationships(
  conn: Neo4jConnection,
  repositoryId: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  if (ids.length === 0) return { deleted: [], notFound: [] };
  // Directional pattern — edges are stored directionally, so `->` matches
  // each relationship exactly once. `-[r]-` would double-yield each edge
  // (once per endpoint perspective), producing duplicate ids in the
  // returned `deleted` set.
  const result = await conn.executeQuery(
    'MATCH ()-[r {repositoryId: $rid}]->() WHERE r.id IN $ids ' +
      'WITH r, r.id AS id DELETE r RETURN id AS deleted',
    { ids },
    { repositoryId },
  );
  const deleted: string[] = [];
  for (const record of result.records) {
    const id = record.get('deleted');
    if (typeof id === 'string') deleted.push(id);
  }
  const deletedSet = new Set(deleted);
  const notFound = ids.filter((id) => !deletedSet.has(id));
  return { deleted, notFound };
}

/**
 * Drop every relationship of a type in the repository, returning an exact
 * count in a single round-trip. The type slot is interpolated after
 * `assertSafeRelationshipType` (Cypher 25 cannot parameterise it); the
 * `repositoryId` predicate on the edge property map bounds the match.
 */
export async function deleteRelationshipsByType(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipType: string,
): Promise<{ deletedRelationships: number }> {
  const relType = assertSafeRelationshipType(relationshipType);
  // Directional pattern — edges are stored directionally, so `->` matches
  // each relationship exactly once. `-[r]-` would double-count by visiting
  // each edge from both endpoint perspectives.
  const result = await conn.executeQuery(
    `MATCH ()-[r:${relType} {repositoryId: $rid}]->() WITH r, r.id AS id DELETE r RETURN id`,
    {},
    { repositoryId },
  );
  return { deletedRelationships: result.records.length };
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Build the `WHERE type(r) IN $relTypes` predicate fragment and bind the
 * `relTypes` parameter. `type(r)` (the Cypher built-in returning the
 * relationship's stored type) is preferred over `r.relationshipType` so the
 * planner can use the relationship-type index path directly.
 *
 * Returns the predicate **with leading whitespace** so the caller can
 * concatenate after an existing `WHERE` or as a standalone clause without
 * conditional whitespace logic at the seam.
 */
function buildTypeFilter(
  relationshipTypes: string[],
  params: Record<string, unknown>,
): string {
  params['relTypes'] = relationshipTypes;
  return ' WHERE type(r) IN $relTypes';
}

/**
 * Assemble the data + count Cypher for a given direction. `'both'` collapses
 * to a single MATCH; the directional cases UNION ALL the natural-direction
 * edges with the inverse-direction bidirectional edges so the bidir read-time
 * hint is exposed from both endpoints without writers duplicating the edge.
 *
 * Count queries wrap the same UNION ALL in a `CALL ( ) { ... }` subquery so
 * `count(*)` aggregates over the unioned row set.
 */
function buildEntityRelationshipQueries(
  direction: 'out' | 'in' | 'both',
  typeFilter: string,
): { dataCypher: string; countCypher: string } {
  if (direction === 'both') {
    const dataCypher =
      `MATCH (e:_Entity {repositoryId: $rid, id: $eid})-[r {repositoryId: $rid}]-()${typeFilter} ` +
      `RETURN ${RELATIONSHIP_PROJECTION} ORDER BY id SKIP $offset LIMIT $limit`;
    const countCypher =
      `MATCH (e:_Entity {repositoryId: $rid, id: $eid})-[r {repositoryId: $rid}]-()${typeFilter} ` +
      `RETURN count(r) AS total`;
    return { dataCypher, countCypher };
  }

  // direction === 'out' or 'in'. The natural branch matches edges where `e`
  // sits on the queried end; the bidir branch matches edges where `e` sits
  // on the opposite end AND the bidirectional flag is set.
  const naturalPattern =
    direction === 'out'
      ? '(e:_Entity {repositoryId: $rid, id: $eid})-[r {repositoryId: $rid}]->()'
      : '()-[r {repositoryId: $rid}]->(e:_Entity {repositoryId: $rid, id: $eid})';
  const bidirPattern =
    direction === 'out'
      ? '()-[r {repositoryId: $rid, bidirectional: true}]->(e:_Entity {repositoryId: $rid, id: $eid})'
      : '(e:_Entity {repositoryId: $rid, id: $eid})-[r {repositoryId: $rid, bidirectional: true}]->()';

  const dataCypher =
    `CALL () {\n` +
    `  MATCH ${naturalPattern}${typeFilter} RETURN ${RELATIONSHIP_PROJECTION}\n` +
    `  UNION ALL\n` +
    `  MATCH ${bidirPattern}${typeFilter} RETURN ${RELATIONSHIP_PROJECTION}\n` +
    `}\n` +
    `RETURN ${reprojectFromCallScope()} ORDER BY id SKIP $offset LIMIT $limit`;

  const countCypher =
    `CALL () {\n` +
    `  MATCH ${naturalPattern}${typeFilter} RETURN r.id AS rid\n` +
    `  UNION ALL\n` +
    `  MATCH ${bidirPattern}${typeFilter} RETURN r.id AS rid\n` +
    `}\n` +
    `RETURN count(rid) AS total`;

  return { dataCypher, countCypher };
}

/**
 * After a `CALL ( ) { ... }` subquery that returns the projection columns
 * directly, the outer query sees each projected name as a top-level
 * variable. The outer `RETURN` re-projects those variables verbatim so the
 * driver record carries the same shape as the non-UNION path — keeping the
 * mapper agnostic to whether the result came from a single MATCH or a
 * unioned set.
 */
function reprojectFromCallScope(): string {
  return RELATIONSHIP_PROJECTION
    .split(',')
    .map((part) => {
      const segments = part.trim().split(' AS ');
      const fieldName = (segments[1] ?? segments[0] ?? '').trim();
      return `${fieldName} AS ${fieldName}`;
    })
    .join(', ');
}
