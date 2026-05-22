// Entity CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { StoredEntity, StoredEntityUpdate } from '@utaba/deep-memory/types';
import type { StorageFindQuery, PaginatedResult } from '@utaba/deep-memory/types';
import { entityFromGremlin, entityToGremlinProps } from '../mapping.js';
import { DuplicateEntityError } from '@utaba/deep-memory';

export async function createEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entity: StoredEntity,
): Promise<StoredEntity> {
  // Check for duplicate
  const existing = await conn.submit(
    "g.V().has('repositoryId', rid).has('id', eid).count()",
    { rid: repositoryId, eid: entity.id },
  );
  if (Number(existing.items[0] ?? 0) > 0) {
    throw new DuplicateEntityError(entity.id);
  }

  const props = entityToGremlinProps(repositoryId, entity);
  const bindings: Record<string, unknown> = { vid: entity.id };
  const propParts: string[] = [];
  let idx = 0;

  for (const [key, value] of Object.entries(props)) {
    const paramName = `p${idx++}`;
    bindings[paramName] = value;
    propParts.push(`.property('${key}', ${paramName})`);
  }

  // Use entityType as the vertex label for Gremlin graph semantics
  bindings['vertexLabel'] = entity.entityType;
  const query = `g.addV(vertexLabel).property('id', vid)${propParts.join('')}`;
  await conn.submit(query, bindings);

  return entity;
}

export async function getEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
): Promise<StoredEntity | null> {
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).has('id', eid).has('entityType').valueMap(true)",
    { rid: repositoryId, eid: entityId },
  );
  if (result.items.length === 0) return null;
  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function getEntityBySlug(
  conn: CosmosDbConnection,
  repositoryId: string,
  slug: string,
): Promise<StoredEntity | null> {
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).has('slug', slugVal).has('entityType').valueMap(true)",
    { rid: repositoryId, slugVal: slug },
  );
  if (result.items.length === 0) return null;
  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function getEntities(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityIds: string[],
): Promise<Map<string, StoredEntity>> {
  if (entityIds.length === 0) return new Map();

  // Build within() clause with individual params
  const bindings: Record<string, unknown> = { rid: repositoryId };
  const idParams: string[] = [];
  entityIds.forEach((id, i) => {
    const paramName = `eid${i}`;
    bindings[paramName] = id;
    idParams.push(paramName);
  });

  const withinClause = `within(${idParams.join(', ')})`;
  const result = await conn.submit(
    `g.V().has('repositoryId', rid).has('id', ${withinClause}).has('entityType').valueMap(true)`,
    bindings,
  );

  const map = new Map<string, StoredEntity>();
  for (const item of result.items) {
    const entity = entityFromGremlin(item as Record<string, unknown>);
    map.set(entity.id, entity);
  }
  return map;
}

export async function updateEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  updates: StoredEntityUpdate,
): Promise<StoredEntity> {
  const bindings: Record<string, unknown> = { rid: repositoryId, eid: entityId };
  const propParts: string[] = [];
  let idx = 0;

  const addProp = (key: string, value: string | number | boolean) => {
    const paramName = `p${idx++}`;
    bindings[paramName] = value;
    propParts.push(`.property('${key}', ${paramName})`);
  };

  // Gremlin has no "set to null" — to clear a property we drop it with a
  // sideEffect step. Drops run before sets because `.sideEffect(...)` is
  // appended to `propParts` in traversal order.
  const dropProp = (key: string) => {
    propParts.push(`.sideEffect(properties('${key}').drop())`);
  };

  // Note: entityType drives both the Gremlin vertex label (set at addV) and the
  // `entityType` property. The vertex label is immutable in Gremlin, but every
  // entity query in this provider filters by the `entityType` property rather
  // than vertex label, so updating the property is sufficient for functional
  // correctness. The vertex label becomes a stale hint only.
  if (updates.entityType !== undefined) addProp('entityType', updates.entityType);
  if (updates.label !== undefined) addProp('entityLabel', updates.label);
  if (updates.slug !== undefined) addProp('slug', updates.slug);
  if (updates.summary === null) dropProp('summary');
  else if (updates.summary !== undefined) addProp('summary', updates.summary);
  if (updates.properties !== undefined) addProp('properties', JSON.stringify(updates.properties));
  if (updates.data === null) dropProp('data');
  else if (updates.data !== undefined) addProp('data', updates.data);
  if (updates.dataFormat === null) dropProp('dataFormat');
  else if (updates.dataFormat !== undefined) addProp('dataFormat', updates.dataFormat);
  if (updates.embedding !== undefined) addProp('embedding', JSON.stringify(updates.embedding));

  // Provenance
  addProp('modifiedBy', updates.provenance.modifiedBy);
  addProp('modifiedByType', updates.provenance.modifiedByType);
  addProp('modifiedAt', updates.provenance.modifiedAt);
  if (updates.provenance.modifiedInConversation != null) addProp('modifiedInConversation', updates.provenance.modifiedInConversation);
  if (updates.provenance.modifiedFromMessage != null) addProp('modifiedFromMessage', updates.provenance.modifiedFromMessage);

  const query = `g.V().has('repositoryId', rid).has('id', eid).has('entityType')${propParts.join('')}`;
  await conn.submit(query, bindings);

  return (await getEntity(conn, repositoryId, entityId))!;
}

export async function deleteEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
): Promise<void> {
  // Gremlin drop() on a vertex also drops connected edges
  await conn.submit(
    "g.V().has('repositoryId', rid).has('id', eid).has('entityType').drop()",
    { rid: repositoryId, eid: entityId },
  );
}

export async function deleteEntitiesByType(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityType: string,
): Promise<{ deletedEntities: number; deletedRelationships: number }> {
  // Count entities of this type
  const entityCountResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('entityType', etype).count()",
    { rid: repositoryId, etype: entityType },
  );
  const deletedEntities = Number(entityCountResult.items[0] ?? 0);

  // Count relationships connected to these entities
  const relCountResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('entityType', etype).bothE().dedup().count()",
    { rid: repositoryId, etype: entityType },
  );
  const deletedRelationships = Number(relCountResult.items[0] ?? 0);

  // Drop the vertices (and their edges)
  if (deletedEntities > 0) {
    await conn.submit(
      "g.V().has('repositoryId', rid).has('entityType', etype).drop()",
      { rid: repositoryId, etype: entityType },
    );
  }

  return { deletedEntities, deletedRelationships };
}

export async function findEntities(
  conn: CosmosDbConnection,
  repositoryId: string,
  query: StorageFindQuery,
): Promise<PaginatedResult<StoredEntity>> {
  const bindings: Record<string, unknown> = { rid: repositoryId };
  let filterClause = ".has('repositoryId', rid).has('entityType')";

  // Entity type filter
  if (query.entityTypes && query.entityTypes.length > 0) {
    const typeParams: string[] = [];
    query.entityTypes.forEach((t, i) => {
      const paramName = `etype${i}`;
      bindings[paramName] = t;
      typeParams.push(paramName);
    });
    filterClause += `.has('entityType', within(${typeParams.join(', ')}))`;
  }

  // searchTerm and properties can't be filtered server-side: CosmosDB Gremlin
  // silently drops TextP.containing(), and properties are stored as a JSON blob.
  // When either is present, load all type-matched vertices and filter in memory
  // so pagination and total counts reflect the real result set.
  const hasPropertyFilter =
    query.properties != null && Object.keys(query.properties).length > 0;
  const needsClientFilter = Boolean(query.searchTerm) || hasPropertyFilter;

  if (needsClientFilter) {
    const dataResult = await conn.submit(
      `g.V()${filterClause}.valueMap(true)`,
      bindings,
    );
    let items = (dataResult.items as Record<string, unknown>[]).map(entityFromGremlin);

    if (query.searchTerm) {
      const term = query.searchTerm.toLowerCase();
      items = items.filter(
        (e) =>
          e.label.toLowerCase().includes(term) ||
          e.slug.toLowerCase().includes(term) ||
          (e.summary != null && e.summary.toLowerCase().includes(term)),
      );
    }

    if (hasPropertyFilter) {
      items = items.filter((entity) => {
        for (const [key, value] of Object.entries(query.properties!)) {
          if (entity.properties[key] !== value) return false;
        }
        return true;
      });
    }

    const total = items.length;
    const paged = items.slice(query.offset, query.offset + query.limit);

    return {
      items: paged,
      total,
      hasMore: query.offset + query.limit < total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  // Fast path: server-side pagination when no client-side filters are needed.
  const countResult = await conn.submit(
    `g.V()${filterClause}.count()`,
    bindings,
  );
  const total = Number(countResult.items[0] ?? 0);

  bindings['rangeStart'] = query.offset;
  bindings['rangeEnd'] = query.offset + query.limit;
  const dataResult = await conn.submit(
    `g.V()${filterClause}.range(rangeStart, rangeEnd).valueMap(true)`,
    bindings,
  );

  const items = (dataResult.items as Record<string, unknown>[]).map(entityFromGremlin);

  return {
    items,
    total,
    hasMore: query.offset + query.limit < total,
    limit: query.limit,
    offset: query.offset,
  };
}
