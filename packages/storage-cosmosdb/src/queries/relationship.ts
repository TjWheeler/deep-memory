// Relationship CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { StoredRelationship, RelationshipQueryOptions } from '@utaba/deep-memory/types';
import type { PaginatedResult } from '@utaba/deep-memory/types';
import {
  buildRelationshipPropertyLadder,
  relationshipFromGremlin,
  relationshipToLadderBindings,
} from '../mapping.js';
import { DuplicateRelationshipError, matchesPropertyFilters, buildEdgeProjectChain } from '@utaba/deep-memory';

// Sentinel returned by the duplicate-detection branch of the coalesce upsert
// pattern. Mirrors entity.ts — single round-trip create.
const DUPLICATE_SENTINEL = '__duplicate';

// Fixed-shape property ladder — identical query string across every edge
// create regardless of which optional fields are populated, so the Cosmos
// plan cache reuses one compiled plan.
const RELATIONSHIP_CREATE_QUERY =
  `g.E().has('repositoryId', rid).hasId(relId).fold().coalesce(` +
  `unfold().constant('${DUPLICATE_SENTINEL}'),` +
  `g.V().has('repositoryId', rid).hasId(srcId).has('entityType')` +
  `.addE(edgeLabel)` +
  `.to(g.V().has('repositoryId', rid).hasId(tgtId).has('entityType'))` +
  `.property('id', relId).property('repositoryId', rid)${buildRelationshipPropertyLadder()}` +
  `)`;

export async function createRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationship: StoredRelationship,
): Promise<StoredRelationship> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    relId: relationship.id,
    srcId: relationship.sourceEntityId,
    tgtId: relationship.targetEntityId,
    edgeLabel: relationship.relationshipType,
    ...relationshipToLadderBindings(relationship),
  };

  const result = await conn.submit(RELATIONSHIP_CREATE_QUERY, bindings);

  if (result.items[0] === DUPLICATE_SENTINEL) {
    throw new DuplicateRelationshipError(relationship.id);
  }

  return relationship;
}

export async function getRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<StoredRelationship | null> {
  const projection = buildEdgeProjectChain();
  // Edge-id lookup: g.E().hasId(relId) is engine-routed by doc id; the
  // `has('repositoryId', rid)` predicate after it still doesn't push partition
  // routing down (issue #2 in plans/performance-issues.md). When the source
  // vertex id is known, callers should partition-route via the vertex instead.
  const result = await conn.submit(
    `g.E().hasId(relId).has('repositoryId', rid).${projection}`,
    { relId: relationshipId, rid: repositoryId },
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

  // Build edge traversal based on direction
  let edgeTraversal: string;
  switch (direction) {
    case 'out':
      edgeTraversal = "g.V().has('repositoryId', rid).hasId(eid).has('entityType').outE()";
      break;
    case 'in':
      edgeTraversal = "g.V().has('repositoryId', rid).hasId(eid).has('entityType').inE()";
      break;
    case 'both':
    default:
      edgeTraversal = "g.V().has('repositoryId', rid).hasId(eid).has('entityType').bothE()";
      break;
  }

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

  // For bidirectional support in outbound/inbound:
  // When direction is 'out', include inbound edges that are bidirectional
  // When direction is 'in', include outbound edges that are bidirectional
  // This requires a union approach.
  let unionQuery: string | null = null;
  if (direction === 'out') {
    // outE + inE where bidirectional=true
    unionQuery = `g.V().has('repositoryId', rid).hasId(eid).has('entityType').union(outE()${typeFilter}, inE()${typeFilter}.has('bidirectional', true))`;
  } else if (direction === 'in') {
    unionQuery = `g.V().has('repositoryId', rid).hasId(eid).has('entityType').union(inE()${typeFilter}, outE()${typeFilter}.has('bidirectional', true))`;
  }

  const baseQuery = unionQuery ?? `${edgeTraversal}${typeFilter}`;
  const projection = buildEdgeProjectChain();

  // Count and data round-trips are independent — run them in parallel to halve
  // wall-clock latency. When `propertyFilters` is set the filter runs
  // client-side after the fetch, so a server-side count would overstate the
  // matched total — match the findEntities pattern and surface
  // `total: undefined` in that case.
  const dataBindings = { ...baseBindings, rangeStart: offset, rangeEnd: offset + limit };
  const [countResult, dataResult] = await Promise.all([
    hasPropertyFilters
      ? Promise.resolve(null)
      : conn.submit(`${baseQuery}.dedup().count()`, baseBindings),
    conn.submit(
      `${baseQuery}.dedup().range(rangeStart, rangeEnd).${projection}`,
      dataBindings,
    ),
  ]);

  const rawItems = dataResult.items as Record<string, unknown>[];
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

export async function deleteRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<void> {
  await conn.submit(
    "g.E().hasId(relId).has('repositoryId', rid).drop()",
    { relId: relationshipId, rid: repositoryId },
  );
}


/**
 * Single round-trip type-delete via the aggregate-side-effect pattern: the
 * bucket records the edge ids that were actually dropped, giving an exact
 * `deletedRelationships` count without a separate count query.
 */
export async function deleteRelationshipsByType(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipType: string,
): Promise<{ deletedRelationships: number }> {
  const result = await conn.submit(
    "g.E().has('repositoryId', rid).hasLabel(rtype)" +
      ".aggregate('found').by('id').drop().cap('found')",
    { rid: repositoryId, rtype: relationshipType },
  );
  const bucket = result.items[0];
  const deletedRelationships = Array.isArray(bucket) ? bucket.length : 0;
  return { deletedRelationships };
}
