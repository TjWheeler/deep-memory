// Batched drains shared by `deleteRepository` and `deleteAllContents`.
//
// Each statement removes one batch, committing it in inner transactions
// through `CALL () { ... } IN TRANSACTIONS`, so no single transaction holds
// the whole repository. The provider loops on them and reports progress from
// each batch's update counters; nothing counts the repository up front,
// because a whole-repository read can outlast a server timeout and then fail
// every re-run of the delete as well.
//
// Both statements anchor on the repository's entities through the
// `(repositoryId, id)` unique index: the entity drain with
// `WHERE n.id IS NOT NULL`, the relationship drain with a range on `id`. A
// bare `repositoryId` anchor has no index to use and scans every `_Entity`
// in the database, and an unanchored relationship pattern scans every
// relationship in the database. Either would make each batch pay for every
// repository in the store.
//
// `IN TRANSACTIONS` runs only on an auto-commit session, so these go through
// `Neo4jConnection.executeImplicitInTransactions`, which the driver does not
// retry. `$batchSize` and `$edgeCap` must be bound as BigInts so each `LIMIT`
// sees a Cypher INTEGER, not a FLOAT.
//
// The repository marker seek lives here too, because the drains' callers are
// among the calls that must refuse a missing repository before they act.

import { ProviderError, RepositoryNotFoundError } from '@utaba/deep-memory';
import { mapDriverError } from '../errors.js';
import type { ExecuteQueryOptions, Neo4jConnection } from '../Neo4jConnection.js';

/**
 * One batch of the repository's relationships, walked as a keyset cursor
 * over its entities. The statement takes the next `$batchSize` entities in
 * id order after `$after` (a range seek of the `(repositoryId, id)` index,
 * read in index order, so it reads only those entries) and deletes up to
 * `$edgeCap` of their outgoing edges, `$batchSize` edges per inner
 * transaction. It returns the last entity id of the batch as `lastId` and
 * the number of edges it took as `edges`. The sort keys repeat the index's
 * own key order (`repositoryId`, then `id`): ordered that way the planner
 * reads the index in order and stops at the limit, where ordering by `id`
 * alone makes it read and sort every remaining entry for each batch.
 *
 * The provider starts with `$after = ''`. When `edges` is below `$edgeCap`,
 * the batch's entities have no outgoing edges left and the provider passes
 * `lastId` back as the next `$after`. When `edges` reaches the cap, the
 * provider runs the same `$after` again; the edges already taken are
 * deleted, so every repeat removes up to another `$edgeCap` of them. The
 * drain stops when `lastId` is null (no entity remains past the cursor).
 * Each batch of entities is read once, plus once per repeat, so the drain
 * costs about one pass over the repository's entities rather than
 * re-walking the ones already drained. An entity whose id is the empty
 * string does not sort after the initial cursor and is never visited; the
 * entity drain still removes it, with its edges.
 *
 * The planner buffers the collected edges (an `Eager` between reading and
 * deleting them) before the inner transactions run. `$edgeCap` bounds that
 * buffer whatever the degree of the batch's entities: without it, one hub
 * entity could hold enough edges to exceed the transaction memory limit on
 * every re-run, and the delete would never finish. The edges are collected
 * in a subquery, which always yields one row, and the unwound list carries a
 * trailing `null` (deleting null is a no-op), so the statement returns
 * `lastId` even when the batch has no edges.
 *
 * The directed pattern reaches every edge once from its source entity
 * (relationships are written between two entities of their repository), and
 * `repositoryId` on the edge admits only the repository's own edges. An
 * edge whose source is not an `_Entity` can only come from
 * `executeNativeQuery`; the entity drain's `DETACH DELETE` and the
 * provider's untyped node sweep remove those with their nodes. So does the
 * entity drain for an entity created behind the cursor while the drain ran.
 */
export const RELATIONSHIP_DRAIN_QUERY = `MATCH (e:_Entity {repositoryId: $rid})
WHERE e.id > $after
WITH e ORDER BY e.repositoryId ASC, e.id ASC LIMIT $batchSize
WITH collect(e) AS entities, max(e.id) AS lastId
CALL (entities) {
  UNWIND entities AS e
  MATCH (e)-[r {repositoryId: $rid}]->()
  WITH r LIMIT $edgeCap
  RETURN collect(r) AS batchEdges
}
UNWIND batchEdges + [null] AS r
CALL (r) {
  DELETE r
} IN TRANSACTIONS OF $batchSize ROWS
RETURN lastId, count(r) AS edges`;

/**
 * One batch of the repository's entities. `DETACH DELETE` also removes any
 * edge still attached, such as one a create committed after the relationship
 * drain passed; those count in the batch's `relationshipsDeleted`.
 */
export const ENTITY_DRAIN_QUERY = `CALL () {
  MATCH (n:_Entity {repositoryId: $rid})
  WHERE n.id IS NOT NULL
  WITH n LIMIT $batchSize
  DETACH DELETE n
} IN TRANSACTIONS OF $batchSize ROWS`;

/**
 * Whether the repository marker exists, for a call that must refuse a
 * missing repository but has no statement of its own to carry the check
 * (see `assertRepositoryMarker`). `{repositoryId: $rid}` on `_Repository` is
 * a seek of the `dm_repository_unique` constraint index; the statement
 * always returns one row.
 */
export const REPOSITORY_MARKER_EXISTS_QUERY = `OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
RETURN repo IS NOT NULL AS repositoryExists`;

/** The public calls that check the repository marker through `assertRepositoryMarker`. */
export type RepositoryMarkerOperation =
  | 'deleteEntity'
  | 'deleteEntities'
  | 'deleteRelationship'
  | 'deleteRelationships'
  | 'deleteAllContents'
  | 'exploreNeighborhood'
  | 'findPaths'
  | 'exportAll'
  | 'importBulk'
  | 'getRepositoryStats';

/**
 * Throw `RepositoryNotFoundError` unless the repository marker exists
 * (`REPOSITORY_MARKER_EXISTS_QUERY`). `routing` defaults to the connection's
 * write routing; pass `'READ'` for a read-only call. A driver failure is
 * mapped to a typed error carrying `repositoryId` and `operation`; a missing
 * result row is a `ProviderError`.
 */
export async function assertRepositoryMarker(
  conn: Neo4jConnection,
  repositoryId: string,
  operation: RepositoryMarkerOperation,
  routing?: ExecuteQueryOptions['routing'],
): Promise<void> {
  let marker: Awaited<ReturnType<Neo4jConnection['executeQuery']>>;
  try {
    marker = await conn.executeQuery(
      REPOSITORY_MARKER_EXISTS_QUERY,
      {},
      routing !== undefined ? { repositoryId, routing } : { repositoryId },
    );
  } catch (err) {
    mapDriverError(err, { repositoryId, operation });
  }
  const record = marker.records[0];
  if (record === undefined) throw new ProviderError('Neo4j repository marker read returned no row.');
  if (record.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
}
