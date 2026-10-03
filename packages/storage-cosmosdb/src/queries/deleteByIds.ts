// Delete entities or relationships by id, only while the repository marker
// exists.
//
// A delete of a repository drops its `_repository` marker first and drains
// the data afterwards, across many requests. Until the drain finishes, the
// repository's entities and relationships are still there without a marker.
// A delete by id must treat that repository as gone (`RepositoryNotFoundError`)
// and leave what is left to the drain, ahead of reporting any id as found or
// not found.
//
// Ids go in chunks of 100, each bound alongside `rid` (and, for entities,
// the marker id `mid`). An entity chunk takes one round trip that checks the
// marker and drops in the same request; an edge chunk takes two, a marker
// read and then the drop. Cosmos Gremlin has no transaction across requests, so a
// chunk that finds the marker gone leaves the chunks before it deleted.

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import { ProviderError, RepositoryNotFoundError } from '@utaba/deep-memory';
import { repoVertexId } from './ids.js';
import { assertRepositoryMarker } from './marker.js';

const CHUNK_SIZE = 100;

/** One chunk of ids, bound as `id0`, `id1`, … */
interface IdChunk {
  bindings: Record<string, string>;
  /** `id0, id1, …` — the binding names, for a `within(...)` list. */
  names: string;
}

function idChunks(ids: string[]): IdChunk[] {
  const chunks: IdChunk[] = [];
  for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
    const chunk = ids.slice(i, i + CHUNK_SIZE);
    const bindings: Record<string, string> = {};
    const names: string[] = [];
    chunk.forEach((id, j) => {
      bindings[`id${j}`] = id;
      names.push(`id${j}`);
    });
    chunks.push({ bindings, names: names.join(', ') });
  }
  return chunks;
}

/**
 * Drop the entities among `id0, id1, …` only when the repository marker
 * (`mid`) exists, and report the ids found, in one partition-scoped request:
 *
 *   g.V().has('repositoryId', rid).hasId(within(mid, id0, …))   // marker and targets, one indexed lookup
 *     .or(hasLabel('_repository'), has('entityType'))          // no other system vertex
 *     .aggregate('found').by('id')                              // marker id (if any) and entity ids
 *     .fold().as('vs').unfold()
 *     .hasLabel('_repository').hasNot('entityType')             // continues only past the marker
 *     .select('vs').unfold().has('entityType').drop()           // drops the entities and their edges
 *     .cap('found')
 *
 * `cap` emits the bucket as one list even when no traverser reaches it, so a
 * bucket without `mid` means the repository is missing and nothing was
 * dropped. The marker and the targets come from the first, index-backed step:
 * a mid-traversal `V()` after a barrier costs RU in proportion to the
 * partition's size.
 *
 * The entity type is the vertex label and nothing reserves `_`-prefixed
 * types, so an entity typed `_repository` carries the marker's label too;
 * `hasNot('entityType')` keeps it from passing for the marker. Without it,
 * such an entity would let the drop run with the marker absent, and run it
 * twice with the marker present.
 */
export function buildGuardedEntityDeleteQuery(names: string): string {
  return (
    `g.V().has('repositoryId', rid).hasId(within(mid, ${names}))` +
    ".or(hasLabel('_repository'), has('entityType'))" +
    ".aggregate('found').by('id')" +
    ".fold().as('vs').unfold().hasLabel('_repository').hasNot('entityType')" +
    ".select('vs').unfold().has('entityType').drop()" +
    ".cap('found')"
  );
}

/**
 * Drop the edges among `id0, id1, …`, reporting the ids dropped. Runs after a
 * marker point read: an edge traversal cannot start from the marker vertex in
 * the same indexed step.
 */
export function buildEdgeDeleteQuery(names: string): string {
  return `g.E().has('repositoryId', rid).hasId(within(${names})).aggregate('found').by('id').drop().cap('found')`;
}

/**
 * The ids in a drop's `cap('found')` bucket. `cap` always emits the bucket
 * as a list, so no row, or a row that is not a list, is a malformed response
 * rather than an answer. `what` names the request in the error.
 */
export function bucketIds(items: ReadonlyArray<unknown>, what: string): string[] {
  if (items.length === 0) throw new ProviderError(`Cosmos ${what} returned no row.`);
  const bucket = items[0];
  if (!Array.isArray(bucket)) throw new ProviderError(`Cosmos ${what} returned a row that is not an id list.`);
  return bucket.filter((id): id is string => typeof id === 'string');
}

function split(ids: string[], deleted: string[]): { deleted: string[]; notFound: string[] } {
  const deletedSet = new Set(deleted);
  return { deleted, notFound: ids.filter((id) => !deletedSet.has(id)) };
}

/**
 * Delete entities (and their edges) by id. An empty list deletes nothing but
 * still reads the marker.
 *
 * @throws RepositoryNotFoundError when the marker is absent; the chunk that
 *   finds it absent drops nothing.
 */
export async function deleteEntitiesByIds(
  conn: CosmosDbConnection,
  repositoryId: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  if (ids.length === 0) {
    await assertRepositoryMarker(conn, repositoryId);
    return { deleted: [], notFound: [] };
  }
  const markerId = repoVertexId(repositoryId);
  const deleted: string[] = [];
  for (const chunk of idChunks(ids)) {
    const result = await conn.submit(buildGuardedEntityDeleteQuery(chunk.names), {
      rid: repositoryId,
      mid: markerId,
      ...chunk.bindings,
    });
    const found = bucketIds(result.items, 'guarded entity delete');
    if (!found.includes(markerId)) throw new RepositoryNotFoundError(repositoryId);
    deleted.push(...found.filter((id) => id !== markerId));
  }
  return split(ids, deleted);
}

/**
 * Delete relationships by id: per chunk, a marker point read, then the drop.
 * An empty list deletes nothing but still reads the marker.
 *
 * Source-id partition routing is not exposed here (the public surface accepts
 * only edge ids), so the edge lookup may fan out across partitions — see
 * docs/cosmosdb-gremlin-compatibility.md (`g.E().has` doesn't always push the
 * partition down).
 *
 * @throws RepositoryNotFoundError when the marker is absent; the chunk that
 *   finds it absent drops nothing.
 */
export async function deleteRelationshipsByIds(
  conn: CosmosDbConnection,
  repositoryId: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  if (ids.length === 0) {
    await assertRepositoryMarker(conn, repositoryId);
    return { deleted: [], notFound: [] };
  }
  const deleted: string[] = [];
  for (const chunk of idChunks(ids)) {
    await assertRepositoryMarker(conn, repositoryId);
    const result = await conn.submit(buildEdgeDeleteQuery(chunk.names), { rid: repositoryId, ...chunk.bindings });
    deleted.push(...bucketIds(result.items, 'relationship delete'));
  }
  return split(ids, deleted);
}
