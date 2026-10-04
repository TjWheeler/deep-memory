// Entity CRUD Cypher queries.
//
// Storage shape:
//   - Every entity is a `(:_Entity)` node carrying `repositoryId`, `id`,
//     `entityType`, `slug`, `label`, plus the optional / provenance scalars
//     bound by `entityToParams`. The `:_Entity` umbrella label is the ONLY
//     label written on entity nodes — writing a per-type label as well would
//     add cold-compile and steady-state overhead per distinct type (the label
//     slot cannot be parameterised, so each type produces its own plan-cache
//     entry) with no offsetting benefit, because every provider read filters
//     by the indexed `n.entityType` property.
//   - The `properties` JSON blob is the source of truth for user-supplied
//     entity properties round-trip. User-supplied keys are ALSO written
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
//     `mapDriverError` to `DuplicateEntityError` (id clash) or
//     `SlugConflictError` (slug clash).
//     A `MERGE`-with-discriminator alternative is marginally faster on the
//     happy path but mutates the existing node on every collision (writes a
//     discriminator property onto durable graph state that the caller never
//     requested) — correctness wins over the marginal perf delta. The same
//     statement matches the `_Repository` node first, so a create against a
//     deleted repository writes nothing and surfaces `RepositoryNotFoundError`.
//   - `getEntity` / `getEntityBySlug` / `getEntities` use explicit projection
//     via `buildEntityProjection` so embedding stays off the wire unless the
//     caller opts in via `EntityReadOptions.loadEmbeddings`. User-property
//     scalars on the node are not projected — `entity.properties` round-trips
//     from the JSON blob.
//   - `updateEntity` is variable-shape projection-on-write: build a
//     `SET n.<field> = $param` list from the dirty fields, then `RETURN
//     <projection>` to ship the post-SET state in one round-trip. When
//     `updates.properties !== undefined` the update pays an extra read of
//     the existing user-property key set so static REMOVE clauses can drop
//     keys that left the new shape — Cypher 25 cannot REMOVE a property
//     whose key is bound at run-time without APOC, and the provider
//     deliberately does not depend on APOC. Updates are not on the hot
//     read path. A slug change that trips `dm_entity_slug_unique` is
//     translated by `mapDriverError` to `SlugConflictError`.
//   - Bulk deletes return the affected ids in the same round-trip — the
//     caller computes the `notFound` set client-side from set difference,
//     avoiding a per-id existence pre-check.

import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
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
  type DriverRecord,
  entityFromRecord,
  entityToParams,
  entityUpdatePropertyParams,
  entityUserPropertyParams,
  parsePropertiesBlob,
  isNativeStorableValue,
  WRITE_ATTEMPT_PROPERTY,
} from '../mapping.js';
import {
  isDeletedEntityFailure,
  isRetryableTransientFailure,
  mapDriverError,
  settledValue,
  toTypedError,
} from '../errors.js';
import { LOCK_REPOSITORY_MARKER } from './repositoryLock.js';
import { deleteByIds } from './deleteByIds.js';
import {
  DuplicateEntityError,
  EntityNotFoundError,
  InvalidInputError,
  ProviderError,
  RepositoryNotFoundError,
  SlugConflictError,
  propertyNameRefusal,
} from '@utaba/deep-memory';

/**
 * Fixed-shape `CREATE` template — same Cypher string for every entity create
 * regardless of which optional fields are populated. The planner caches one
 * plan across every entity create in the system. Computed once at
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
 *
 * The node carries the call's write token (`WRITE_ATTEMPT_PROPERTY`), which
 * lets `createEntity` recognise its own committed write when the driver
 * re-runs the statement.
 *
 * The statement opens with `LOCK_REPOSITORY_MARKER`: it write-locks the
 * `_Repository` marker and continues only while the marker still exists.
 * When the marker is absent, or `deleteRepository` deleted it while this
 * statement waited for the lock, no row reaches the `CREATE` and nothing is
 * written. Otherwise the lock is held to commit, so a concurrent
 * `deleteRepository` waits for this create and its drain then removes the
 * entity. Either way no entity outlives its repository.
 */
const ENTITY_CREATE_QUERY = `${LOCK_REPOSITORY_MARKER}
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
  modifiedFromMessage: $modifiedFromMessage,
  ${WRITE_ATTEMPT_PROPERTY}: $writeAttempt
})
SET n += $userProperties
RETURN n.id AS id
`;

/**
 * Read back the write token of the entity stored under an id, after a
 * create was refused by a uniqueness constraint.
 */
const ENTITY_WRITE_ATTEMPT_QUERY = `MATCH (n:_Entity {repositoryId: $rid, id: $id}) RETURN n.${WRITE_ATTEMPT_PROPERTY} AS writeAttempt`;

// Read-projection chains are constant — compute once at module load so the
// query string fed to the planner is byte-identical across calls. Two
// variants: without and with embedding. The fulltext-index branch of
// findEntities builds its own projection (alias `node`) so it lives there.
const ENTITY_PROJECTION_LIGHT = buildEntityProjection();
const ENTITY_PROJECTION_FULL = buildEntityProjection({ loadEmbeddings: true });

/**
 * Opening of every entity read: the repository marker, a seek of its unique
 * constraint index. The match is optional so the statement returns a row
 * whether or not the marker exists, and the entity match after it carries
 * `WHERE repo IS NOT NULL`, so a deleted repository reads as deleted
 * (`repositoryExists` false) rather than as a missing entity, even while a
 * delete still in progress has left entities behind.
 */
const ENTITY_READ_MARKER = 'OPTIONAL MATCH (repo:_Repository {repositoryId: $rid}) ';

/** Columns ahead of the entity projection on every entity read row. */
const ENTITY_READ_FLAGS = 'repo IS NOT NULL AS repositoryExists, n IS NOT NULL AS entityFound';

/**
 * Single read by id: the marker, then the entity through the
 * `(repositoryId, id)` unique index. Always one row.
 */
export const ENTITY_GET_QUERY_LIGHT =
  `${ENTITY_READ_MARKER}OPTIONAL MATCH (n:_Entity {repositoryId: $rid, id: $id}) WHERE repo IS NOT NULL ` +
  `RETURN ${ENTITY_READ_FLAGS}, ${ENTITY_PROJECTION_LIGHT}`;
const ENTITY_GET_QUERY_FULL =
  `${ENTITY_READ_MARKER}OPTIONAL MATCH (n:_Entity {repositoryId: $rid, id: $id}) WHERE repo IS NOT NULL ` +
  `RETURN ${ENTITY_READ_FLAGS}, ${ENTITY_PROJECTION_FULL}`;

/**
 * Single read by slug: the marker, then the entity through the
 * `(repositoryId, slug)` unique index. Always one row.
 */
export const ENTITY_GET_BY_SLUG_QUERY_LIGHT =
  `${ENTITY_READ_MARKER}OPTIONAL MATCH (n:_Entity {repositoryId: $rid, slug: $slug}) WHERE repo IS NOT NULL ` +
  `RETURN ${ENTITY_READ_FLAGS}, ${ENTITY_PROJECTION_LIGHT}`;
const ENTITY_GET_BY_SLUG_QUERY_FULL =
  `${ENTITY_READ_MARKER}OPTIONAL MATCH (n:_Entity {repositoryId: $rid, slug: $slug}) WHERE repo IS NOT NULL ` +
  `RETURN ${ENTITY_READ_FLAGS}, ${ENTITY_PROJECTION_FULL}`;

/**
 * Batch read: the marker, then each id through the `(repositoryId, id)`
 * unique index. One row per entity found, or a single row with
 * `entityFound` false when none is (including for an empty id list), so the
 * marker is reported either way. The caller drives not-found discrimination
 * via map lookup (absent keys in the returned `Map` signal not-found).
 */
export const ENTITY_GET_MANY_QUERY_LIGHT =
  `${ENTITY_READ_MARKER}OPTIONAL MATCH (n:_Entity {repositoryId: $rid}) WHERE repo IS NOT NULL AND n.id IN $ids ` +
  `RETURN ${ENTITY_READ_FLAGS}, ${ENTITY_PROJECTION_LIGHT}`;
const ENTITY_GET_MANY_QUERY_FULL =
  `${ENTITY_READ_MARKER}OPTIONAL MATCH (n:_Entity {repositoryId: $rid}) WHERE repo IS NOT NULL AND n.id IN $ids ` +
  `RETURN ${ENTITY_READ_FLAGS}, ${ENTITY_PROJECTION_FULL}`;

/**
 * Create a new entity via fixed-shape `CREATE` + catch on the uniqueness
 * constraints. A duplicate `(repositoryId, id)` or `(repositoryId, slug)`
 * surfaces as `Neo.ClientError.Schema.ConstraintValidationFailed`, which
 * `mapDriverError` translates by the constraint that fired:
 * `DuplicateEntityError` for the id, `SlugConflictError` for the slug (the
 * engine retries that one with the next free slug).
 *
 * Either refusal is answered as success when the entity stored under this
 * call's id carries this call's write token: the driver re-ran a create
 * whose first run committed but whose acknowledgement was lost.
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
  const writeAttempt = randomUUID();
  let nodesCreated = 0;
  try {
    const result = await conn.executeQuery(
      ENTITY_CREATE_QUERY,
      { ...entityToParams(entity), userProperties, writeAttempt },
      { repositoryId },
    );
    nodesCreated = result.summary.counters.updates()['nodesCreated'] ?? 0;
  } catch (err) {
    // The only node this statement locks or writes before its CREATE is the
    // repository marker, so a server that refuses the lock on a marker
    // deleted while the statement waited is reporting a deleted repository.
    if (isDeletedEntityFailure(err)) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    const refusal = toTypedError(err, {
      kind: 'entity',
      entityId: entity.id,
      slug: entity.slug,
      entityType: entity.entityType,
      label: entity.label,
      operation: 'createEntity',
    });
    // The driver re-runs a statement whose commit acknowledgement was lost.
    // The re-run then trips the id constraint, or the slug constraint first,
    // on the entity its own first run committed. The entity stored under this
    // call's id carrying this call's token proves that, and the create
    // succeeded; any other token is a genuine clash. A concurrent delete of
    // the entity between the refusal and the read-back leaves no token to
    // read, so the refusal stands.
    if (
      (refusal instanceof DuplicateEntityError || refusal instanceof SlugConflictError) &&
      (await readEntityWriteAttempt(conn, repositoryId, entity.id)) === writeAttempt
    ) {
      return entity;
    }
    throw refusal;
  }
  // The repository marker is missing, or was deleted while the statement
  // waited for its lock, so the CREATE never ran.
  if (nodesCreated === 0) throw new RepositoryNotFoundError(repositoryId);
  return entity;
}

/**
 * The write token on the entity stored under `entityId`, or `null` when no
 * entity has that id or it carries no token (one written before tokens were
 * recorded, or by an upsert import). Runs on the write route so it sees the
 * commit that refused the create.
 */
export async function readEntityWriteAttempt(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
): Promise<string | null> {
  let result: Awaited<ReturnType<typeof conn.executeQuery>>;
  try {
    result = await conn.executeQuery(ENTITY_WRITE_ATTEMPT_QUERY, { id: entityId }, { repositoryId });
  } catch (err) {
    mapDriverError(err, { entityId, operation: 'createEntity' });
  }
  const value: unknown = result.records[0]?.get('writeAttempt');
  return typeof value === 'string' ? value : null;
}

/**
 * The entities on the rows of an entity read (`ENTITY_READ_FLAGS` ahead of
 * the projection). Throws `RepositoryNotFoundError` when the marker is
 * absent; a statement that returned no row at all is a provider fault.
 */
function entitiesFromReadRows(
  records: ReadonlyArray<DriverRecord>,
  repositoryId: string,
): StoredEntity[] {
  const first = records[0];
  if (first === undefined) throw new ProviderError('Neo4j entity read returned no row.');
  if (first.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  return records.filter((record) => record.get('entityFound') === true).map((record) => entityFromRecord(record));
}

/**
 * Read a single entity by id. Returns `null` when no entity has the id;
 * throws `RepositoryNotFoundError` when the repository marker is absent.
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
  return entitiesFromReadRows(result.records, repositoryId)[0] ?? null;
}

/**
 * Read a single entity by slug. Slugs are unique within a repository via the
 * `dm_entity_slug_unique` constraint, so the lookup hits the constraint's
 * backing index. Returns `null` when no entity has the slug; throws
 * `RepositoryNotFoundError` when the repository marker is absent.
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
  return entitiesFromReadRows(result.records, repositoryId)[0] ?? null;
}

/**
 * Batch read by ids. Single round-trip via `WHERE n.id IN $ids`; absent ids
 * simply don't appear in the returned `Map`. Throws
 * `RepositoryNotFoundError` when the repository marker is absent. Empty
 * input still reads the marker, so a deleted repository is reported for an
 * empty list too.
 */
export async function getEntities(
  conn: Neo4jConnection,
  repositoryId: string,
  entityIds: string[],
  options?: EntityReadOptions,
): Promise<Map<string, StoredEntity>> {
  const query =
    options?.loadEmbeddings === true
      ? ENTITY_GET_MANY_QUERY_FULL
      : ENTITY_GET_MANY_QUERY_LIGHT;
  const result = await conn.executeQuery(
    query,
    { ids: entityIds },
    { repositoryId, routing: 'READ' },
  );
  const map = new Map<string, StoredEntity>();
  for (const entity of entitiesFromReadRows(result.records, repositoryId)) {
    map.set(entity.id, entity);
  }
  return map;
}

/**
 * Match clause shared by `updateEntity`'s pre-read and write: the repository
 * marker (a seek of its unique constraint index) and, only when the marker
 * exists, the entity (a seek of the `(repositoryId, id)` index). Both are
 * optional, so the statement returns one row in every case and `n` is null
 * when either is missing.
 */
export const UPDATE_ENTITY_MATCH =
  'OPTIONAL MATCH (repo:_Repository {repositoryId: $rid}) ' +
  'OPTIONAL MATCH (n:_Entity {repositoryId: $rid, id: $id}) WHERE repo IS NOT NULL';

/**
 * Variable-shape projection-on-write update. Builds a `SET n.<field> =
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
 * Both statements match the repository marker alongside the entity
 * (`UPDATE_ENTITY_MATCH`). A missing marker → `RepositoryNotFoundError`,
 * checked first, so an entity left behind by a delete still in progress is
 * not written. Otherwise a missing entity → `EntityNotFoundError`, and a slug
 * change that collides with another entity's slug → `SlugConflictError`.
 */
export async function updateEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
  updates: StoredEntityUpdate,
): Promise<StoredEntity> {
  // The user-property shape is validated and projected once the pre-read
  // has returned the stored properties: key rules apply only to keys the
  // update writes (new, or with a changed value), so a key stored before the
  // rules existed and carried over unchanged does not block the update. See
  // `entityUpdatePropertyParams`.
  //
  // Native scalar keys to REMOVE on update: pre-update user-property keys
  // minus the new user-property keys that will survive as native scalars.
  // Keys that move from native-storable → non-storable (e.g. string → nested
  // object) also land in `keysToRemove` so the stale native scalar leaves.
  // A native key the rules refuse is never named in a REMOVE: its name
  // cannot be written into query text, and a reserved name is a system field.
  let userProperties: Record<string, unknown> | null = null;
  let keysToRemove: string[] = [];
  if (updates.properties !== undefined) {
    const readResult = await conn.executeQuery(
      `${UPDATE_ENTITY_MATCH} RETURN repo IS NOT NULL AS repositoryExists, properties(n) AS props`,
      { id: entityId },
      { repositoryId, routing: 'READ' },
    );
    const readRecord = readResult.records[0];
    if (readRecord === undefined) throw new ProviderError('Neo4j entity property read returned no row.');
    if (readRecord.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
    const props: unknown = readRecord.get('props');
    if (props === null) throw new EntityNotFoundError(entityId);
    const existingProps =
      typeof props === 'object' && props !== null && !Array.isArray(props)
        ? (props as Record<string, unknown>)
        : {};
    const projected = entityUpdatePropertyParams(updates.properties, parsePropertiesBlob(existingProps));
    userProperties = projected;
    const existingUserKeys = Object.keys(existingProps).filter(
      (k) => propertyNameRefusal(k, 'entity') === undefined,
    );
    keysToRemove = existingUserKeys.filter((k) => !(k in projected));
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

  // With no marker, or no entity, `n` is null and every SET / REMOVE on it is
  // a no-op; the flags in the returned row say which outcome applies.
  const cypher =
    `${UPDATE_ENTITY_MATCH} ` +
    `SET ${setParts.join(', ')}` +
    `${userPropsClause}` +
    `${removeClause} ` +
    `RETURN repo IS NOT NULL AS repositoryExists, n IS NOT NULL AS entityFound, ${ENTITY_PROJECTION_LIGHT}`;

  // A slug change can violate `dm_entity_slug_unique`. No `kind` is passed:
  // a violation the mapping cannot identify becomes a ProviderError (with the
  // driver error as cause) rather than being guessed at.
  let result: Awaited<ReturnType<typeof conn.executeQuery>>;
  try {
    result = await conn.executeQuery(cypher, params, { repositoryId });
  } catch (err) {
    mapDriverError(err, {
      entityId,
      slug: updates.slug,
      entityType: updates.entityType,
      label: updates.label,
      operation: 'updateEntity',
    });
  }
  const record = result.records[0];
  if (record === undefined) throw new ProviderError('Neo4j entity update returned no row.');
  if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  if (record.get('entityFound') !== true) throw new EntityNotFoundError(entityId);
  return entityFromRecord(record);
}

/**
 * Delete entities by id, only while the repository marker exists. The marker
 * is a seek of its unique constraint index and each id a seek of the
 * `(repositoryId, id)` index. The subquery aggregates, so the statement
 * returns exactly one row (`repositoryExists`, `deleted`) whether or not
 * anything matched; with no marker the subquery deletes nothing.
 */
export const ENTITY_DELETE_MANY_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
CALL (repo) {
  MATCH (n:_Entity {repositoryId: $rid})
  WHERE repo IS NOT NULL AND n.id IN $ids
  WITH n, n.id AS id
  DETACH DELETE n
  RETURN collect(id) AS deleted
}
RETURN repo IS NOT NULL AS repositoryExists, deleted`;

/**
 * Delete a single entity and its incident relationships (`DETACH DELETE`).
 *
 * Runs the bulk delete statement for one id through `deleteByIds`, so a
 * re-run by the driver after a commit whose acknowledgement was lost still
 * answers success: the entity the first attempt deleted counts as deleted
 * rather than as missing. A missing repository marker →
 * `RepositoryNotFoundError`; otherwise an id no attempt found →
 * `EntityNotFoundError`.
 */
export async function deleteEntity(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
): Promise<void> {
  const { notFound } = await deleteByIds(conn, repositoryId, ENTITY_DELETE_MANY_QUERY, [entityId], 'deleteEntity');
  if (notFound.length > 0) throw new EntityNotFoundError(entityId);
}

/**
 * Bulk delete by ids — single statement. Returns the ids actually deleted
 * (collected from the `DETACH DELETE` rows); the `notFound` set is the set
 * difference against the input ids. `deleteByIds` keeps the answer right
 * when the driver re-runs a delete whose commit succeeded, and throws
 * `RepositoryNotFoundError` when the repository marker is absent.
 *
 * Empty input deletes nothing but still reads the marker, so a deleted
 * repository is reported for an empty list too.
 */
export async function deleteEntities(
  conn: Neo4jConnection,
  repositoryId: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  return deleteByIds(conn, repositoryId, ENTITY_DELETE_MANY_QUERY, ids, 'deleteEntities');
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
 * opens with `<alias>.repositoryId = $rid AND <alias>.id IS NOT NULL` so the
 * planner can seek the `(repositoryId, id)` uniqueness constraint's backing
 * index: a bare `repositoryId` predicate has no index to use and scans every
 * `_Entity` in the database. The
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
    predicates.push(`${alias}.repositoryId = $rid`, `${alias}.id IS NOT NULL`);
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
      // Timestamps are ISO-8601 strings; lexicographic compare is
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
 * How the search-term branch of `findEntities` orders its hits.
 *
 * - `'relevance'` orders by the full-text score, descending. The score comes
 *   from one index over every repository in the database, and its term
 *   statistics (how common a word is) are computed over that whole index, so
 *   the order of one repository's hits can shift with other repositories'
 *   data. Only the order carries that signal; the hits and the total are the
 *   repository's own.
 * - `'isolated'` filters the hits to the repository and orders them by
 *   `label`, then `id`. No score reaches the order, so nothing computed from
 *   other repositories' data does either. Matching itself still runs against
 *   the whole index, so a search's cost still grows with the database.
 */
export type Neo4jSearchScoring = 'relevance' | 'isolated';

/**
 * The scoring mode a provider config asks for: `'relevance'` when unset. Any
 * other value (a host passing an untyped config) is refused at construction
 * with `InvalidInputError`, rather than quietly falling back to an order the
 * host did not choose.
 */
export function resolveSearchScoring(value: Neo4jSearchScoring | undefined): Neo4jSearchScoring {
  if (value === undefined) return 'relevance';
  if (value === 'relevance' || value === 'isolated') return value;
  throw new InvalidInputError(
    'searchScoring',
    `Neo4j searchScoring must be 'relevance' or 'isolated', got ${JSON.stringify(value)}.`,
  );
}

/**
 * The search-term branch's data statement for a scoring mode. `where` is the
 * complete `WHERE` clause, repository predicate first; `projection` reads
 * from `node`. Each mode is handled explicitly; any other value throws, so
 * an unknown mode can never reach the score order.
 */
export function buildFulltextFindQuery(scoring: Neo4jSearchScoring, where: string, projection: string): string {
  if (scoring === 'isolated') {
    return (
      `CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node ` +
      `${where} ` +
      `RETURN ${projection} ` +
      `ORDER BY node.label, node.id SKIP $skip LIMIT $limit`
    );
  }
  if (scoring === 'relevance') {
    return (
      `CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node, score ` +
      `${where} ` +
      `RETURN ${projection} ` +
      `ORDER BY score DESC SKIP $skip LIMIT $limit`
    );
  }
  throw new InvalidInputError(
    'searchScoring',
    `Neo4j searchScoring must be 'relevance' or 'isolated', got ${JSON.stringify(scoring)}.`,
  );
}

/**
 * The non-search branch's data statement. `where` is the complete `WHERE`
 * clause from `buildFindEntitiesWhere` (repository predicates first);
 * `projection` reads from `n`.
 */
export function buildMatchFindQuery(where: string, projection: string): string {
  return `MATCH (n:_Entity) ${where} RETURN ${projection} ORDER BY n.id SKIP $skip LIMIT $limit`;
}

/**
 * The count statement of either branch, which also reports whether the
 * repository marker exists. `match` is the branch's reading clause and its
 * `WHERE` (`MATCH (n:_Entity) WHERE …` or the fulltext `CALL … YIELD node
 * WHERE …`), and `alias` the variable it binds. The marker is a seek of its
 * unique constraint index; the subquery skips the match when the marker is
 * absent and aggregates, so the statement returns exactly one row either way.
 */
export function buildFindCountQuery(match: string, alias: 'n' | 'node'): string {
  return (
    'OPTIONAL MATCH (repo:_Repository {repositoryId: $rid}) ' +
    `CALL (repo) { WITH repo WHERE repo IS NOT NULL ${match} RETURN count(${alias}) AS total } ` +
    'RETURN repo IS NOT NULL AS repositoryExists, total'
  );
}

/**
 * Find entities matching a `StorageFindQuery`. Returns one page plus an exact
 * total via a `Promise.allSettled([data, count])` round-trip pair — the parallel
 * shape saves ~1.5 ms over sequential and keeps each query's plan-cache
 * footprint to a single entry per query shape.
 *
 * Branches:
 * - **Search-term branch** — when `query.searchTerm` is set, both queries route
 *   through the `dm_entity_text` fulltext index via
 *   `CALL db.index.fulltext.queryNodes(...) YIELD node, score`. The fulltext
 *   index is unfiltered by repository, so the next predicate is always
 *   `node.repositoryId = $rid`. Page ordering follows `searchScoring` (see
 *   `Neo4jSearchScoring`): score descending by default, or `label, id`. A
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
 *
 * The count statement also reads the repository marker (`buildFindCountQuery`),
 * so a deleted repository throws `RepositoryNotFoundError` rather than
 * reporting an empty page, even while a delete still in progress has left
 * entities behind. The marker rides on the count because that statement
 * always runs and always returns one row; the data statement returns one row
 * per entity on the page and none for an empty one.
 */
export async function findEntities(
  conn: Neo4jConnection,
  repositoryId: string,
  query: StorageFindQuery,
  options: EntityReadOptions | undefined,
  searchScoring: Neo4jSearchScoring,
): Promise<PaginatedResult<StoredEntity>> {
  const loadEmbeddings = options?.loadEmbeddings === true;
  const skipLimitParams = {
    skip: BigInt(query.offset),
    limit: BigInt(query.limit),
  };

  let dataSettled: PromiseSettledResult<Awaited<ReturnType<Neo4jConnection['executeQuery']>>>;
  let countSettled: PromiseSettledResult<Awaited<ReturnType<Neo4jConnection['executeQuery']>>>;

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
    const dataCypher = buildFulltextFindQuery(searchScoring, combinedWhere, projection);
    const countCypher = buildFindCountQuery(
      `CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node ${combinedWhere}`,
      'node',
    );
    const termParam = { term: escapeLuceneQuery(query.searchTerm) };
    [dataSettled, countSettled] = await Promise.allSettled([
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
  } else {
    const projection = loadEmbeddings ? FIND_PROJECTION_FULL : FIND_PROJECTION_LIGHT;
    const where = buildFindEntitiesWhere(query, {
      alias: 'n',
      includeRepositoryPredicate: true,
    });
    const dataCypher = buildMatchFindQuery(where.cypherWhere, projection);
    const countCypher = buildFindCountQuery(`MATCH (n:_Entity) ${where.cypherWhere}`, 'n');
    [dataSettled, countSettled] = await Promise.allSettled([
      conn.executeQuery(
        dataCypher,
        { ...where.params, ...skipLimitParams },
        { repositoryId, routing: 'READ' },
      ),
      conn.executeQuery(countCypher, where.params, { repositoryId, routing: 'READ' }),
    ]);
  }

  // The count carries the marker check, so a missing repository is reported
  // ahead of a failed page.
  const context = { repositoryId, operation: 'findEntities' };
  const countRecord = settledValue(countSettled, context).records[0];
  if (countRecord === undefined) throw new ProviderError('Neo4j entity count returned no row.');
  if (countRecord.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  const items = settledValue(dataSettled, context).records.map((record) => entityFromRecord(record));
  const total = bigintToSafeNumber(countRecord.get('total') ?? 0);
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
 * One batch of a type delete, only while the repository marker exists. The
 * marker is a seek of its unique constraint index and the entities a seek of
 * the `(repositoryId, entityType)` index.
 *
 * The statement takes up to `$batchSize` entities of the type and up to
 * `$edgeCap` of their incident relationships, expanded from those entities
 * (`DISTINCT`, so an edge between two of them, or a self-loop, is taken
 * once), and deletes the edges. Only when it took fewer than `$edgeCap`
 * edges, so the batch's entities have none left, does it delete the
 * entities too; `DETACH` still removes an edge a concurrent create attached
 * after the expansion. A batch at the cap deletes no entity, and the caller
 * runs the next batch to take more edges. However many edges a hub entity
 * has, no statement deletes more than `$edgeCap` edges and `$batchSize`
 * entities, so one statement cannot outgrow the transaction memory limit or
 * the server timeout and then fail again on every resend.
 *
 * Both lists are collected in subqueries that aggregate, so the statement
 * returns exactly one row whatever matched: `repositoryExists`, the number
 * of edges it took as `edges`, and the number of entities it deleted as
 * `entities` (both zero when the marker is missing). The relationships and
 * nodes removed, including any `DETACH` removed, are on the update counters.
 * One transaction does all of the statement's deleting, so it either
 * commits whole or leaves nothing deleted. `$batchSize` and `$edgeCap` must
 * be bound as BigInts so each `LIMIT` sees a Cypher INTEGER.
 */
export const ENTITY_DELETE_BY_TYPE_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
CALL (repo) {
  MATCH (n:_Entity {repositoryId: $rid, entityType: $entityType})
  WHERE repo IS NOT NULL
  WITH n LIMIT $batchSize
  RETURN collect(n) AS batch
}
CALL (batch) {
  UNWIND batch AS n
  MATCH (n)-[r]-()
  WITH DISTINCT r LIMIT $edgeCap
  RETURN collect(r) AS edges
}
WITH repo, batch, edges, size(edges) AS edgeCount
WITH repo, edges, edgeCount, CASE WHEN edgeCount < $edgeCap THEN batch ELSE [] END AS doomed
FOREACH (r IN edges | DELETE r)
FOREACH (n IN doomed | DETACH DELETE n)
RETURN repo IS NOT NULL AS repositoryExists, edgeCount AS edges, size(doomed) AS entities`;

/** Times a type-delete batch is re-run after a transient failure before the failure is raised. */
const TRANSIENT_BATCH_RETRIES = 3;
/** Delay before the first re-run of a batch; each later re-run waits one step longer. */
const TRANSIENT_BATCH_RETRY_DELAY_MS = 50;

/**
 * Delete every entity of a type plus their incident relationships, one batch
 * (`ENTITY_DELETE_BY_TYPE_QUERY`) at a time. A batch at the edge cap has
 * drained only some of its entities' edges and runs again; a batch under the
 * cap deletes its entities, and the delete ends with the first such batch
 * that finds fewer than `batchSize` entities. No single transaction holds a
 * whole type, or a whole hub's edges, however large either is. Returns the
 * exact numbers removed, summed from each batch's update counters (zero when
 * nothing of the type was left).
 *
 * Every batch checks the repository marker before it deletes anything:
 * `RepositoryNotFoundError` when it is absent, so a missing repository is
 * refused ahead of any delete. The statements run on an auto-commit session,
 * which the driver never re-runs, so a batch's counters are never lost to a
 * re-run that finds its own committed delete and reports nothing.
 *
 * A batch the server fails with a transient error (`isRetryableTransientFailure`:
 * a deadlock with a concurrent write, say) is run again, up to
 * `TRANSIENT_BATCH_RETRIES` times. That keeps the counts exact, because one
 * transaction does all of a batch's deleting and the failure rolled it back.
 * Any other failure surfaces as a typed error; the batches already committed
 * stay deleted, and calling again removes the rest. A call that fails after
 * its last deleting batch committed (the connection lost before the
 * acknowledgement, say) has removed the whole type, so a resend of the type
 * delete finds nothing left to remove and the engine answers "not found".
 */
export async function deleteEntitiesByType(
  conn: Neo4jConnection,
  repositoryId: string,
  entityType: string,
  batching: { batchSize: number; edgeCap: number },
): Promise<{ deletedEntities: number; deletedRelationships: number }> {
  const { batchSize, edgeCap } = batching;
  const params = { entityType, batchSize: BigInt(batchSize), edgeCap: BigInt(edgeCap) };
  let deletedEntities = 0;
  let deletedRelationships = 0;
  while (true) {
    const result = await runEntityTypeBatch(conn, repositoryId, params);
    const record = result.records[0];
    if (record === undefined) throw new ProviderError('Neo4j delete by entity type returned no row.');
    if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
    const counters = result.summary.counters.updates();
    deletedEntities += counters['nodesDeleted'] ?? 0;
    deletedRelationships += counters['relationshipsDeleted'] ?? 0;
    // At the cap, the batch's entities may still have edges: take more before deleting them.
    if (bigintToSafeNumber(record.get('edges') ?? 0) >= edgeCap) continue;
    if (bigintToSafeNumber(record.get('entities') ?? 0) < batchSize) break;
  }
  return { deletedEntities, deletedRelationships };
}

/**
 * Run one type-delete batch, re-running it after a transient failure (see
 * `deleteEntitiesByType`). Any other failure, or a transient one that
 * outlasts the retries, is raised as a typed error.
 */
async function runEntityTypeBatch(
  conn: Neo4jConnection,
  repositoryId: string,
  params: { entityType: string; batchSize: bigint; edgeCap: bigint },
): Promise<Awaited<ReturnType<Neo4jConnection['executeImplicitInTransactions']>>> {
  for (let retry = 0; ; retry++) {
    try {
      return await conn.executeImplicitInTransactions(ENTITY_DELETE_BY_TYPE_QUERY, params, { repositoryId });
    } catch (err) {
      if (retry >= TRANSIENT_BATCH_RETRIES || !isRetryableTransientFailure(err)) {
        mapDriverError(err, { repositoryId, operation: 'deleteEntitiesByType' });
      }
    }
    await delay(TRANSIENT_BATCH_RETRY_DELAY_MS * (retry + 1));
  }
}
