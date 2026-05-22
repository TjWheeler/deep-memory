// Relationship CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { StoredRelationship, RelationshipQueryOptions } from '@utaba/deep-memory/types';
import type { PaginatedResult } from '@utaba/deep-memory/types';
import { relationshipFromGremlin, relationshipToGremlinProps } from '../mapping.js';
import { DuplicateRelationshipError, matchesPropertyFilters } from '@utaba/deep-memory';

export async function createRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationship: StoredRelationship,
): Promise<StoredRelationship> {
  // Check for duplicate — scoped by repositoryId so the same relationship id
  // in a different repo does not cause a false-positive collision.
  const existing = await conn.submit(
    "g.E().has('repositoryId', rid).has('id', relId).count()",
    { rid: repositoryId, relId: relationship.id },
  );
  if (Number(existing.items[0] ?? 0) > 0) {
    throw new DuplicateRelationshipError(relationship.id);
  }

  const props = relationshipToGremlinProps(repositoryId, relationship);
  const bindings: Record<string, unknown> = {
    relId: relationship.id,
    srcId: relationship.sourceEntityId,
    tgtId: relationship.targetEntityId,
    rid: repositoryId,
    edgeLabel: relationship.relationshipType,
  };
  const propParts: string[] = [];
  let idx = 0;

  for (const [key, value] of Object.entries(props)) {
    const paramName = `p${idx++}`;
    bindings[paramName] = value;
    propParts.push(`.property('${key}', ${paramName})`);
  }

  // addE requires source and target vertex references
  const query = `g.V().has('repositoryId', rid).has('id', srcId).has('entityType').addE(edgeLabel).to(g.V().has('repositoryId', rid).has('id', tgtId).has('entityType')).property('id', relId)${propParts.join('')}`;
  await conn.submit(query, bindings);

  return relationship;
}

export async function getRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<StoredRelationship | null> {
  const result = await conn.submit(
    "g.E().has('id', relId).has('repositoryId', rid).valueMap(true)",
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

  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    eid: entityId,
  };

  // Build edge traversal based on direction
  let edgeTraversal: string;
  switch (direction) {
    case 'outbound':
      edgeTraversal = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').outE()";
      break;
    case 'inbound':
      edgeTraversal = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').inE()";
      break;
    case 'both':
    default:
      edgeTraversal = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').bothE()";
      break;
  }

  // Filter by relationship types
  let typeFilter = '';
  if (options?.relationshipTypes && options.relationshipTypes.length > 0) {
    const typeParams: string[] = [];
    options.relationshipTypes.forEach((t, i) => {
      const paramName = `rtype${i}`;
      bindings[paramName] = t;
      typeParams.push(paramName);
    });
    typeFilter = `.hasLabel(${typeParams.join(', ')})`;
  }

  // For bidirectional support in outbound/inbound:
  // When direction is 'outbound', include inbound edges that are bidirectional
  // When direction is 'inbound', include outbound edges that are bidirectional
  // This requires a union approach.
  let unionQuery: string | null = null;
  if (direction === 'outbound') {
    // outE + inE where bidirectional=true
    unionQuery = `g.V().has('repositoryId', rid).has('id', eid).has('entityType').union(outE()${typeFilter}, inE()${typeFilter}.has('bidirectional', true))`;
  } else if (direction === 'inbound') {
    unionQuery = `g.V().has('repositoryId', rid).has('id', eid).has('entityType').union(inE()${typeFilter}, outE()${typeFilter}.has('bidirectional', true))`;
  }

  const baseQuery = unionQuery ?? `${edgeTraversal}${typeFilter}`;

  // Count
  const countResult = await conn.submit(`${baseQuery}.dedup().count()`, bindings);
  const total = Number(countResult.items[0] ?? 0);

  // Data
  bindings['rangeStart'] = offset;
  bindings['rangeEnd'] = offset + limit;
  const dataResult = await conn.submit(
    `${baseQuery}.dedup().range(rangeStart, rangeEnd).valueMap(true)`,
    bindings,
  );

  let items = (dataResult.items as Record<string, unknown>[]).map(relationshipFromGremlin);

  // Post-filter by property filters
  if (options?.propertyFilters && options.propertyFilters.length > 0) {
    items = items.filter(rel => matchesPropertyFilters(rel.properties, options.propertyFilters!));
  }

  return {
    items,
    total,
    hasMore: offset + limit < total,
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
    "g.E().has('id', relId).has('repositoryId', rid).drop()",
    { relId: relationshipId, rid: repositoryId },
  );
}


export async function deleteRelationshipsByType(
  conn: CosmosDbConnection,
  repositoryId: string,
  relationshipType: string,
): Promise<{ deletedRelationships: number }> {
  const countResult = await conn.submit(
    "g.E().has('repositoryId', rid).hasLabel(rtype).count()",
    { rid: repositoryId, rtype: relationshipType },
  );
  const deletedRelationships = Number(countResult.items[0] ?? 0);

  if (deletedRelationships > 0) {
    await conn.submit(
      "g.E().has('repositoryId', rid).hasLabel(rtype).drop()",
      { rid: repositoryId, rtype: relationshipType },
    );
  }

  return { deletedRelationships };
}
