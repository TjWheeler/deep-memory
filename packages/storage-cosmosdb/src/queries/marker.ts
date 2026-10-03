// Repository-marker checks shared by every repository-scoped call.
//
// A repository is missing once its `_repository` marker vertex is gone, even
// while a delete that has not finished leaves entities, relationships or a
// vocabulary in the partition. Calls check the marker one of two ways:
//
//   - In the same request as the rows (`markerCheckedRead`): the marker is
//     fetched by id in the first, index-backed step together with the
//     entities the call starts from. A mid-traversal `V()` would cost RU in
//     proportion to the partition's size; the first step does not.
//   - With a partition-scoped point read of the marker, where a call starts
//     from an edge, from a label, from a traversal compiled elsewhere, or
//     goes through the Document endpoint, and cannot fetch the marker in its
//     first step: `assertRepositoryMarker` through Gremlin,
//     `assertRepositoryMarkerDocument` through the Document endpoint.
//     `alongsideCheck` runs the point read concurrently with the call's
//     read, so it adds no latency.
//
// The entity type is the vertex label and nothing reserves `_`-prefixed
// types, so an entity typed `_repository` carries the marker's label.
// `hasNot('entityType')` (every entity vertex carries it, the marker never
// does) keeps such an entity from passing for the marker.

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { CosmosDocumentClient } from '../CosmosDocumentClient.js';
import { ProviderError, RepositoryNotFoundError } from '@utaba/deep-memory';
import { repoVertexId } from './ids.js';

// Whether the repository marker exists: a partition-scoped point read of the
// marker vertex.
export const REPOSITORY_MARKER_COUNT_QUERY =
  "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').hasNot('entityType').count()";

/** Throw `RepositoryNotFoundError` unless the marker exists (a partition-scoped point read). */
export async function assertRepositoryMarker(conn: CosmosDbConnection, repositoryId: string): Promise<void> {
  const marker = await conn.submit(REPOSITORY_MARKER_COUNT_QUERY, {
    rid: repositoryId,
    vid: repoVertexId(repositoryId),
  });
  // `count()` always emits a row, so no row is a malformed response, not a
  // missing repository.
  const count = marker.items[0];
  if (count === undefined) throw new ProviderError('Cosmos repository marker read returned no row.');
  const markers = Number(count);
  if (!Number.isFinite(markers)) throw new ProviderError('Cosmos repository marker read returned a count that is not a number.');
  if (markers === 0) throw new RepositoryNotFoundError(repositoryId);
}

/**
 * The repository marker through the Document endpoint: the marker document by
 * id within the partition. `c.label` is the Gremlin label; an entity can carry
 * the `_repository` label, so `NOT IS_DEFINED(c.entityType)` keeps entities out.
 */
export const REPOSITORY_MARKER_SQL =
  "SELECT c.id FROM c WHERE c.id = @mid AND c.label = '_repository' AND NOT IS_DEFINED(c.entityType)";

/**
 * Throw `RepositoryNotFoundError` unless the marker exists, read through the
 * Document endpoint (a partition-scoped query by id), for calls that run
 * their own reads there.
 */
export async function assertRepositoryMarkerDocument(
  docClient: CosmosDocumentClient,
  repositoryId: string,
): Promise<void> {
  const marker = await docClient.query<{ id: string }>(
    REPOSITORY_MARKER_SQL,
    [{ name: '@mid', value: repoVertexId(repositoryId) }],
    { partitionKey: repositoryId },
  );
  if (marker.documents.length === 0) throw new RepositoryNotFoundError(repositoryId);
}

/**
 * Run `read` concurrently with a repository check. A failed check wins over
 * whatever the read answered, including the read's own failure, so the
 * caller sees `RepositoryNotFoundError` ahead of any empty, not-found or
 * read-failure outcome. Both are always awaited to completion, so neither is
 * left running unobserved (and the usage of both is tracked) when the other
 * fails first. Each starts through `Promise.resolve().then`, so a
 * synchronous throw from either becomes a rejection instead of escaping
 * before the other has been awaited.
 */
export async function alongsideCheck<T>(check: () => Promise<void>, read: () => Promise<T>): Promise<T> {
  const [checked, result] = await Promise.allSettled([Promise.resolve().then(check), Promise.resolve().then(read)]);
  if (checked.status === 'rejected') throw checked.reason;
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

/** `alongsideCheck` with the Gremlin marker point read as the check. */
export async function alongsideMarkerRead<T>(
  conn: CosmosDbConnection,
  repositoryId: string,
  read: () => Promise<T>,
): Promise<T> {
  return alongsideCheck(() => assertRepositoryMarker(conn, repositoryId), read);
}

/** What the marker's branch of a marker-checked read emits. */
export const REPOSITORY_PRESENT = '__repository';

/** The marker's branch of a marker-checked read. */
export const MARKER_BRANCH = `__.hasLabel('_repository').hasNot('entityType').constant('${REPOSITORY_PRESENT}')`;

/**
 * Build a read that returns the repository marker along with its rows, in
 * one partition-scoped request:
 *
 *   g.V().has('repositoryId', rid).<start>
 *     .union(__.hasLabel('_repository').hasNot('entityType').constant('__repository'),
 *            __.has('entityType').<entitySteps>)
 *
 * `start` selects the marker (bound as `mid`) together with the entities:
 * `hasId(within(mid, …))` for ids, or `or(__.hasId(mid), __.has(…))` for a
 * property lookup. Both are served by the first, index-backed step, and cost
 * the same as the read without the marker at any repository size.
 *
 * `entitySteps` must emit maps (a vertex or edge projection, a `valueMap`),
 * never bare strings: `rowsPastMarker` tells the marker's row apart by its
 * string value, so a bare string row equal to it would be taken for the
 * marker.
 */
export function markerCheckedRead(start: string, entitySteps: string): string {
  return `g.V().has('repositoryId', rid).${start}.union(${MARKER_BRANCH}, __.has('entityType').${entitySteps})`;
}

/**
 * The rows of a `markerCheckedRead` other than the marker's.
 *
 * @throws RepositoryNotFoundError when the marker's row is absent.
 */
export function rowsPastMarker(items: unknown[], repositoryId: string): unknown[] {
  let repositoryExists = false;
  const rows: unknown[] = [];
  for (const item of items) {
    if (item === REPOSITORY_PRESENT) repositoryExists = true;
    else rows.push(item);
  }
  if (!repositoryExists) throw new RepositoryNotFoundError(repositoryId);
  return rows;
}
