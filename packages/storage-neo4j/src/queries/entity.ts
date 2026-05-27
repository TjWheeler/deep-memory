// Entity CRUD Cypher queries.
//
// Storage shape (per D4 / D6 / D15):
//   - Every entity is a `(:_Entity)` node carrying `repositoryId`, `id`,
//     `entityType`, `slug`, `label`, plus the optional / provenance scalars
//     bound by `entityToParams`. The `:_Entity` umbrella label is the ONLY
//     label written on entity nodes — per probe P5, per-type labels add ~12 ms
//     cold compile per distinct type and ~1.2 ms steady-state per call with no
//     offsetting benefit because every provider read filters by the indexed
//     `n.entityType` property.
//   - The `properties` JSON blob is the source of truth for user-supplied
//     entity properties (O1 resolution). Per-scalar properties exist only
//     for the indexed predicates the schema cares about (entityType, slug,
//     modifiedAt) and for fulltext indexing (label, summary).
//
// Strategy (per probe P4 — locked at `local-tests/baseline/neo4j-phase6-probes-results.md`):
//   - `createEntity` uses `CREATE` + catch on
//     `Neo.ClientError.Schema.ConstraintValidationFailed`, translated by
//     `mapDriverError({ kind: 'entity', ... })` to `DuplicateEntityError`.
//     A `MERGE`-with-discriminator strategy is ~1.3 ms faster on the happy
//     path but mutates the existing node on collisions (writes a
//     `__merge_discriminator__` property that pollutes the durable graph) —
//     correctness wins over the marginal perf delta.
//   - `getEntity` / `getEntityBySlug` / `getEntities` use explicit projection
//     via `buildEntityProjection` so embedding stays off the wire unless the
//     caller opts in via `EntityReadOptions.loadEmbeddings`.
//   - `updateEntity` is variable-shape (D23) projection-on-write: build a
//     `SET n.<field> = $param` list from the dirty fields, then `RETURN
//     <projection>` to ship the post-SET state in one round-trip. Empty
//     record array → `EntityNotFoundError` (probe P6 Test 3 confirmed
//     no-match returns zero records).
//   - Bulk deletes return the affected ids in the same round-trip — the
//     caller computes the `notFound` set client-side from set difference,
//     avoiding a per-id existence pre-check.

import type { Neo4jConnection } from '../Neo4jConnection.js';
import type {
  StoredEntity,
  StoredEntityUpdate,
} from '@utaba/deep-memory/types';
import type { EntityReadOptions } from '@utaba/deep-memory/providers';
import {
  bigintToSafeNumber,
  buildEntityProjection,
  entityFromRecord,
  entityToParams,
} from '../mapping.js';
import { mapDriverError } from '../errors.js';
import { EntityNotFoundError } from '@utaba/deep-memory';

/**
 * Fixed-shape `CREATE` template — same Cypher string for every entity create
 * regardless of which optional fields are populated. The planner caches one
 * plan across every entity create in the system (D15). Computed once at
 * module load so the constant string is what the planner keys off.
 *
 * Returns `n.id AS id` only — the caller already holds the `StoredEntity` it
 * passed in and does not need the round-trip to re-materialise it.
 */
const ENTITY_CREATE_QUERY = `
CREATE (n:_Entity {
  repositoryId: $rid,
  id: $id,
  entityType: $entityType,
  label: $label,
  slug: $slug,
  summary: $summary,
  properties: $properties,
  data: $data,
  dataFormat: $dataFormat,
  embedding: $embedding,
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
})
RETURN n.id AS id
`;

// Read-projection chains are constant — compute once at module load so the
// query string fed to the planner is byte-identical across calls. Two
// variants: without and with embedding. The fulltext-index branch of
// findEntities builds its own projection (alias `node`) so it lives there.
const ENTITY_PROJECTION_LIGHT = buildEntityProjection();
const ENTITY_PROJECTION_FULL = buildEntityProjection({ loadEmbeddings: true });

const ENTITY_GET_QUERY_LIGHT = `MATCH (n:_Entity {repositoryId: $rid, id: $id}) RETURN ${ENTITY_PROJECTION_LIGHT}`;
const ENTITY_GET_QUERY_FULL = `MATCH (n:_Entity {repositoryId: $rid, id: $id}) RETURN ${ENTITY_PROJECTION_FULL}`;

const ENTITY_GET_BY_SLUG_QUERY_LIGHT = `MATCH (n:_Entity {repositoryId: $rid, slug: $slug}) RETURN ${ENTITY_PROJECTION_LIGHT}`;
const ENTITY_GET_BY_SLUG_QUERY_FULL = `MATCH (n:_Entity {repositoryId: $rid, slug: $slug}) RETURN ${ENTITY_PROJECTION_FULL}`;

// Batch get — single round-trip via `WHERE n.id IN $ids`. Caller drives any
// not-found discrimination via map lookup (the public `getEntities` contract
// returns a `Map<string, StoredEntity>` whose absent keys signal not-found).
const ENTITY_GET_MANY_QUERY_LIGHT = `MATCH (n:_Entity {repositoryId: $rid}) WHERE n.id IN $ids RETURN ${ENTITY_PROJECTION_LIGHT}`;
const ENTITY_GET_MANY_QUERY_FULL = `MATCH (n:_Entity {repositoryId: $rid}) WHERE n.id IN $ids RETURN ${ENTITY_PROJECTION_FULL}`;

/**
 * Create a new entity. Strategy A (CREATE + catch) per probe P4.
 *
 * Constraint-violation paths (duplicate `(repositoryId, id)` or
 * `(repositoryId, slug)`) surface as
 * `Neo.ClientError.Schema.ConstraintValidationFailed`, which
 * `mapDriverError` translates to `DuplicateEntityError`. The error mapping
 * picks the right kind from the `{ kind: 'entity', entityId }` context.
 */
export async function createEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entity: StoredEntity,
): Promise<StoredEntity> {
  try {
    await conn.executeQuery(
      ENTITY_CREATE_QUERY,
      entityToParams(entity),
      { repositoryId },
    );
  } catch (err) {
    mapDriverError(err, {
      kind: 'entity',
      entityId: entity.id,
      operation: 'createEntity',
    });
  }
  return entity;
}

/**
 * Read a single entity by id. Returns `null` when no row matches — the public
 * contract is `null`-on-miss, not throw.
 */
export async function getEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
  options?: EntityReadOptions,
): Promise<StoredEntity | null> {
  const query =
    options?.loadEmbeddings === true ? ENTITY_GET_QUERY_FULL : ENTITY_GET_QUERY_LIGHT;
  const result = await conn.executeQuery(
    query,
    { id: entityId },
    { repositoryId, routing: 'READ' },
  );
  const record = result.records[0];
  if (record === undefined) return null;
  return entityFromRecord(record);
}

/**
 * Read a single entity by slug. Slugs are unique within a repository via the
 * `dm_entity_slug_unique` constraint, so the lookup hits the constraint's
 * backing index. Returns `null` when no row matches.
 */
export async function getEntityBySlug(
  conn: Neo4jConnection,
  repositoryId: string,
  slug: string,
  options?: EntityReadOptions,
): Promise<StoredEntity | null> {
  const query =
    options?.loadEmbeddings === true
      ? ENTITY_GET_BY_SLUG_QUERY_FULL
      : ENTITY_GET_BY_SLUG_QUERY_LIGHT;
  const result = await conn.executeQuery(
    query,
    { slug },
    { repositoryId, routing: 'READ' },
  );
  const record = result.records[0];
  if (record === undefined) return null;
  return entityFromRecord(record);
}

/**
 * Batch read by ids. Single round-trip via `WHERE n.id IN $ids`; absent ids
 * simply don't appear in the returned `Map`. Empty input → empty map, no
 * round-trip.
 */
export async function getEntities(
  conn: Neo4jConnection,
  repositoryId: string,
  entityIds: string[],
  options?: EntityReadOptions,
): Promise<Map<string, StoredEntity>> {
  const map = new Map<string, StoredEntity>();
  if (entityIds.length === 0) return map;

  const query =
    options?.loadEmbeddings === true
      ? ENTITY_GET_MANY_QUERY_FULL
      : ENTITY_GET_MANY_QUERY_LIGHT;
  const result = await conn.executeQuery(
    query,
    { ids: entityIds },
    { repositoryId, routing: 'READ' },
  );
  for (const record of result.records) {
    const entity = entityFromRecord(record);
    map.set(entity.id, entity);
  }
  return map;
}

/**
 * Variable-shape projection-on-write update (D23). Builds a `SET n.<field> =
 * $param` clause per dirty field, then projects the post-SET state in the
 * same round-trip — probe P6 confirmed `MATCH ... SET ... RETURN <projection>`
 * ships the post-SET values without a re-MATCH.
 *
 * Tri-state semantics map directly to Neo4j: `undefined` skips the field,
 * `null` sets the property to `null` (which Neo4j removes from the node — P6
 * Test 4 confirmed), a value sets the new value.
 *
 * Empty record array → `EntityNotFoundError`.
 */
export async function updateEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
  updates: StoredEntityUpdate,
): Promise<StoredEntity> {
  const setParts: string[] = [];
  const params: Record<string, unknown> = { id: entityId };

  const setField = (key: string, paramName: string, value: unknown): void => {
    setParts.push(`n.${key} = $${paramName}`);
    params[paramName] = value;
  };

  if (updates.entityType !== undefined) setField('entityType', 'entityType', updates.entityType);
  if (updates.label !== undefined) setField('label', 'label', updates.label);
  if (updates.slug !== undefined) setField('slug', 'slug', updates.slug);
  // `summary === null` clears the property (Neo4j removes null-valued props).
  if (updates.summary !== undefined) setField('summary', 'summary', updates.summary);
  if (updates.properties !== undefined) {
    setField('properties', 'properties', JSON.stringify(updates.properties));
  }
  if (updates.data !== undefined) setField('data', 'data', updates.data);
  if (updates.dataFormat !== undefined) setField('dataFormat', 'dataFormat', updates.dataFormat);
  if (updates.embedding !== undefined) setField('embedding', 'embedding', updates.embedding);

  // Provenance always lands — modifications carry the updated `modifiedBy*` /
  // `modifiedAt` regardless of which content fields changed. The optional
  // conversation/message fields use the same `undefined` skips / value sets
  // / null clears semantic; absence on the input preserves the existing
  // property unchanged.
  const p = updates.provenance;
  setField('modifiedBy', 'modifiedBy', p.modifiedBy);
  setField('modifiedByType', 'modifiedByType', p.modifiedByType);
  setField('modifiedAt', 'modifiedAt', p.modifiedAt);
  if (p.modifiedInConversation !== undefined) {
    setField('modifiedInConversation', 'modifiedInConversation', p.modifiedInConversation);
  }
  if (p.modifiedFromMessage !== undefined) {
    setField('modifiedFromMessage', 'modifiedFromMessage', p.modifiedFromMessage);
  }

  const cypher =
    `MATCH (n:_Entity {repositoryId: $rid, id: $id}) ` +
    `SET ${setParts.join(', ')} ` +
    `RETURN ${ENTITY_PROJECTION_LIGHT}`;

  const result = await conn.executeQuery(cypher, params, { repositoryId });
  const record = result.records[0];
  if (record === undefined) throw new EntityNotFoundError(entityId);
  return entityFromRecord(record);
}

/**
 * Delete a single entity and its incident relationships (`DETACH DELETE`).
 *
 * `RETURN count(n)` distinguishes match-not-found (0) from match-and-delete
 * (1) without a separate existence check. Counts ≠ 1 → `EntityNotFoundError`
 * — covers both the no-match case and the (impossible-in-practice) duplicate
 * case if the uniqueness constraint were somehow circumvented.
 */
export async function deleteEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
): Promise<void> {
  const result = await conn.executeQuery(
    'MATCH (n:_Entity {repositoryId: $rid, id: $id}) DETACH DELETE n RETURN count(n) AS deleted',
    { id: entityId },
    { repositoryId },
  );
  const deleted = bigintToSafeNumber(result.records[0]?.get('deleted') ?? 0);
  if (deleted !== 1) throw new EntityNotFoundError(entityId);
}

/**
 * Bulk delete by ids — single round-trip. Returns the ids actually deleted
 * (drawn from the `DETACH DELETE` operator's RETURN slice); the caller
 * computes the `notFound` set via set difference against the input ids.
 *
 * Empty input → empty result, no round-trip.
 */
export async function deleteEntities(
  conn: Neo4jConnection,
  repositoryId: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  if (ids.length === 0) return { deleted: [], notFound: [] };
  const result = await conn.executeQuery(
    'MATCH (n:_Entity {repositoryId: $rid}) WHERE n.id IN $ids ' +
      'WITH n, n.id AS id DETACH DELETE n RETURN id AS deleted',
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
 * Delete every entity of a type plus their incident relationships, returning
 * exact counts in a single round-trip — strict improvement over the
 * `deletedRelationships: undefined` path Cosmos has to live with (Gremlin
 * `bothE().count()` would fan out across every partition the type touches).
 *
 * Counting via `sum(count{(n)-[]-()})` double-counts edges incident to two
 * same-type entities (an ancillary shape-probe at
 * `local-tests/neo4j-delete-with-count-shape-probe.mjs` confirmed: 3 People
 * with 2 KNOWS edges between them plus 1 LIVES_IN to a Place reported
 * `rels=5` instead of `rels=3`). The fix is `OPTIONAL MATCH (n)-[r]-()`
 * with `count(DISTINCT r)` so each edge is counted once even when both
 * endpoints are in the matched set.
 *
 * Aggregating before the delete (Cypher loses access to deleted variables in
 * a downstream RETURN) requires running the delete inside a `CALL` subquery
 * so the outer query can still RETURN the pre-aggregated counts.
 */
export async function deleteEntitiesByType(
  conn: Neo4jConnection,
  repositoryId: string,
  entityType: string,
): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
  const result = await conn.executeQuery(
    `MATCH (n:_Entity {repositoryId: $rid, entityType: $entityType})
     OPTIONAL MATCH (n)-[r]-()
     WITH collect(DISTINCT n) AS nodes,
          count(DISTINCT n) AS entities,
          count(DISTINCT r) AS rels
     CALL (nodes) {
       UNWIND nodes AS node
       DETACH DELETE node
     }
     RETURN entities, rels`,
    { entityType },
    { repositoryId },
  );
  const record = result.records[0];
  if (record === undefined) {
    return { deletedEntities: 0, deletedRelationships: 0 };
  }
  const deletedEntities = bigintToSafeNumber(record.get('entities') ?? 0);
  const deletedRelationships = bigintToSafeNumber(record.get('rels') ?? 0);
  return { deletedEntities, deletedRelationships };
}
