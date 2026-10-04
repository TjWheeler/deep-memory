// Entity CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { CosmosDocumentClient, CosmosQueryParameter } from '../CosmosDocumentClient.js';
import type { StoredEntity, StoredEntityUpdate } from '@utaba/deep-memory/types';
import type { StorageFindQuery, PaginatedResult, PropertyFilter } from '@utaba/deep-memory/types';
import type { EntityReadOptions } from '@utaba/deep-memory/providers';
import {
  assertSafeEntityUserPropertyKey,
  buildEntityPropertyLadder,
  entityFromDocument,
  entityFromGremlin,
  entityToLadderBindings,
  entityUpdatePropertyParams,
  entityUserPropertyParams,
  existingEntityScalarUserKeys,
  isNativeStorableValue,
  STORED_ENTITY_FIELDS,
} from '../mapping.js';
import {
  DuplicateEntityError,
  EntityNotFoundError,
  ProviderError,
  RepositoryNotFoundError,
  SlugConflictError,
  buildVertexProjectChain,
  matchesPropertyFilters,
} from '@utaba/deep-memory';
import { repoVertexId } from './ids.js';
import { submitCreate } from './create.js';
import {
  alongsideCheck,
  assertRepositoryMarker,
  assertRepositoryMarkerDocument,
  markerCheckedRead,
  rowsPastMarker,
} from './marker.js';
import { deleteEntitiesByIds, deleteTypedEntitiesByIds } from './deleteByIds.js';

// Sentinels the create query returns in place of the new vertex; the caller
// translates them into typed errors — single round-trip either way:
//   - DUPLICATE_SENTINEL: a vertex with the requested id already exists in
//     the repository's partition.
//   - SLUG_TAKEN_SENTINEL: another entity in the partition already holds the
//     requested slug, so nothing was written.
//   - NO_REPOSITORY_SENTINEL: the repository's `_repository` marker vertex is
//     absent, so nothing was written.
const DUPLICATE_SENTINEL = '__duplicate';
const SLUG_TAKEN_SENTINEL = '__slug_taken';
const NO_REPOSITORY_SENTINEL = '__no_repository';

// Prefix shared by every entity-create query, built as two nested coalesces:
//
//   1. Outer gate on the repository marker. `deleteRepository` drops the
//      `_repository` vertex before its chunked drain, so a create that runs
//      after that point finds no marker, takes the `constant(...)` branch and
//      writes nothing. Checking the marker in the same traversal as the
//      `addV`, rather than in a separate round-trip, leaves no gap between
//      the check and the write for the drop to land in.
//   2. Inner duplicate check + slug check + create, run once per marker
//      traverser. The `map(__.V()…fold())` step looks the entity id up
//      (partition-scoped) and hands the inner coalesce a list: an existing
//      vertex yields the duplicate sentinel; otherwise an entity already
//      holding the slug yields the slug-taken sentinel; otherwise `addV`
//      writes the vertex with the schema-managed property ladder.
//
//      The slug check runs in the same request as the write but Cosmos
//      Gremlin is not transactional: two creates in flight with the same
//      slug can both pass it and both write. Id uniqueness, by contrast, is
//      enforced by Cosmos itself (one document per id per partition), so a
//      racing duplicate id is refused with a 409 that `createEntity` maps to
//      DuplicateEntityError.
//
//      The lookup must sit inside `map()`. Written as a plain chain,
//      `unfold().V()…fold()`, the `fold()` is a barrier that emits an empty
//      list even when `unfold()` emitted nothing — so with no marker the
//      inner coalesce would still reach `addV` and the gate would never
//      refuse. `map()` runs only for a traverser that exists, so with no
//      marker the first branch is empty and the outer coalesce falls through
//      to the no-repository sentinel.
//
// Per-call user-property scalars append after the ladder (between the prefix
// and `ENTITY_CREATE_CLOSE`). When the caller has no native-storable user
// properties, the empty suffix collapses the emitted string to the canonical
// `ENTITY_CREATE_QUERY` value below, so the plan cache keeps a single warm
// entry for the dominant shape.
//
// A create already executing when `deleteRepository` drops the marker can
// still land after the drain has passed it; re-running `deleteRepository`
// removes such a straggler.
const ENTITY_CREATE_PREFIX =
  `g.V().has('repositoryId', rid).hasId(repoVid).hasLabel('_repository').fold().coalesce(` +
  `unfold().map(__.V().has('repositoryId', rid).hasId(vid).fold()).coalesce(` +
  `unfold().constant('${DUPLICATE_SENTINEL}'),` +
  `__.V().has('repositoryId', rid).has('slug', slugVal).has('entityType').limit(1).constant('${SLUG_TAKEN_SENTINEL}'),` +
  `addV(vertexLabel).property('id', vid).property('repositoryId', rid)${buildEntityPropertyLadder()}`;

// Closes the inner (duplicate / create) coalesce, then supplies the outer
// gate's no-repository branch.
const ENTITY_CREATE_CLOSE = `),constant('${NO_REPOSITORY_SENTINEL}'))`;

// Canonical empty-user-properties form. Exported so the unit test can pin the
// invariant that every create without native-storable user properties emits
// this one string.
export const ENTITY_CREATE_QUERY = `${ENTITY_CREATE_PREFIX}${ENTITY_CREATE_CLOSE}`;

export async function createEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entity: StoredEntity,
): Promise<StoredEntity> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    repoVid: repoVertexId(repositoryId),
    vid: entity.id,
    vertexLabel: entity.entityType,
    slugVal: entity.slug,
    ...entityToLadderBindings(entity),
  };

  // Dual-write: the JSON blob lives in the `properties` ladder slot above
  // (round-trip authoritative); native-storable scalars also project to per-
  // key vertex properties so server-side predicates and aggregations can
  // reach them. Validation runs before any round-trip — reserved-key
  // collisions and unsafe identifiers raise InvalidInputError synchronously.
  const userProps = entityUserPropertyParams(entity.properties ?? {});
  let query: string;
  if (userProps.length === 0) {
    query = ENTITY_CREATE_QUERY;
  } else {
    let suffix = '';
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      suffix += `.property('${key}', p_user_${i})`;
      bindings[`p_user_${i}`] = value;
    }
    query = `${ENTITY_CREATE_PREFIX}${suffix}${ENTITY_CREATE_CLOSE}`;
  }

  const result = await submitCreate(conn, query, bindings, (cause) => new DuplicateEntityError(entity.id, { cause }));

  if (result.items[0] === NO_REPOSITORY_SENTINEL) {
    throw new RepositoryNotFoundError(repositoryId);
  }
  if (result.items[0] === DUPLICATE_SENTINEL) {
    throw new DuplicateEntityError(entity.id);
  }
  if (result.items[0] === SLUG_TAKEN_SENTINEL) {
    throw new SlugConflictError(entity.slug, { entityType: entity.entityType, label: entity.label });
  }

  return entity;
}

/**
 * Read one entity by id, fetching the repository marker in the same request.
 *
 * @throws RepositoryNotFoundError when the marker is absent, whether or not
 *   the entity is still there.
 */
export async function getEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  options?: EntityReadOptions,
): Promise<StoredEntity | null> {
  const projection = buildVertexProjectChain({ withEmbedding: options?.loadEmbeddings });
  const result = await conn.submit(markerCheckedRead('hasId(within(mid, eid))', projection), {
    rid: repositoryId,
    mid: repoVertexId(repositoryId),
    eid: entityId,
  });
  const rows = rowsPastMarker(result.items, repositoryId);
  if (rows.length === 0) return null;
  return entityFromGremlin(rows[0] as Record<string, unknown>);
}

/**
 * Read one entity by slug. The marker and the slug lookup share the first,
 * index-backed step (`or(hasId(mid), has(slug))`), so the marker costs no
 * extra request.
 *
 * @throws RepositoryNotFoundError when the marker is absent.
 */
export async function getEntityBySlug(
  conn: CosmosDbConnection,
  repositoryId: string,
  slug: string,
  options?: EntityReadOptions,
): Promise<StoredEntity | null> {
  const projection = buildVertexProjectChain({ withEmbedding: options?.loadEmbeddings });
  const result = await conn.submit(
    markerCheckedRead("or(__.hasId(mid), __.has('slug', slugVal))", projection),
    { rid: repositoryId, mid: repoVertexId(repositoryId), slugVal: slug },
  );
  const rows = rowsPastMarker(result.items, repositoryId);
  if (rows.length === 0) return null;
  return entityFromGremlin(rows[0] as Record<string, unknown>);
}

/**
 * Read entities by id, fetching the repository marker in the same request.
 * An empty list reads only the marker.
 *
 * @throws RepositoryNotFoundError when the marker is absent.
 */
export async function getEntities(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityIds: string[],
  options?: EntityReadOptions,
): Promise<Map<string, StoredEntity>> {
  if (entityIds.length === 0) {
    await assertRepositoryMarker(conn, repositoryId);
    return new Map();
  }

  // Build within() clause with individual params
  const bindings: Record<string, unknown> = { rid: repositoryId, mid: repoVertexId(repositoryId) };
  const idParams: string[] = [];
  entityIds.forEach((id, i) => {
    const paramName = `eid${i}`;
    bindings[paramName] = id;
    idParams.push(paramName);
  });

  const projection = buildVertexProjectChain({ withEmbedding: options?.loadEmbeddings });
  const result = await conn.submit(
    markerCheckedRead(`hasId(within(mid, ${idParams.join(', ')}))`, projection),
    bindings,
  );

  const map = new Map<string, StoredEntity>();
  for (const item of rowsPastMarker(result.items, repositoryId)) {
    const entity = entityFromGremlin(item as Record<string, unknown>);
    map.set(entity.id, entity);
  }
  return map;
}

// updateEntity intentionally KEEPS a variable-shape query (unlike createEntity).
// A fixed-shape ladder for updates would require a three-way discriminator per
// slot (set / drop / leave) with two-level choose-and-sideEffect-drop branches
// — significant Gremlin complexity for a per-call plan-cache win that matters
// far less here than on the bulk-import create path. The plan-cache concern is
// the case where every create would otherwise be a unique query string, not
// partial-update calls. If the reembed loop
// ever profiles as plan-parse-bound, revisit by introducing a two-sentinel
// ladder shape — until then variable is fine.
//
// User-property dual-write on update is a 2-round-trip operation when the
// caller replaces the properties blob: one pre-read of the existing blob (so
// the drop set for scalars that left the new shape can be computed), then
// one write. Read-then-write is not transactional — the documented contract
// is last-writer-wins with the blob as the read-side source of truth. When
// the caller does not touch properties, the pre-read is skipped and the
// shape is unchanged from the historical single-round-trip path.

// The update's write fetches the repository marker and the entity in its
// first, index-backed step (partition-scoped, both by id), then continues to
// the entity only past the marker: with no marker the traversal writes
// nothing and returns no row. `updateEntity` reads the marker
// (`assertRepositoryMarker`) only on its failure paths, so the repository
// outcome takes precedence over the entity and slug outcomes without costing
// a successful update a round trip.
//
// The entity type is the vertex label and nothing reserves `_`-prefixed
// types, so an entity typed `_repository` carries the marker's label too.
// `hasNot('entityType')` (every entity vertex carries it, the marker never
// does) keeps such an entity from standing in for a missing marker, or from
// passing alongside the real one and running the write twice.
export const UPDATE_ENTITY_START =
  "g.V().has('repositoryId', rid).hasId(within(repoVid, eid)).fold().as('vs')" +
  ".unfold().hasLabel('_repository').hasNot('entityType').select('vs').unfold().has('entityType')";

async function readExistingEntityPropertiesBlob(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
): Promise<{ found: true; blob: Record<string, unknown> } | { found: false }> {
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).hasId(eid).has('entityType').values('properties').limit(1)",
    { rid: repositoryId, eid: entityId },
  );
  if (result.items.length === 0) return { found: false };
  const raw = result.items[0];
  const json = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!json) return { found: true, blob: {} };
  try {
    const parsed = JSON.parse(json);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { found: true, blob: parsed as Record<string, unknown> };
    }
  } catch {
    // Malformed blob — treat as empty for drop-set purposes.
  }
  return { found: true, blob: {} };
}

export async function updateEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  updates: StoredEntityUpdate,
): Promise<StoredEntity> {
  // Slugs are unique per repository. Only an update that sets a slug pays
  // for this lookup; like the create-time check it is not transactional, so
  // two updates in flight onto the same slug can both pass it. An entity that
  // already holds the slug keeps it, even if another entity holds it too
  // (data written before uniqueness was enforced): the update takes nothing
  // from anyone.
  if (updates.slug !== undefined) {
    const holders = await conn.submit(
      "g.V().has('repositoryId', rid).has('slug', slugVal).has('entityType').id()",
      { rid: repositoryId, slugVal: updates.slug },
    );
    if (holders.items.length > 0 && !holders.items.includes(entityId)) {
      // One read both reports a missing entity as such (rather than as a slug
      // clash) and supplies the type and label the update leaves unchanged.
      const target = await conn.submit(
        "g.V().has('repositoryId', rid).hasId(eid).has('entityType')" +
          ".project('entityType','label').by(values('entityType')).by(coalesce(values('entityLabel'), constant('')))",
        { rid: repositoryId, eid: entityId },
      );
      await assertRepositoryMarker(conn, repositoryId);
      const current = target.items[0];
      if (current === null || typeof current !== 'object') throw new EntityNotFoundError(entityId);
      // The driver hands a projection back as a Map or a plain object.
      const field = (key: string): string =>
        String(current instanceof Map ? current.get(key) : (current as Record<string, unknown>)[key]);
      throw new SlugConflictError(updates.slug, {
        entityType: updates.entityType ?? field('entityType'),
        label: updates.label ?? field('label'),
      });
    }
  }

  // The new user-property shape is validated and projected once the pre-read
  // has returned the stored blob: key rules apply only to keys the update
  // writes (new, or with a changed value), so a key stored before the rules
  // existed and carried over unchanged does not block the update. See
  // `entityUpdatePropertyParams`. The drop set never names such a key either
  // (`existingEntityScalarUserKeys` skips it).
  let userProps: Array<{ key: string; value: unknown }> | null = null;
  let droppedUserKeys: string[] = [];
  if (updates.properties !== undefined) {
    const existing = await readExistingEntityPropertiesBlob(conn, repositoryId, entityId);
    if (!existing.found) {
      // Short-circuit before the write: no entity to update, unless the
      // repository itself is gone.
      await assertRepositoryMarker(conn, repositoryId);
      throw new EntityNotFoundError(entityId);
    }
    const projected = entityUpdatePropertyParams(updates.properties, existing.blob);
    userProps = projected;
    const existingKeys = existingEntityScalarUserKeys(existing.blob);
    const newKeySet = new Set(projected.map((p) => p.key));
    droppedUserKeys = existingKeys.filter((k) => !newKeySet.has(k));
  }

  const bindings: Record<string, unknown> = { rid: repositoryId, repoVid: repoVertexId(repositoryId), eid: entityId };
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

  // User-property dual-write block. Order within the block: write the
  // canonical blob first (the read-side source of truth), then drop scalars
  // that left the new shape, then re-emit a .property for every native-
  // storable key in the new shape. Keys whose value did not change still
  // get re-emitted — the cost is one idempotent .property step per key and
  // it keeps the emitted shape stable per-shape for plan-cache reuse.
  if (updates.properties !== undefined && userProps !== null) {
    addProp('properties', JSON.stringify(updates.properties));
    for (const dropKey of droppedUserKeys) {
      dropProp(dropKey);
    }
    for (let i = 0; i < userProps.length; i++) {
      const { key, value } = userProps[i]!;
      const paramName = `p_user_${i}`;
      bindings[paramName] = value;
      propParts.push(`.property('${key}', ${paramName})`);
    }
  }

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

  // Append the read-projection onto the update so the updated state comes
  // back in a single round-trip (instead of update + separate getEntity).
  // Embeddings stay off the wire — callers that need the embedding pass the
  // option through the public StorageProvider.getEntity call themselves.
  const projection = buildVertexProjectChain();
  const query = `${UPDATE_ENTITY_START}${propParts.join('')}.${projection}`;
  const result = await conn.submit(query, bindings);

  if (result.items.length === 0) {
    // No row: the marker or the entity is missing, and nothing was written.
    // The repository outcome takes precedence. A delete in progress has
    // already dropped the marker, so an entity it has not drained yet is not
    // written either.
    await assertRepositoryMarker(conn, repositoryId);
    throw new EntityNotFoundError(entityId);
  }

  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

/**
 * Delete one entity and its edges through the marker-guarded delete
 * (`deleteEntitiesByIds`). A missing repository marker →
 * `RepositoryNotFoundError`; an id with no entity in an existing repository
 * → `EntityNotFoundError`.
 */
export async function deleteEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
): Promise<void> {
  const { notFound } = await deleteEntitiesByIds(conn, repositoryId, [entityId]);
  if (notFound.length > 0) throw new EntityNotFoundError(entityId);
}

/** Entities read, and then dropped, per batch of a by-type delete. */
export const ENTITY_TYPE_DELETE_BATCH_SIZE = 500;

/**
 * Consecutive by-type batches that read ids but drop none before the delete
 * stops: one can follow a re-sent drop or a concurrent delete, two in a row
 * mean the loop is not making progress.
 */
export const ENTITY_TYPE_DELETE_MAX_EMPTY_BATCHES = 2;

/**
 * The ids of up to `batchSize` entities of a type. The bound sits on the
 * first, index-backed step, so a batch's cost does not grow with the type's
 * population.
 */
export const ENTITY_TYPE_BATCH_IDS_QUERY =
  "g.V().has('repositoryId', rid).has('entityType', etype).limit(batchSize).id()";

/**
 * Drop every entity of a type, with its edges, in batches, and report how
 * many entities were dropped. Each batch reads up to
 * `ENTITY_TYPE_DELETE_BATCH_SIZE` ids of the type, then drops them through the
 * guarded delete (`deleteTypedEntitiesByIds`), which fetches the marker with
 * the ids in its first step and drops only while the marker exists. The loop
 * ends when a read finds no entity of the type; when the first read finds
 * none, a marker point read decides between `RepositoryNotFoundError` and
 * nothing to delete.
 *
 * A single request over the whole type would read the type into one list
 * before the drop, so its cost and duration grow with the type's population
 * and a large type can outlast the request timeout. A bounded batch costs the
 * same whatever the type's size, and a delete stopped part-way is finished
 * by calling it again. A mid-traversal `V()` after the marker step cannot
 * bound the batch: it reads the type's whole population before `limit`.
 *
 * `deletedEntities` is the sum of each batch's guarded drop: the ids that
 * request found still of the type and dropped. It is never more than were
 * removed, and may be fewer: when a transient error (429 / 503) makes the
 * connection re-send a drop that had already partly applied, the re-sent
 * request reports only the entities still there. Counting the read ids
 * confirmed gone afterwards would not be exact either: an entity a concurrent
 * delete removed would be counted by both. Batches are not one transaction: a
 * delete that fails or finds the marker gone part-way leaves the batches
 * before it dropped.
 *
 * A batch whose read returned ids but whose drops removed none can follow a
 * re-sent drop or a concurrent delete; the next read moves on. Two such
 * batches in a row mean the reads keep returning ids the guarded drop does
 * not remove, and the loop stops with a `ProviderError` rather than spin.
 * What was dropped stays dropped, so the call can be repeated.
 *
 * The cascaded edge count is intentionally skipped — computing it required a
 * `bothE().dedup().count()` that walked every incident edge, and the
 * vocabulary cascade does not read it. Returns `deletedRelationships:
 * undefined` to signal the field is genuinely unknown for this provider.
 *
 * @throws RepositoryNotFoundError when the marker is absent; the request
 *   that finds it absent drops nothing.
 * @throws ProviderError when two batches in a row drop nothing although
 *   their reads returned ids.
 */
export async function deleteEntitiesByType(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityType: string,
): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
  let deletedEntities = 0;
  let emptyBatches = 0;
  for (let batch = 0; ; batch++) {
    const read = await conn.submit(ENTITY_TYPE_BATCH_IDS_QUERY, {
      rid: repositoryId,
      etype: entityType,
      batchSize: ENTITY_TYPE_DELETE_BATCH_SIZE,
    });
    const ids = read.items.filter((id): id is string => typeof id === 'string');
    if (ids.length !== read.items.length) {
      throw new ProviderError('Cosmos type id read returned a row that is not an id.');
    }
    if (ids.length === 0) {
      if (batch === 0) await assertRepositoryMarker(conn, repositoryId);
      return { deletedEntities, deletedRelationships: undefined };
    }
    const dropped = await deleteTypedEntitiesByIds(conn, repositoryId, entityType, ids);
    deletedEntities += dropped;
    emptyBatches = dropped === 0 ? emptyBatches + 1 : 0;
    if (emptyBatches >= ENTITY_TYPE_DELETE_MAX_EMPTY_BATCHES) {
      throw new ProviderError(
        `Deleting entities of type "${entityType}" in repository "${repositoryId}" made no progress: ` +
          `${emptyBatches} batches in a row read entities of the type but dropped none (${deletedEntities} dropped before that).`,
        'Retry the delete: what was dropped stays dropped, and the delete resumes from what is left.',
      );
    }
  }
}

/**
 * Build the Document-endpoint SQL path for a Gremlin-managed property.
 * Every user property on a Gremlin vertex is stored as `[{_value, id}]` when
 * read through the Document endpoint — so a top-level scalar reference like
 * `c.entityType` silently returns no rows. Always go through `[0]._value`.
 * See "Path conventions" in docs/cosmosdb-gremlin-compatibility.md.
 */
function sqlPath(key: string): string {
  return `c.${key}[0]._value`;
}

/**
 * How the WHERE clause expressed the `properties` filter set, if one was
 * present. `none` — no filter set was supplied; `exact` — every value passed
 * `isNativeStorableValue`, so each clause was emitted as
 * `c.<key>[0]._value = @valN` against the dual-written native scalar column
 * (precise prefilter, COUNT can run alongside); `approximate` — at least one
 * filter value was not natively storable (nested object, null, mixed array,
 * etc.), so the whole set fell back to `CONTAINS(c.properties[0]._value, …)`
 * against the JSON blob (substring match, false-positive prone, refined
 * client-side; COUNT is skipped because it would over-report).
 */
type PropertyFilterMode = 'none' | 'exact' | 'approximate';

/**
 * Build the `WHERE` clause + parameter array shared by the data query and the
 * `SELECT VALUE COUNT(1)` query, so the two are guaranteed to count the same
 * set by construction.
 *
 * Property filters take one of two shapes depending on the filter values. When
 * every value is a native Cosmos Gremlin scalar (`isNativeStorableValue`), the
 * write path has already dual-written that value as `c.<key>[0]._value`, so
 * each clause emits an exact equality against that column and the COUNT query
 * over the same WHERE clause is precise. When any value is not natively
 * storable, the whole set falls back to substring `CONTAINS` on the
 * JSON-stringified blob — caller refines via `matchesPropertyFilters`, and the
 * COUNT branch is skipped because the substring prefilter over-counts.
 */
function buildWhereClause(
  query: StorageFindQuery,
  repositoryId: string,
): { sqlWhere: string; params: CosmosQueryParameter[]; propertyFilterMode: PropertyFilterMode } {
  const params: CosmosQueryParameter[] = [{ name: '@rid', value: repositoryId }];
  // `IS_DEFINED(c.entityType)` mirrors the old Gremlin `.has('entityType')`
  // presence check — it excludes the `_repository`, `_vocabulary`, and
  // `_vocabulary_change` system vertices that share the partition with the
  // repository's entities. Without this filter, those vertices leak into
  // both the data page and the COUNT(1), breaking pagination math.
  const predicates: string[] = ['c.repositoryId = @rid', 'IS_DEFINED(c.entityType)'];

  if (query.entityTypes && query.entityTypes.length > 0) {
    const typeParamNames: string[] = [];
    query.entityTypes.forEach((t, i) => {
      const name = `@etype${i}`;
      params.push({ name, value: t });
      typeParamNames.push(name);
    });
    // Gotcha: must use the `[0]._value` path even for the type filter — the
    // flat `c.entityType` form returns 0 docs with indexUtilizationRatio=0.00.
    predicates.push(`${sqlPath('entityType')} IN (${typeParamNames.join(', ')})`);
  }

  if (query.searchTerm) {
    params.push({ name: '@term', value: query.searchTerm });
    predicates.push(
      `(CONTAINS(${sqlPath('entityLabel')}, @term, true) ` +
        `OR CONTAINS(${sqlPath('slug')}, @term, true) ` +
        `OR CONTAINS(${sqlPath('summary')}, @term, true))`,
    );
  }

  let propertyFilterMode: PropertyFilterMode = 'none';
  if (query.properties != null && Object.keys(query.properties).length > 0) {
    const entries = Object.entries(query.properties);
    // Eligibility for the exact column path requires every value to be a
    // native Cosmos Gremlin scalar — the write path only dual-writes those.
    // A single non-storable value (nested object, mixed array, …) means the
    // exact column would be missing for that key and the whole filter set
    // must fall back to the JSON blob.
    const allStorable = entries.every(([, value]) => isNativeStorableValue(value));

    if (allStorable) {
      // The user-property key is interpolated directly into the SQL
      // identifier slot, so it must pass the same identifier guard the
      // write path uses — an unsafe key here would widen the injection
      // surface beyond what bound parameters can cover. Reserved-name
      // collisions (e.g. `entityType` in `properties`) are a programming
      // error rather than a query: throwing surfaces them rather than
      // silently returning whatever the schema slot happens to hold.
      for (const [key] of entries) {
        assertSafeEntityUserPropertyKey(key);
      }
      let i = 0;
      for (const [key, value] of entries) {
        const name = `@val${i++}`;
        params.push({ name, value });
        predicates.push(`${sqlPath(key)} = ${name}`);
      }
      propertyFilterMode = 'exact';
    } else {
      let i = 0;
      for (const [key, value] of entries) {
        // JSON.stringify on a single-entry object produces `{"key":<json-value>}`;
        // strip the outer braces to get the substring that must appear inside
        // the stored blob. Works uniformly for strings, numbers, booleans, and
        // nested arrays/objects. False positives are filtered client-side via
        // `matchesPropertyFilters` after JSON-parsing each returned doc.
        const fragment = JSON.stringify({ [key]: value }).slice(1, -1);
        const name = `@kv${i++}`;
        params.push({ name, value: fragment });
        // ignoreCase=false: property keys/values are canonical, no case folding.
        predicates.push(`CONTAINS(${sqlPath('properties')}, ${name}, false)`);
      }
      propertyFilterMode = 'approximate';
    }
  }

  return { sqlWhere: `WHERE ${predicates.join(' AND ')}`, params, propertyFilterMode };
}

/**
 * Build the projection field list for the data SELECT. Mirrors the Gremlin
 * fast path's `buildVertexProjectChain({ withEmbedding })`: embedding is
 * heavy (large JSON-stringified float array) and not shipped unless the
 * caller asks via `EntityReadOptions.loadEmbeddings`.
 */
function buildSelectClause(loadEmbeddings: boolean): string {
  const fields = ['c.id', ...STORED_ENTITY_FIELDS.filter((f) => f !== 'id').map((f) => `c.${f}`)];
  if (loadEmbeddings) fields.push('c.embedding');
  return `SELECT ${fields.join(', ')}`;
}

export async function findEntities(
  docClient: CosmosDocumentClient,
  repositoryId: string,
  query: StorageFindQuery,
  options?: EntityReadOptions,
): Promise<PaginatedResult<StoredEntity>> {
  const { sqlWhere, params, propertyFilterMode } = buildWhereClause(query, repositoryId);

  const dataParams: CosmosQueryParameter[] = [
    ...params,
    { name: '@off', value: query.offset },
    { name: '@lim', value: query.limit },
  ];
  const selectClause = buildSelectClause(options?.loadEmbeddings === true);
  // ORDER BY c.id pins pagination order deterministically — without it,
  // Cosmos may return overlapping/missing rows across page requests. c.id is
  // covered by the default indexing policy, so no extra RU on the sort itself.
  const dataSql = `${selectClause} FROM c ${sqlWhere} ORDER BY c.id OFFSET @off LIMIT @lim`;
  const countSql = `SELECT VALUE COUNT(1) FROM c ${sqlWhere}`;

  // The approximate property prefilter is a substring CONTAINS on the
  // JSON-stringified blob, so COUNT(1) over the same WHERE clause would
  // overcount by the false-positive rate. Report `total: undefined` and let
  // callers paginate on `hasMore` instead. The exact path emits a direct
  // equality against the dual-written native scalar column, so the COUNT is
  // precise and runs alongside.
  const skipCount = propertyFilterMode === 'approximate';

  // The marker read runs alongside the page and the count, so a deleted
  // repository is refused rather than answered with an empty page (or with
  // what a delete has not drained yet), at no added latency. A missing marker
  // wins over a failed page or count read. The page and the count are both
  // settled before either failure is raised, so neither is left running
  // outside the call's usage scope.
  const [dataResult, countResult] = await alongsideCheck(
    () => assertRepositoryMarkerDocument(docClient, repositoryId),
    async () => {
      const [data, count] = await Promise.allSettled([
        docClient.query<Record<string, unknown>>(dataSql, dataParams, {
          partitionKey: repositoryId,
        }),
        skipCount
          ? Promise.resolve(null)
          : docClient.query<number>(countSql, params, { partitionKey: repositoryId }),
      ]);
      if (data.status === 'rejected') throw data.reason;
      if (count.status === 'rejected') throw count.reason;
      return [data.value, count.value] as const;
    },
  );

  let items = dataResult.documents.map(entityFromDocument);

  // Client-side refinement stays as a belt-and-suspenders pass. On the exact
  // path it matches every row by construction, but the cost is negligible and
  // any prefilter regression (a missed equality emission, a stale blob from a
  // pre-migration entity) still produces the correct observable result.
  if (query.properties != null && Object.keys(query.properties).length > 0) {
    const filters: PropertyFilter[] = Object.entries(query.properties).map(
      ([key, value]) => ({ key, operator: 'eq', value }),
    );
    items = items.filter((entity) => matchesPropertyFilters(entity.properties, filters));
  }

  const total =
    countResult && countResult.documents.length > 0
      ? Number(countResult.documents[0])
      : undefined;

  const hasMore =
    total != null
      ? query.offset + items.length < total
      : items.length === query.limit;

  return {
    items,
    total,
    hasMore,
    limit: query.limit,
    offset: query.offset,
  };
}
