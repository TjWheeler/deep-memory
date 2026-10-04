// Relationship CRUD Cypher queries.
//
// Storage shape:
//   - Each relationship is a directed Cypher edge whose type is the
//     vocabulary slug uppercased per Cypher convention (`WORKS_AT`,
//     `KNOWS`, …). The relationship-type slot cannot be parameterised in
//     Cypher 25, so the slug is interpolated into the query string after
//     passing `assertSafeRelationshipType` — vocabulary cardinality bounds
//     the per-type plan-cache footprint.
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
// Isolation invariant — the repository scope is enforced inside each
// statement, so no caller can write or read across repositories:
//   - `createRelationship` matches both endpoint nodes under the scoping
//     `$rid` predicate before writing the edge (`CREATE`, or `MERGE` for a
//     minted id). A cross-repository edge is therefore structurally
//     unwritable: the endpoint match for the out-of-scope side finds nothing
//     and the `FOREACH` conditional skips the write.
//   - Every read / delete carries the `$rid` predicate on the relationship
//     property map so reachability is bounded by the scope discriminator,
//     not the graph topology.
//
// Cost invariant — a lookup by relationship id never scans the database.
// Neo4j relationship indexes cover one relationship type, and a lookup by id
// does not know the type, so the pattern is anchored on the repository's
// entities instead: `(e:_Entity {repositoryId: $rid}) WHERE e.id IS NOT NULL`.
// The id predicate lets the planner seek the `(repositoryId, id)` unique
// index rather than scanning every `_Entity` in the database, and the
// lookup then expands the repository's own edges only, so its cost scales
// with the repository, not with every repository in the store. Every edge
// leaves an `_Entity` of its repository (`createRelationship` binds both
// endpoints under `$rid`), so the directed anchor reaches each edge once.

import { randomUUID } from 'node:crypto';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import type {
  PaginatedResult,
  RelationshipQueryOptions,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import {
  DuplicateRelationshipError,
  EntityNotFoundError,
  ProviderError,
  RelationshipNotFoundError,
  RepositoryNotFoundError,
  matchesPropertyFilters,
} from '@utaba/deep-memory';
import {
  assertSafeRelationshipType,
  bigintToSafeNumber,
  buildRelationshipProjection,
  relationshipFromRecord,
  relationshipToParams,
  WRITE_ATTEMPT_PROPERTY,
} from '../mapping.js';
import { LOCK_REPOSITORY_MARKER_OPTIONAL } from './repositoryLock.js';
import { deleteByIds } from './deleteByIds.js';
import { isDeletedEntityFailure, mapDriverError, settledValue } from '../errors.js';

type QueryResult = Awaited<ReturnType<Neo4jConnection['executeQuery']>>;

// Shared projections — computed once at module load so the planner keys off
// byte-identical strings regardless of which read path emits the query.
const RELATIONSHIP_PROJECTION = buildRelationshipProjection();

/**
 * What a `createRelationship` statement did. The statement reports it, so
 * the caller names the cause without a follow-up read.
 */
export const RELATIONSHIP_CREATE_OUTCOME = {
  created: 'created',
  repositoryMissing: 'repository-missing',
  sourceMissing: 'source-missing',
  targetMissing: 'target-missing',
  idExists: 'id-exists',
} as const;

export type RelationshipCreateOutcome =
  (typeof RELATIONSHIP_CREATE_OUTCOME)[keyof typeof RELATIONSHIP_CREATE_OUTCOME];

const RELATIONSHIP_CREATE_OUTCOMES: ReadonlySet<string> = new Set(
  Object.values(RELATIONSHIP_CREATE_OUTCOME),
);

function isRelationshipCreateOutcome(value: unknown): value is RelationshipCreateOutcome {
  return typeof value === 'string' && RELATIONSHIP_CREATE_OUTCOMES.has(value);
}

/**
 * Build the `createRelationship` Cypher for one relationship type. One
 * statement, one round-trip:
 *
 *   1. `LOCK_REPOSITORY_MARKER_OPTIONAL` write-locks the `_Repository`
 *      marker and binds `live` to it while it still exists.
 *   2. Match both endpoints under the repository scope, and check whether
 *      any edge in the repository already carries the id.
 *   3. Decide the outcome, in this order of precedence — repository
 *      missing, id already in use, source missing, target missing, or
 *      created — and `CREATE` the edge only when it is `created`. SQL Server
 *      and the in-memory provider check in the same order. CosmosDB checks
 *      the id before the repository marker, because its id lookup has to
 *      start the traversal; the two orders differ only when a reused id
 *      meets a repository that is being deleted.
 *   4. Return the outcome.
 *
 * Ordering is what makes the id check race-free. The lock step is an
 * updating clause, and an updating clause ends a query part, so the planner
 * places every read in the later clauses — the endpoint matches and the
 * `EXISTS` id check — after the lock is granted, and those reads see the
 * latest committed state. The lock is held until commit, so a second create
 * of the same id in the same repository waits for this one and then sees its
 * edge. The `WITH` that closes the lock fragment is the barrier; a `CALL`
 * subquery would add a scope without changing the order.
 *
 * The id check cannot use a relationship index: Neo4j relationship indexes
 * and constraints cover one relationship type, and an id must be unique
 * across every type in the repository. It is anchored on the repository's
 * entities instead. Naming the anchor and requiring `e.id IS NOT NULL` lets
 * the planner seek the `(repositoryId, id)` unique index for the
 * repository's entities instead of scanning every `_Entity` in the
 * database, and `repositoryId` on the edge pattern admits only the
 * repository's own edges. From there the check expands every outgoing edge
 * of those entities, so its cost is linear in the repository's relationship
 * count. It runs under the marker lock, so other creates in the same
 * repository queue behind it for that time. The check is projected in its
 * own `WITH` rather than inside the `CASE`, so the planner places it in the
 * main plan as a semi-apply. The creating clause is `CREATE`, not `MERGE`:
 * reusing an id is an error, never a silent match.
 *
 * The lock also closes the race with `deleteRepository` (see
 * `repositoryLock.ts`): no edge commits after the repository's drain has
 * passed it. A missing repository is reported ahead of everything else,
 * because once the repository is gone its entities are being wiped too.
 *
 * The relationship-type slot is interpolated after `assertSafeRelationshipType`
 * — Cypher cannot parameterise it, and the vocabulary's bounded cardinality
 * keeps the plan cache footprint linear in the type count. Every other value
 * is a parameter; the outcome names are this module's constants.
 *
 * Cross-repository edges are structurally impossible: an endpoint in a
 * different repository fails its `(repositoryId, id)` match and reports as
 * missing.
 */
export function buildCreateRelationshipQuery(relationshipType: string): string {
  const relType = assertSafeRelationshipType(relationshipType);
  const o = RELATIONSHIP_CREATE_OUTCOME;
  return `${LOCK_REPOSITORY_MARKER_OPTIONAL}
OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: $sourceEntityId})
OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: $targetEntityId})
WITH live, s, t,
  EXISTS {
    MATCH (e:_Entity {repositoryId: $rid})-[{repositoryId: $rid, id: $id}]->()
    WHERE e.id IS NOT NULL
  } AS idTaken
WITH s, t,
  CASE
    WHEN live IS NULL THEN '${o.repositoryMissing}'
    WHEN idTaken THEN '${o.idExists}'
    WHEN s IS NULL THEN '${o.sourceMissing}'
    WHEN t IS NULL THEN '${o.targetMissing}'
    ELSE '${o.created}'
  END AS outcome
FOREACH (_ IN CASE WHEN outcome = '${o.created}' THEN [1] ELSE [] END |
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
    modifiedFromMessage: $modifiedFromMessage,
    ${WRITE_ATTEMPT_PROPERTY}: $writeAttempt
  }]->(t)
)
RETURN outcome
`;
}

/**
 * Build the `createRelationship` Cypher for a relationship whose id the
 * engine minted (`RelationshipCreateOptions.idMinted`). It is the statement
 * `buildCreateRelationshipQuery` builds without the id check: a minted id is
 * a random UUID, so looking for it among the repository's edges — a pass
 * over every edge of the repository, under the marker lock — buys nothing.
 * The statement touches the marker, the two endpoints and the edges between
 * them only (see the `MERGE` below), not the rest of the repository.
 *
 * The marker lock and the remaining outcomes are unchanged, in the same
 * order of precedence: repository missing, source missing, target missing,
 * created. The lock still closes the race with `deleteRepository`.
 *
 * The creating clause is a `MERGE` between the two bound endpoints, keyed
 * on the id and this call's write token (`$writeAttempt`). The driver
 * re-runs a statement whose commit acknowledgement was lost, sending the same
 * token; the re-run matches the edge its first run committed instead of
 * writing a second one, and reports `created`. An edge written by any other
 * call carries another token and never matches. The `MERGE` looks only at
 * the edges between `s` and `t`, which the endpoint seeks already bound: the
 * planner expands into the pair (`Expand(Into)`), which walks the type-`T`
 * edges of whichever endpoint has fewer of them. Its cost is bounded by that
 * smaller endpoint degree for the type, not by the size of the repository.
 */
export function buildCreateMintedRelationshipQuery(relationshipType: string): string {
  const relType = assertSafeRelationshipType(relationshipType);
  const o = RELATIONSHIP_CREATE_OUTCOME;
  return `${LOCK_REPOSITORY_MARKER_OPTIONAL}
OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: $sourceEntityId})
OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: $targetEntityId})
WITH s, t,
  CASE
    WHEN live IS NULL THEN '${o.repositoryMissing}'
    WHEN s IS NULL THEN '${o.sourceMissing}'
    WHEN t IS NULL THEN '${o.targetMissing}'
    ELSE '${o.created}'
  END AS outcome
FOREACH (_ IN CASE WHEN outcome = '${o.created}' THEN [1] ELSE [] END |
  MERGE (s)-[r:${relType} {repositoryId: $rid, id: $id, ${WRITE_ATTEMPT_PROPERTY}: $writeAttempt}]->(t)
  ON CREATE SET
    r.relationshipType = $relationshipType,
    r.sourceEntityId = $sourceEntityId,
    r.targetEntityId = $targetEntityId,
    r.properties = $properties,
    r.bidirectional = $bidirectional,
    r.createdBy = $createdBy,
    r.createdByType = $createdByType,
    r.createdAt = $createdAt,
    r.createdInConversation = $createdInConversation,
    r.createdFromMessage = $createdFromMessage,
    r.modifiedBy = $modifiedBy,
    r.modifiedByType = $modifiedByType,
    r.modifiedAt = $modifiedAt,
    r.modifiedInConversation = $modifiedInConversation,
    r.modifiedFromMessage = $modifiedFromMessage
)
RETURN outcome
`;
}

/**
 * Read back the write token of the edge carrying an id, after a create
 * reported the id as taken. Anchored on this call's source entity, which
 * seeks the unique `(repositoryId, id)` entity index and expands only that
 * node's outgoing edges. An edge this call wrote always leaves this source;
 * an edge under the same id from another source is another call's, and its
 * absence from the result leaves the refusal standing.
 */
export const RELATIONSHIP_WRITE_ATTEMPT_QUERY = `MATCH (s:_Entity {repositoryId: $rid, id: $sourceEntityId})-[r {repositoryId: $rid, id: $id}]->()
RETURN r.${WRITE_ATTEMPT_PROPERTY} AS writeAttempt
`;

/**
 * Reads whether the repository marker and both endpoints exist, after a
 * create statement failed on a node a concurrent transaction deleted. It
 * runs on the write route so it sees the delete that failed the statement.
 */
const CREATE_PRECONDITIONS_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
OPTIONAL MATCH (s:_Entity {repositoryId: $rid, id: $sourceEntityId})
OPTIONAL MATCH (t:_Entity {repositoryId: $rid, id: $targetEntityId})
RETURN repo IS NOT NULL AS repositoryExists,
  s IS NOT NULL AS sourceExists,
  t IS NOT NULL AS targetExists
`;

/**
 * Create a relationship in one statement and translate its outcome. A
 * caller-supplied id runs `buildCreateRelationshipQuery`, which checks the
 * repository for the id; an id the engine minted (`idMinted`) runs
 * `buildCreateMintedRelationshipQuery`, which does not. Outcomes: a missing
 * repository → `RepositoryNotFoundError`, a missing source or target →
 * `EntityNotFoundError` carrying that endpoint's id, an id already in use in
 * the repository (checked path only) → `DuplicateRelationshipError`, unless
 * the edge under that id carries this call's write token (the driver re-ran
 * a create whose first run committed), which is success.
 *
 * A server may instead refuse the statement with
 * `Neo.ClientError.Statement.EntityNotFound` when a node it locked or
 * matched was deleted while it waited. That can be the repository marker
 * (`deleteRepository` takes the marker lock) or an endpoint (entity deletes
 * do not), so the error alone does not name the cause: one follow-up read
 * looks at all three and the same precedence picks the typed error. When
 * all three exist the original error is the answer, mapped like any other
 * driver error.
 */
export async function createRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  relationship: StoredRelationship,
  idMinted: boolean,
): Promise<StoredRelationship> {
  const cypher = idMinted
    ? buildCreateMintedRelationshipQuery(relationship.relationshipType)
    : buildCreateRelationshipQuery(relationship.relationshipType);
  const writeAttempt = randomUUID();
  const params = { ...relationshipToParams(relationship), writeAttempt };
  let result: QueryResult;
  try {
    result = await conn.executeQuery(cypher, params, { repositoryId });
  } catch (err) {
    if (isDeletedEntityFailure(err)) {
      await throwForMissingPrecondition(conn, repositoryId, relationship);
    }
    mapDriverError(err, {
      kind: 'relationship',
      relationshipId: relationship.id,
      operation: 'createRelationship',
    });
  }

  // The statement emits exactly one row whatever the outcome; anything else
  // is a fault below the data model.
  const outcome: unknown = result.records[0]?.get('outcome');
  if (!isRelationshipCreateOutcome(outcome)) {
    throw new ProviderError(
      `Neo4j createRelationship returned no recognised outcome (got ${JSON.stringify(outcome ?? null)}).`,
    );
  }
  switch (outcome) {
    case RELATIONSHIP_CREATE_OUTCOME.repositoryMissing:
      throw new RepositoryNotFoundError(repositoryId);
    case RELATIONSHIP_CREATE_OUTCOME.sourceMissing:
      throw new EntityNotFoundError(relationship.sourceEntityId);
    case RELATIONSHIP_CREATE_OUTCOME.targetMissing:
      throw new EntityNotFoundError(relationship.targetEntityId);
    case RELATIONSHIP_CREATE_OUTCOME.idExists:
      // The driver re-runs a statement whose commit acknowledgement was
      // lost, and the re-run finds the edge its own first run committed. An
      // edge under this id carrying this call's token proves that, and the
      // create succeeded; any other token is a genuine reuse of the id.
      // A concurrent delete of the edge between the refusal and this
      // read-back leaves nothing to match, so the refusal stands.
      if (
        await relationshipCarriesWriteAttempt(
          conn,
          repositoryId,
          relationship.id,
          relationship.sourceEntityId,
          writeAttempt,
        )
      ) {
        return relationship;
      }
      throw new DuplicateRelationshipError(relationship.id);
    case RELATIONSHIP_CREATE_OUTCOME.created:
      return relationship;
  }
}

/**
 * Whether the edge with `relationshipId` leaving `sourceEntityId` carries
 * `writeAttempt`. Runs on the write route so it sees the commit that made
 * the id taken.
 */
async function relationshipCarriesWriteAttempt(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipId: string,
  sourceEntityId: string,
  writeAttempt: string,
): Promise<boolean> {
  let check: QueryResult;
  try {
    check = await conn.executeQuery(
      RELATIONSHIP_WRITE_ATTEMPT_QUERY,
      { id: relationshipId, sourceEntityId },
      { repositoryId },
    );
  } catch (err) {
    mapDriverError(err, {
      kind: 'relationship',
      relationshipId,
      operation: 'createRelationship',
    });
  }
  return check.records.some((record) => record.get('writeAttempt') === writeAttempt);
}

/**
 * Throw the typed error for the first missing precondition of a
 * relationship create — repository, then source, then target — and return
 * when all three exist.
 */
async function throwForMissingPrecondition(
  conn: Neo4jConnection,
  repositoryId: string,
  relationship: StoredRelationship,
): Promise<void> {
  let check: QueryResult;
  try {
    check = await conn.executeQuery(
      CREATE_PRECONDITIONS_QUERY,
      {
        sourceEntityId: relationship.sourceEntityId,
        targetEntityId: relationship.targetEntityId,
      },
      { repositoryId },
    );
  } catch (err) {
    // The follow-up read can fail on its own (connection loss, timeout); the
    // caller still gets a typed error rather than a raw driver error.
    mapDriverError(err, {
      kind: 'relationship',
      relationshipId: relationship.id,
      operation: 'createRelationship',
    });
  }
  const record = check.records[0];
  if (record === undefined) {
    throw new ProviderError('Neo4j createRelationship precondition check returned no row.');
  }
  if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  if (record.get('sourceExists') !== true) throw new EntityNotFoundError(relationship.sourceEntityId);
  if (record.get('targetExists') !== true) throw new EntityNotFoundError(relationship.targetEntityId);
}

/**
 * Look up a relationship by id, anchored on the repository's entities (see
 * the cost invariant above), together with whether the repository marker
 * exists. The marker is a seek of its unique constraint index; the edge
 * match runs only when it exists, so a relationship a delete in progress has
 * left behind reads as a deleted repository, not as a hit. Both matches are
 * optional, so the statement always returns one row. The `(repositoryId, id)`
 * predicate on the edge is the application-level dedup key.
 */
export const RELATIONSHIP_GET_QUERY =
  'OPTIONAL MATCH (repo:_Repository {repositoryId: $rid}) ' +
  'OPTIONAL MATCH (e:_Entity {repositoryId: $rid})-[r {repositoryId: $rid, id: $relId}]->() ' +
  'WHERE repo IS NOT NULL AND e.id IS NOT NULL ' +
  `RETURN repo IS NOT NULL AS repositoryExists, r IS NOT NULL AS relationshipFound, ${RELATIONSHIP_PROJECTION}`;

/**
 * Look up a relationship by id (`RELATIONSHIP_GET_QUERY`). Returns `null`
 * when no relationship has the id; throws `RepositoryNotFoundError` when the
 * repository marker is absent.
 */
export async function getRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<StoredRelationship | null> {
  // Edges are written directionally — the `->` pattern matches each
  // relationship exactly once. The undirected `-[r]-` variant enumerates both
  // endpoint perspectives and yields each edge twice, which is wasted work
  // for a unique-by-id lookup.
  const result = await conn.executeQuery(
    RELATIONSHIP_GET_QUERY,
    { relId: relationshipId },
    { repositoryId, routing: 'READ' },
  );
  const record = result.records[0];
  if (record === undefined) throw new ProviderError('Neo4j relationship read returned no row.');
  if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  if (record.get('relationshipFound') !== true) return null;
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
 *
 * The data statement also reads the repository marker (see
 * `buildEntityRelationshipQueries`), so a deleted repository throws
 * `RepositoryNotFoundError` rather than reporting an empty page, even while
 * a delete still in progress has left edges behind. The marker rides on the
 * data statement because the count is skipped when property filters apply.
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

  const [dataSettled, countSettled] = await Promise.allSettled([
    conn.executeQuery(dataCypher, params, { repositoryId, routing: 'READ' }),
    hasPropertyFilters
      ? Promise.resolve(null)
      : conn.executeQuery(countCypher, params, { repositoryId, routing: 'READ' }),
  ]);

  // The page carries the marker check, so a missing repository is reported
  // ahead of a failed count.
  const context = { repositoryId, operation: 'getEntityRelationships' };
  const dataResult = settledValue(dataSettled, context);
  const firstRow = dataResult.records[0];
  if (firstRow === undefined) throw new ProviderError('Neo4j relationship read returned no row.');
  if (firstRow.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
  const countResult = settledValue(countSettled, context);
  const rows = dataResult.records.filter((record) => record.get('relationshipFound') === true);

  let items = rows.map((record) => relationshipFromRecord(record));
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
    total !== undefined ? offset + rows.length < total : rows.length === limit;

  return { items, total, hasMore, limit, offset };
}

/**
 * Delete relationships by id, anchored on the repository's entities (see the
 * cost invariant above). Directional pattern — edges are stored
 * directionally, so `->` matches each relationship exactly once. `-[r]-`
 * would double-yield each edge (once per endpoint perspective), producing
 * duplicate ids in the returned `deleted` set.
 *
 * The delete runs only while the repository marker exists (a seek of its
 * unique constraint index). The subquery aggregates, so the statement returns
 * exactly one row (`repositoryExists`, `deleted`) whether or not anything
 * matched; with no marker the subquery deletes nothing.
 */
export const RELATIONSHIP_DELETE_MANY_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
CALL (repo) {
  MATCH (e:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]->()
  WHERE repo IS NOT NULL AND e.id IS NOT NULL AND r.id IN $ids
  WITH r, r.id AS id
  DELETE r
  RETURN collect(id) AS deleted
}
RETURN repo IS NOT NULL AS repositoryExists, deleted`;

/**
 * Bulk delete by ids — single statement. Returns the ids actually deleted
 * (collected from the `DELETE` rows); the `notFound` set is the set
 * difference against the input ids. `deleteByIds` keeps the answer right
 * when the driver re-runs a delete whose commit succeeded, and throws
 * `RepositoryNotFoundError` when the repository marker is absent. Empty
 * input deletes nothing but still reads the marker, so a deleted repository
 * is reported for an empty list too.
 */
export async function deleteRelationships(
  conn: Neo4jConnection,
  repositoryId: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  return deleteByIds(conn, repositoryId, RELATIONSHIP_DELETE_MANY_QUERY, ids, 'deleteRelationships');
}

/**
 * Drop a single relationship by id. Runs the bulk delete statement for one id
 * through `deleteByIds`, so it checks the repository marker in the same
 * statement and is answered correctly when the driver re-runs it: an id an
 * earlier, committed attempt deleted counts as deleted. A missing repository
 * marker → `RepositoryNotFoundError`; an id no attempt found in an existing
 * repository → `RelationshipNotFoundError`.
 */
export async function deleteRelationship(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipId: string,
): Promise<void> {
  const { notFound } = await deleteByIds(
    conn,
    repositoryId,
    RELATIONSHIP_DELETE_MANY_QUERY,
    [relationshipId],
    'deleteRelationship',
  );
  if (notFound.length > 0) throw new RelationshipNotFoundError(relationshipId);
}

/**
 * One batch of a relationship type delete, walked as a keyset cursor over the
 * repository's entities (the shape of `RELATIONSHIP_DRAIN_QUERY`), only while
 * the repository marker exists. The marker is a seek of its unique
 * constraint index. The statement takes the next `$batchSize` entities in id
 * order after `$after` (a range seek of the `(repositoryId, id)` index, read
 * in index order and stopped at the limit; the sort keys repeat the index's
 * key order so no sort is planned) and collects up to `$edgeCap` of their
 * outgoing edges of the type. Matching the typed edge pattern directly would
 * let the planner scan every relationship of the type in the database.
 * Directional pattern: edges are stored directionally, so `->` reaches each
 * relationship exactly once, from its source.
 *
 * The collecting subquery aggregates, so it yields one row whatever matched
 * (no entities and a null `lastId` when the marker is missing), and the
 * unwound list carries a trailing `null` (deleting null is a no-op) so the
 * statement always returns that row. The deletes run `$batchSize` edges per
 * inner transaction at the top level: `IN TRANSACTIONS` cannot nest inside a
 * subquery, and it runs only on an auto-commit session
 * (`Neo4jConnection.executeImplicitInTransactions`). `$edgeCap` bounds the
 * edges buffered before the inner transactions run, whatever the degree of
 * the batch's entities. The statement returns `repositoryExists`, the batch's
 * last entity id as `lastId` and the number of edges it took as `edges`.
 * `$batchSize` and `$edgeCap` must be bound as BigInts so each `LIMIT` sees a
 * Cypher INTEGER.
 *
 * The type slot is interpolated (Cypher 25 cannot parameterise it); callers
 * pass it through `assertSafeRelationshipType` first.
 */
export function buildDeleteRelationshipsByTypeQuery(relType: string): string {
  return `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
CALL (repo) {
  MATCH (e:_Entity {repositoryId: $rid})
  WHERE repo IS NOT NULL AND e.id > $after
  WITH e ORDER BY e.repositoryId ASC, e.id ASC LIMIT $batchSize
  WITH collect(e) AS entities, max(e.id) AS lastId
  CALL (entities) {
    UNWIND entities AS e
    MATCH (e)-[r:${relType} {repositoryId: $rid}]->()
    WITH r LIMIT $edgeCap
    RETURN collect(r) AS batchEdges
  }
  RETURN lastId, batchEdges
}
UNWIND batchEdges + [null] AS r
CALL (r) {
  DELETE r
} IN TRANSACTIONS OF $batchSize ROWS
RETURN repo IS NOT NULL AS repositoryExists, lastId, count(r) AS edges`;
}

/**
 * Drop every relationship of a type in the repository, in batches
 * (`buildDeleteRelationshipsByTypeQuery`), so no single transaction holds a
 * whole type however large it is. The cursor starts at `''`. When a batch
 * took fewer than `edgeCap` edges, its entities have none of the type left
 * and the next batch starts after its `lastId`; at the cap the same batch
 * runs again, since the edges it took are gone. The delete ends when no
 * entity remains past the cursor (`lastId` null). Returns the exact number
 * removed, summed from each batch's update counters (zero when none of the
 * type was left).
 *
 * Every batch checks the repository marker before it deletes anything:
 * `RepositoryNotFoundError` when it is absent, so a missing repository is
 * refused ahead of any delete. The statements run on an auto-commit session,
 * which the driver never re-runs, so a batch's count is never lost to a
 * re-run that finds its own committed delete and reports nothing.
 *
 * A failed batch surfaces as a typed error, transient or not; the batches
 * already committed stay deleted, and calling again removes the rest. A
 * failed batch is not re-run here, unlike an entity type batch: one
 * statement deletes its edges over several inner transactions, and a failure
 * in a later one leaves the earlier ones committed with their counters lost
 * with the statement, so a re-run could not report an exact count. A call
 * that fails after its last deleting inner transaction committed (the
 * connection lost before the acknowledgement, say) has removed the whole
 * type, so a resend of the type delete finds nothing left to remove and the
 * engine answers "not found".
 */
export async function deleteRelationshipsByType(
  conn: Neo4jConnection,
  repositoryId: string,
  relationshipType: string,
  batching: { batchSize: number; edgeCap: number },
): Promise<{ deletedRelationships: number }> {
  const cypher = buildDeleteRelationshipsByTypeQuery(assertSafeRelationshipType(relationshipType));
  const { batchSize, edgeCap } = batching;
  let deletedRelationships = 0;
  let after = '';
  while (true) {
    let result: Awaited<ReturnType<Neo4jConnection['executeImplicitInTransactions']>>;
    try {
      result = await conn.executeImplicitInTransactions(
        cypher,
        { after, batchSize: BigInt(batchSize), edgeCap: BigInt(edgeCap) },
        { repositoryId },
      );
    } catch (err) {
      mapDriverError(err, { repositoryId, operation: 'deleteRelationshipsByType' });
    }
    const record = result.records[0];
    if (record === undefined) throw new ProviderError('Neo4j delete by relationship type returned no row.');
    if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
    deletedRelationships += result.summary.counters.updates()['relationshipsDeleted'] ?? 0;
    // At the cap, the batch's entities may still have edges of the type: run it again.
    if (bigintToSafeNumber(record.get('edges') ?? 0) >= edgeCap) continue;
    const lastId: unknown = record.get('lastId');
    if (typeof lastId !== 'string') break;
    after = lastId;
  }
  return { deletedRelationships };
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
 * Wrap a page read of an entity's relationships so the statement also
 * reports whether the repository marker exists. The marker is a seek of its
 * unique constraint index. `page` returns the relationship projection plus
 * `relationshipFound`, ordered and sliced; it runs only when the marker
 * exists, inside `OPTIONAL CALL`, so the statement returns one row even when
 * the marker is absent or the page is empty (with `relationshipFound` null).
 * The outer sort repeats the page's order over at most `$limit` rows, so the
 * page order does not depend on how the subquery's rows are streamed.
 */
function withRepositoryMarker(page: string): string {
  return (
    'OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})\n' +
    'OPTIONAL CALL (repo) {\n' +
    '  WITH repo WHERE repo IS NOT NULL\n' +
    `  ${page}\n` +
    '}\n' +
    `RETURN repo IS NOT NULL AS repositoryExists, relationshipFound, ${reprojectFromCallScope()} ORDER BY id`
  );
}

/**
 * Assemble the data + count Cypher for a given direction. `'both'` collapses
 * to a single MATCH; the directional cases UNION ALL the natural-direction
 * edges with the inverse-direction bidirectional edges so the bidir read-time
 * hint is exposed from both endpoints without writers duplicating the edge.
 * The data statement carries the repository marker (`withRepositoryMarker`).
 *
 * Count queries wrap the same UNION ALL in a `CALL ( ) { ... }` subquery so
 * `count(*)` aggregates over the unioned row set.
 */
export function buildEntityRelationshipQueries(
  direction: 'out' | 'in' | 'both',
  typeFilter: string,
): { dataCypher: string; countCypher: string } {
  if (direction === 'both') {
    const dataCypher = withRepositoryMarker(
      `MATCH (e:_Entity {repositoryId: $rid, id: $eid})-[r {repositoryId: $rid}]-()${typeFilter} ` +
        `RETURN ${RELATIONSHIP_PROJECTION}, true AS relationshipFound ORDER BY id SKIP $offset LIMIT $limit`,
    );
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

  const dataCypher = withRepositoryMarker(
    `CALL () {\n` +
      `  MATCH ${naturalPattern}${typeFilter} RETURN ${RELATIONSHIP_PROJECTION}\n` +
      `  UNION ALL\n` +
      `  MATCH ${bidirPattern}${typeFilter} RETURN ${RELATIONSHIP_PROJECTION}\n` +
      `}\n` +
      `RETURN ${reprojectFromCallScope()}, true AS relationshipFound ORDER BY id SKIP $offset LIMIT $limit`,
  );

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
