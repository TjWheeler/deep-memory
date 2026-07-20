// Entity CRUD Cypher queries.
//
// Storage shape (per D4 / D6 / D15 / D22):
//   - Every entity is a `(:_Entity)` node carrying `repositoryId`, `id`,
//     `entityType`, `slug`, `label`, plus the optional / provenance scalars
//     bound by `entityToParams`. The `:_Entity` umbrella label is the ONLY
//     label written on entity nodes — writing a per-type label as well would
//     add cold-compile and steady-state overhead per distinct type (the label
//     slot cannot be parameterised, so each type produces its own plan-cache
//     entry) with no offsetting benefit, because every provider read filters
//     by the indexed `n.entityType` property.
//   - The `properties` JSON blob is the source of truth for user-supplied
//     entity properties round-trip (O1). User-supplied keys are ALSO written
//     as native Neo4j scalar properties on the node alongside the blob, so
//     `findEntities` can emit server-side `n.<key> = $val` predicates against
//     them and keep `total` exact. The CREATE template stays plan-cache-keyed
//     on a single Cypher string because `SET n += $userProperties` is one
//     fixed clause regardless of which keys are bound in the map.
//   - Values that Neo4j cannot store natively (nested objects, `null`,
//     arrays of objects, heterogeneous arrays) stay only inside the JSON
//     blob — they round-trip on `entity.properties` but are not
//     predicate-queryable. `findEntities` rejects filters against such values
//     rather than silently missing matches.
//
// Strategy:
//   - `createEntity` uses `CREATE` + catch on
//     `Neo.ClientError.Schema.ConstraintValidationFailed`, translated by
//     `mapDriverError({ kind: 'entity', ... })` to `DuplicateEntityError`.
//     A `MERGE`-with-discriminator alternative is marginally faster on the
//     happy path but mutates the existing node on every collision (writes a
//     discriminator property onto durable graph state that the caller never
//     requested) — correctness wins over the marginal perf delta.
//   - `getEntity` / `getEntityBySlug` / `getEntities` use explicit projection
//     via `buildEntityProjection` so embedding stays off the wire unless the
//     caller opts in via `EntityReadOptions.loadEmbeddings`. User-property
//     scalars on the node are not projected — `entity.properties` round-trips
//     from the JSON blob.
//   - `updateEntity` is variable-shape (D23) projection-on-write: build a
//     `SET n.<field> = $param` list from the dirty fields, then `RETURN
//     <projection>` to ship the post-SET state in one round-trip. When
//     `updates.properties !== undefined` the update pays an extra read of
//     the existing user-property key set so static REMOVE clauses can drop
//     keys that left the new shape — Cypher 25 cannot REMOVE a property
//     whose key is bound at run-time without APOC, and the provider
//     deliberately does not depend on APOC. Updates are not on the hot
//     read path.
//   - Bulk deletes return the affected ids in the same round-trip — the
//     caller computes the `notFound` set client-side from set difference,
//     avoiding a per-id existence pre-check.

import type { Neo4jConnection } from '../Neo4jConnection.js';
import type {
  PaginatedResult,
  StorageFindQuery,
  StoredEntity,
  StoredEntityUpdate,
} from '@utaba/deep-memory/types';
import type { EntityReadOptions } from '@utaba/deep-memory/providers';
import {
  assertSafeUserPropertyKey,
  bigintToSafeNumber,
  buildEntityProjection,
  entityFromRecord,
  entityToParams,
  entityUserPropertyParams,
  isNativeStorableValue,
  RESERVED_ENTITY_PROPERTY_KEYS,
} from '../mapping.js';
import { mapDriverError } from '../errors.js';
import { EntityNotFoundError, ProviderError } from '@utaba/deep-memory';

/**
 * Fixed-shape `CREATE` template — same Cypher string for every entity create
 * regardless of which optional fields are populated. The planner caches one
 * plan across every entity create in the system (D15). Computed once at
 * module load so the constant string is what the planner keys off.
 *
 * `SET n += $userProperties` writes user-supplied entity properties as native
 * Neo4j scalars in addition to the JSON-stringified `properties` blob — the
 * blob remains authoritative for round-trip while the scalars make
 * `findEntities` property predicates server-side exact. The Cypher string is
 * byte-identical regardless of which user-property keys appear in the map,
 * so the plan cache footprint stays at one entry.
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
SET n += $userProperties
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
 * Create a new entity via fixed-shape `CREATE` + catch on the uniqueness
 * constraint. Constraint-violation paths (duplicate `(repositoryId, id)` or
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
  // Validate + project user properties to the native-scalar map before the
  // round-trip. A reserved-key collision or a malformed identifier throws
  // `ProviderError` here so the surface never reaches the server.
  const userProperties = entityUserPropertyParams(entity.properties);
  try {
    await conn.executeQuery(
      ENTITY_CREATE_QUERY,
      { ...entityToParams(entity), userProperties },
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
 * same round-trip — `MATCH ... SET ... RETURN <projection>` ships the
 * post-SET values without a re-MATCH.
 *
 * Tri-state semantics map directly to Neo4j: `undefined` skips the field,
 * `null` sets the property to `null` (which Neo4j removes from the node, so
 * clearing the property is symmetric with absence on read), a value sets
 * the new value.
 *
 * When `updates.properties !== undefined` the path costs one extra read
 * round-trip ahead of the write: Cypher 25 cannot REMOVE a property whose
 * key is bound at run-time without APOC, so the TS layer must learn the
 * pre-update user-key set in order to emit static REMOVE clauses for keys
 * that left the new shape. The read+write pair is not wrapped in a managed
 * transaction — concurrent updates to the same entity can leave the native
 * scalars and the JSON blob temporarily divergent (last writer wins,
 * convergence on the next consistent write). The blob remains authoritative
 * for `entity.properties` round-trip, so the divergence affects only
 * predicate-match shape, not read shape.
 *
 * Empty record array → `EntityNotFoundError`.
 */
export async function updateEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
  updates: StoredEntityUpdate,
): Promise<StoredEntity> {
  // Validate + project the new user-property shape before any round-trip.
  // The validation throws `ProviderError` on reserved-name collision or
  // malformed identifier — the read-side round-trip is wasted work if the
  // write would have failed anyway.
  let userProperties: Record<string, unknown> | null = null;
  if (updates.properties !== undefined) {
    userProperties = entityUserPropertyParams(updates.properties);
  }

  // Native scalar keys to REMOVE on update: pre-update user-property keys
  // minus the new user-property keys that will survive as native scalars.
  // Keys that move from native-storable → non-storable (e.g. string → nested
  // object) also land in `keysToRemove` so the stale native scalar leaves.
  let keysToRemove: string[] = [];
  if (userProperties !== null) {
    const readResult = await conn.executeQuery(
      'MATCH (n:_Entity {repositoryId: $rid, id: $id}) RETURN properties(n) AS props',
      { id: entityId },
      { repositoryId, routing: 'READ' },
    );
    const readRecord = readResult.records[0];
    if (readRecord === undefined) throw new EntityNotFoundError(entityId);
    const props = readRecord.get('props');
    const existingProps =
      typeof props === 'object' && props !== null && !Array.isArray(props)
        ? (props as Record<string, unknown>)
        : {};
    const existingUserKeys = Object.keys(existingProps).filter(
      (k) => !RESERVED_ENTITY_PROPERTY_KEYS.has(k),
    );
    keysToRemove = existingUserKeys.filter((k) => !(k in userProperties!));
  }

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

  // User properties land via `SET n += $userProperties` regardless of how
  // many keys are in the map (an empty map is a no-op). The REMOVE clause
  // drops keys that left the new shape; keys are static identifiers because
  // Cypher 25 cannot bind a property name at run-time. Each key is
  // re-validated through `assertSafeUserPropertyKey` even though it came
  // from `properties(n)` — defence in depth against a pre-validation write
  // that somehow bypassed the chokepoint.
  let userPropsClause = '';
  if (userProperties !== null) {
    params['userProperties'] = userProperties;
    userPropsClause = ' SET n += $userProperties';
  }
  let removeClause = '';
  if (keysToRemove.length > 0) {
    const safeKeys = keysToRemove.map((k) => `n.${assertSafeUserPropertyKey(k)}`);
    removeClause = ` REMOVE ${safeKeys.join(', ')}`;
  }

  const cypher =
    `MATCH (n:_Entity {repositoryId: $rid, id: $id}) ` +
    `SET ${setParts.join(', ')}` +
    `${userPropsClause}` +
    `${removeClause} ` +
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

// Read-projection chains reused by `findEntities`. The non-search branch
// projects from alias `n` (`MATCH (n:_Entity) ...`); the fulltext branch
// projects from alias `node` (`CALL db.index.fulltext.queryNodes(...) YIELD
// node, score`). Both forms are precomputed at module load so the planner
// keys off byte-identical strings across calls.
const FIND_PROJECTION_LIGHT = buildEntityProjection({ alias: 'n' });
const FIND_PROJECTION_FULL = buildEntityProjection({ alias: 'n', loadEmbeddings: true });
const FIND_PROJECTION_LIGHT_FT = buildEntityProjection({ alias: 'node' });
const FIND_PROJECTION_FULL_FT = buildEntityProjection({ alias: 'node', loadEmbeddings: true });

/**
 * Compile a `StorageFindQuery` to the shared WHERE-clause fragment and its
 * parameter bag. The same fragment feeds the data and count queries so they
 * are guaranteed to count the same set by construction.
 *
 * `$rid` is bound by the chokepoint, not here. The non-search branch always
 * includes `<alias>.repositoryId = $rid` as the first predicate so the planner
 * picks the `(repositoryId, id)` uniqueness constraint's backing index. The
 * fulltext branch routes through `CALL db.index.fulltext.queryNodes(...) YIELD
 * node` first and adds `node.repositoryId = $rid` immediately after the YIELD,
 * so this helper omits the repository predicate in fulltext mode (the caller
 * emits it inline with the YIELD clause to keep the planner's per-fulltext
 * optimisations in scope).
 *
 * **Property filter semantics.** Every public field on the entity surface
 * (entity type, slug, modifiedAt, provenance scalars, AND user-supplied
 * `entity.properties` keys) is stored as a native Neo4j scalar on the node,
 * so every filter emits an exact server-side predicate. The `n.properties`
 * JSON blob round-trips the full `entity.properties` shape including values
 * Neo4j cannot store natively (nested objects, `null`, arrays of objects,
 * heterogeneous arrays); those keys are NOT predicate-queryable. Filters
 * against non-native-storable values throw `ProviderError` rather than
 * silently missing matches.
 */
export function buildFindEntitiesWhere(
  query: StorageFindQuery,
  options: { alias: string; includeRepositoryPredicate: boolean },
): { cypherWhere: string; params: Record<string, unknown> } {
  const { alias, includeRepositoryPredicate } = options;
  const params: Record<string, unknown> = {};
  const predicates: string[] = [];

  if (includeRepositoryPredicate) {
    predicates.push(`${alias}.repositoryId = $rid`);
  }

  if (query.entityTypes && query.entityTypes.length > 0) {
    predicates.push(`${alias}.entityType IN $entityTypes`);
    params['entityTypes'] = query.entityTypes;
  }

  if (query.properties) {
    let i = 0;
    for (const [key, value] of Object.entries(query.properties)) {
      // The key is interpolated into the predicate slot (Cypher 25 cannot
      // parameterise property names), so re-validate against the reserved
      // set and the bare-identifier shape on every emission.
      assertSafeUserPropertyKey(key);
      if (!isNativeStorableValue(value)) {
        throw new ProviderError(
          `findEntities property filter "${key}" has a value that Neo4j cannot store ` +
            `as a native scalar — filters must be strings, finite numbers, booleans, ` +
            `or homogeneous arrays of those. Nested objects and null values live only ` +
            `inside the JSON properties blob and are not predicate-queryable.`,
        );
      }
      const paramName = `prop${i}`;
      predicates.push(`${alias}.${key} = $${paramName}`);
      params[paramName] = value;
      i++;
    }
  }

  if (query.provenance) {
    if (query.provenance.conversationIds && query.provenance.conversationIds.length > 0) {
      predicates.push(
        `(${alias}.createdInConversation IN $convIds OR ${alias}.modifiedInConversation IN $convIds)`,
      );
      params['convIds'] = query.provenance.conversationIds;
    }
    if (query.provenance.actors && query.provenance.actors.length > 0) {
      predicates.push(
        `(${alias}.createdBy IN $actors OR ${alias}.modifiedBy IN $actors)`,
      );
      params['actors'] = query.provenance.actors;
    }
    if (query.provenance.dateRange) {
      predicates.push(
        `((${alias}.createdAt >= $dateFrom AND ${alias}.createdAt <= $dateTo) ` +
          `OR (${alias}.modifiedAt >= $dateFrom AND ${alias}.modifiedAt <= $dateTo))`,
      );
      // Timestamps are ISO-8601 strings (D6); lexicographic compare is
      // chronologically correct for the canonical Z-suffixed form.
      params['dateFrom'] = query.provenance.dateRange.from;
      params['dateTo'] = query.provenance.dateRange.to;
    }
  }

  const cypherWhere = predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : '';
  return { cypherWhere, params };
}

// Lucene classic-query metacharacters, per `QueryParserBase.escape` in the
// Lucene the fulltext index is built on. `db.index.fulltext.queryNodes` parses
// `$term` as a query expression, not a literal — so any of these characters in
// caller-supplied search text (`[`, `:`, `"`, `(`, `&`, …) is interpreted as
// query syntax and throws `ParseException` on a malformed expression. The
// backslash is included in the class so it is escaped before it can pair with a
// following character. Ordering is irrelevant: a single char-class pass
// prepends exactly one backslash to each matched character, literal backslashes
// included.
const LUCENE_SPECIAL_CHARS = /[+\-&|!(){}\[\]^"~*?:\\/]/g;

/**
 * Escape Lucene classic-query metacharacters so a caller's search string is
 * matched as literal terms rather than parsed as a query expression. Escaping
 * (not stripping) preserves every word, so relevance is unaffected — only the
 * reserved characters lose their syntactic meaning.
 *
 * This lives in the provider because Lucene-query escaping is knowledge
 * specific to the Neo4j fulltext backend: no caller of the storage surface
 * should have to know that `findEntities` routes through a Lucene index. The
 * Cosmos provider's substring search has no equivalent parse step and needs no
 * escaping.
 */
export function escapeLuceneQuery(searchTerm: string): string {
  return searchTerm.replace(LUCENE_SPECIAL_CHARS, '\\$&');
}

/**
 * Find entities matching a `StorageFindQuery`. Returns one page plus an exact
 * total via a `Promise.all([data, count])` round-trip pair — the parallel
 * shape saves ~1.5 ms over sequential and keeps each query's plan-cache
 * footprint to a single entry per query shape.
 *
 * Branches:
 * - **Search-term branch** — when `query.searchTerm` is set, both queries route
 *   through the `dm_entity_text` fulltext index via
 *   `CALL db.index.fulltext.queryNodes(...) YIELD node, score`. The fulltext
 *   index is unfiltered by repository, so the next predicate is always
 *   `node.repositoryId = $rid`. Page ordering is by score descending. A
 *   property-CONTAINS substring fallback for searchTerm was measured against
 *   the fulltext path and rejected: the fulltext path is uniformly faster at
 *   10k+ entities and only marginally slower at 1k; carrying a dual-path
 *   branch is not worth the code surface.
 * - **Non-search branch** — `MATCH (n:_Entity) WHERE n.repositoryId = $rid AND
 *   <predicates>` backed by the `(repositoryId, entityType)` and
 *   `(repositoryId, id)` indexes. Page ordering is by `n.id` to pin pagination
 *   determinism.
 *
 * Every filter — `entityTypes`, `properties`, `provenance.*`, `searchTerm` —
 * resolves to a server-side exact predicate against either an indexed scalar,
 * a native user-property scalar, or the fulltext index. `total` is always
 * exact. Property filters whose value Neo4j cannot represent as a native
 * scalar (nested objects, `null`) throw `ProviderError` at predicate-build
 * time rather than silently missing matches.
 */
export async function findEntities(
  conn: Neo4jConnection,
  repositoryId: string,
  query: StorageFindQuery,
  options?: EntityReadOptions,
): Promise<PaginatedResult<StoredEntity>> {
  const loadEmbeddings = options?.loadEmbeddings === true;
  const skipLimitParams = {
    skip: BigInt(query.offset),
    limit: BigInt(query.limit),
  };

  let records: ReadonlyArray<{ keys: ReadonlyArray<PropertyKey>; get(k: string): unknown }>;
  let countResult: { records: ReadonlyArray<{ get(k: string): unknown }> };

  if (query.searchTerm !== undefined && query.searchTerm !== '') {
    const projection = loadEmbeddings ? FIND_PROJECTION_FULL_FT : FIND_PROJECTION_LIGHT_FT;
    const where = buildFindEntitiesWhere(query, {
      alias: 'node',
      includeRepositoryPredicate: false,
    });
    // The fulltext call yields a node + score per matching document; the
    // repository predicate lands immediately after YIELD so the planner can
    // narrow the candidate set before evaluating optional predicates.
    const repoPredicate = 'node.repositoryId = $rid';
    const combinedWhere =
      where.cypherWhere.length > 0
        ? `WHERE ${repoPredicate} AND ${where.cypherWhere.slice('WHERE '.length)}`
        : `WHERE ${repoPredicate}`;
    const dataCypher =
      `CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node, score ` +
      `${combinedWhere} ` +
      `RETURN ${projection} ` +
      `ORDER BY score DESC SKIP $skip LIMIT $limit`;
    const countCypher =
      `CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node ` +
      `${combinedWhere} ` +
      `RETURN count(node) AS total`;
    const termParam = { term: escapeLuceneQuery(query.searchTerm) };
    const [dataResult, count] = await Promise.all([
      conn.executeQuery(
        dataCypher,
        { ...where.params, ...termParam, ...skipLimitParams },
        { repositoryId, routing: 'READ' },
      ),
      conn.executeQuery(
        countCypher,
        { ...where.params, ...termParam },
        { repositoryId, routing: 'READ' },
      ),
    ]);
    records = dataResult.records;
    countResult = count;
  } else {
    const projection = loadEmbeddings ? FIND_PROJECTION_FULL : FIND_PROJECTION_LIGHT;
    const where = buildFindEntitiesWhere(query, {
      alias: 'n',
      includeRepositoryPredicate: true,
    });
    const dataCypher =
      `MATCH (n:_Entity) ${where.cypherWhere} ` +
      `RETURN ${projection} ` +
      `ORDER BY n.id SKIP $skip LIMIT $limit`;
    const countCypher = `MATCH (n:_Entity) ${where.cypherWhere} RETURN count(n) AS total`;
    const [dataResult, count] = await Promise.all([
      conn.executeQuery(
        dataCypher,
        { ...where.params, ...skipLimitParams },
        { repositoryId, routing: 'READ' },
      ),
      conn.executeQuery(countCypher, where.params, { repositoryId, routing: 'READ' }),
    ]);
    records = dataResult.records;
    countResult = count;
  }

  const items = records.map((record) => entityFromRecord(record));
  const totalRaw = countResult.records[0]?.get('total');
  const total = totalRaw === undefined ? 0 : bigintToSafeNumber(totalRaw);
  const hasMore = query.offset + items.length < total;

  return {
    items,
    total,
    hasMore,
    limit: query.limit,
    offset: query.offset,
  };
}

/**
 * Delete every entity of a type plus their incident relationships, returning
 * exact counts in a single round-trip — strict improvement over the
 * `deletedRelationships: undefined` path Cosmos has to live with (Gremlin
 * `bothE().count()` would fan out across every partition the type touches).
 *
 * Counting via `sum(count{(n)-[]-()})` double-counts any edge whose two
 * endpoints are both in the matched same-type set, because each endpoint
 * sees and counts the edge independently. `OPTIONAL MATCH (n)-[r]-()` with
 * `count(DISTINCT r)` aggregates across the whole match and dedupes by
 * relationship identity, so every edge is counted exactly once.
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
