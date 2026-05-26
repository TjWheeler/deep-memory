// Entity CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { CosmosDocumentClient, CosmosQueryParameter } from '../CosmosDocumentClient.js';
import type { StoredEntity, StoredEntityUpdate } from '@utaba/deep-memory/types';
import type { StorageFindQuery, PaginatedResult, PropertyFilter } from '@utaba/deep-memory/types';
import type { EntityReadOptions } from '@utaba/deep-memory/providers';
import {
  buildEntityPropertyLadder,
  entityFromDocument,
  entityFromGremlin,
  entityToLadderBindings,
  STORED_ENTITY_FIELDS,
} from '../mapping.js';
import {
  DuplicateEntityError,
  EntityNotFoundError,
  buildVertexProjectChain,
  matchesPropertyFilters,
} from '@utaba/deep-memory';

// Sentinel returned by the duplicate-detection branch of the
// fold().coalesce(unfold().constant('__duplicate'), addV/addE) pattern. The
// create succeeds inline or the duplicate path returns this string, which we
// translate into the typed error — single round-trip either way.
const DUPLICATE_SENTINEL = '__duplicate';

// Fixed-shape property ladder — same Gremlin string for every entity create
// regardless of which optional fields are populated, so the Cosmos plan cache
// reuses one compiled plan. Computed once at module load.
const ENTITY_CREATE_QUERY =
  `g.V().has('repositoryId', rid).hasId(vid).fold().coalesce(` +
  `unfold().constant('${DUPLICATE_SENTINEL}'),` +
  `addV(vertexLabel).property('id', vid).property('repositoryId', rid)${buildEntityPropertyLadder()}` +
  `)`;

export async function createEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entity: StoredEntity,
): Promise<StoredEntity> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    vid: entity.id,
    vertexLabel: entity.entityType,
    ...entityToLadderBindings(entity),
  };

  const result = await conn.submit(ENTITY_CREATE_QUERY, bindings);

  if (result.items[0] === DUPLICATE_SENTINEL) {
    throw new DuplicateEntityError(entity.id);
  }

  return entity;
}

export async function getEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  options?: EntityReadOptions,
): Promise<StoredEntity | null> {
  const projection = buildVertexProjectChain({ withEmbedding: options?.loadEmbeddings });
  const result = await conn.submit(
    `g.V().has('repositoryId', rid).hasId(eid).has('entityType').${projection}`,
    { rid: repositoryId, eid: entityId },
  );
  if (result.items.length === 0) return null;
  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function getEntityBySlug(
  conn: CosmosDbConnection,
  repositoryId: string,
  slug: string,
  options?: EntityReadOptions,
): Promise<StoredEntity | null> {
  const projection = buildVertexProjectChain({ withEmbedding: options?.loadEmbeddings });
  const result = await conn.submit(
    `g.V().has('repositoryId', rid).has('slug', slugVal).has('entityType').${projection}`,
    { rid: repositoryId, slugVal: slug },
  );
  if (result.items.length === 0) return null;
  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function getEntities(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityIds: string[],
  options?: EntityReadOptions,
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
  const projection = buildVertexProjectChain({ withEmbedding: options?.loadEmbeddings });
  const result = await conn.submit(
    `g.V().has('repositoryId', rid).hasId(${withinClause}).has('entityType').${projection}`,
    bindings,
  );

  const map = new Map<string, StoredEntity>();
  for (const item of result.items) {
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
// framed around the "every create is a unique query" case (issue #20 in
// plans/performance-issues.md), not partial-update calls. If the reembed loop
// ever profiles as plan-parse-bound, revisit by introducing a two-sentinel
// ladder shape — until then variable is fine.

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

  // Append the read-projection onto the update so the updated state comes
  // back in a single round-trip (instead of update + separate getEntity).
  // Embeddings stay off the wire — callers that need the embedding pass the
  // option through the public StorageProvider.getEntity call themselves.
  const projection = buildVertexProjectChain();
  const query = `g.V().has('repositoryId', rid).hasId(eid).has('entityType')${propParts.join('')}.${projection}`;
  const result = await conn.submit(query, bindings);

  if (result.items.length === 0) {
    throw new EntityNotFoundError(entityId);
  }

  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function deleteEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
): Promise<void> {
  // Gremlin drop() on a vertex also drops connected edges
  await conn.submit(
    "g.V().has('repositoryId', rid).hasId(eid).has('entityType').drop()",
    { rid: repositoryId, eid: entityId },
  );
}

/**
 * Single round-trip type-delete via the aggregate-side-effect pattern: the
 * bucket records the vertex ids that the drop touched, giving an exact entity
 * count. The cascaded edge count is intentionally skipped — computing it
 * required a `bothE().dedup().count()` that walked every incident edge across
 * every partition the type touches, and the value is currently discarded by
 * the only caller (VocabularyEngine.cascadeDeleteData).
 *
 * Returns `deletedRelationships: undefined` to signal the field is genuinely
 * unknown for this provider. SQL Server and in-memory providers continue to
 * return the exact number (rowsAffected / iteration).
 */
export async function deleteEntitiesByType(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityType: string,
): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).has('entityType', etype)" +
      ".aggregate('found').by('id').drop().cap('found')",
    { rid: repositoryId, etype: entityType },
  );
  const bucket = result.items[0];
  const deletedEntities = Array.isArray(bucket) ? bucket.length : 0;
  return { deletedEntities, deletedRelationships: undefined };
}

/**
 * Build the Document-endpoint SQL path for a Gremlin-managed property.
 * Every user property on a Gremlin vertex is stored as `[{_value, id}]` when
 * read through the Document endpoint — so a top-level scalar reference like
 * `c.entityType` silently returns no rows. Always go through `[0]._value`.
 * See local-tests/baseline/phase-cosmos-sql-shape-probe-results.md.
 */
function sqlPath(key: string): string {
  return `c.${key}[0]._value`;
}

/**
 * Build the `WHERE` clause + parameter array shared by the data query and the
 * `SELECT VALUE COUNT(1)` query, so the two are guaranteed to count the same
 * set by construction.
 *
 * Property filters are emitted as approximate `CONTAINS` on the JSON-stringified
 * `c.properties[0]._value` blob; the caller verifies exact-match client-side
 * (see `findEntities`).
 */
function buildWhereClause(
  query: StorageFindQuery,
  repositoryId: string,
): { sqlWhere: string; params: CosmosQueryParameter[] } {
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

  if (query.properties != null) {
    let i = 0;
    for (const [key, value] of Object.entries(query.properties)) {
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
  }

  return { sqlWhere: `WHERE ${predicates.join(' AND ')}`, params };
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
  const { sqlWhere, params } = buildWhereClause(query, repositoryId);

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

  // The properties prefilter is approximate (substring CONTAINS on the
  // JSON-stringified blob), so COUNT(1) over the same WHERE clause would
  // overcount by the false-positive rate. Report `total: undefined` and let
  // callers paginate on `hasMore` instead.
  const skipCount =
    query.properties != null && Object.keys(query.properties).length > 0;

  const [dataResult, countResult] = await Promise.all([
    docClient.query<Record<string, unknown>>(dataSql, dataParams, {
      partitionKey: repositoryId,
    }),
    skipCount
      ? Promise.resolve(null)
      : docClient.query<number>(countSql, params, { partitionKey: repositoryId }),
  ]);

  let items = dataResult.documents.map(entityFromDocument);

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
