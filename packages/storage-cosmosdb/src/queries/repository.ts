// Repository CRUD Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type {
  StorageRepositoryConfig,
  StoredRepository,
  StoredRepositorySummary,
  RepositoryFilter,
  RepositoryStats,
  RepositoryUpdate,
} from '@utaba/deep-memory/types';
import type { PaginatedResult, DeleteProgressCallback } from '@utaba/deep-memory/types';
import {
  buildRepositoryProjectChain,
  buildRepositoryPropertyLadder,
  repositoryConfigToLadderBindings,
  repositoryFromGremlin,
} from '../mapping.js';
import {
  DuplicateRepositoryError,
  ProviderError,
  RepositoryNotFoundError,
  createEmptyVocabulary,
} from '@utaba/deep-memory';
import { repoVertexId, vocabVertexId } from './ids.js';
import { submitCreate } from './create.js';
import { getVocabulary } from './vocabulary.js';

const REPO_LABEL = '_repository';

// Sentinel vertex pinned in a fixed `_index` partition. It mirrors the list of
// every repository id in the container so `listRepositories` can be a single
// partition-scoped read rather than a cross-partition scan over every
// `_repository` vertex. ensureSchema bootstraps the sentinel; createRepository
// adds the id in the same submit as the `_repository` vertex (a cross-
// partition `sideEffect`), and deleteRepository removes it as its last step,
// once the repository's partition is empty.
//
// Shape: `repositoryIds: string[]` — flat ids. listRepositories hydrates each
// id via partition-scoped getRepository in parallel. Pagination and any
// `filter.type` narrowing happen client-side after hydration.
export const REPOSITORY_INDEX_VERTEX_ID = '_repository_index';
export const REPOSITORY_INDEX_PARTITION = '_index';
const REPOSITORY_INDEX_LABEL = '_repository_index';

/**
 * Bootstrap the `_repository_index` sentinel vertex.
 *
 * Called once per Cosmos account by {@link CosmosDbProvider.ensureSchema}.
 * If the sentinel is missing, runs the legacy cross-partition
 * `g.V().hasLabel('_repository').values('repositoryId')` scan to collect every
 * existing repository's id and writes the sentinel with that array. This is
 * the only cross-partition Gremlin read the provider makes — it runs once
 * per account on first migration and never again.
 *
 * Returns the number of pre-existing repositories the sentinel was backfilled
 * with, or `null` if the sentinel already existed (no migration needed).
 */
export async function ensureRepositoryIndex(conn: CosmosDbConnection): Promise<number | null> {
  // Cheap existence check — single doc fetch in the `_index` partition.
  const existing = await conn.submit(
    "g.V().has('repositoryId', pk).hasId(sid).count()",
    { pk: REPOSITORY_INDEX_PARTITION, sid: REPOSITORY_INDEX_VERTEX_ID },
  );
  if (Number(existing.items[0] ?? 0) > 0) {
    return null;
  }

  // Sentinel missing — run the legacy cross-partition scan ONCE to collect
  // every existing repo id. After this runs the sentinel is authoritative
  // and the legacy scan is never issued again.
  const scan = await conn.submit(
    "g.V().hasLabel('_repository').values('repositoryId')",
    {},
  );
  const ids = scan.items
    .map((item) => (typeof item === 'string' ? item : String(item ?? '')))
    .filter((id) => id.length > 0);

  await conn.submit(
    "g.addV('" + REPOSITORY_INDEX_LABEL + "')" +
      ".property('id', sid).property('repositoryId', pk).property('repositoryIds', initial)",
    {
      pk: REPOSITORY_INDEX_PARTITION,
      sid: REPOSITORY_INDEX_VERTEX_ID,
      initial: JSON.stringify(ids),
    },
  );

  return ids.length;
}

/**
 * Read the `repositoryIds` array from the sentinel. Returns `[]` if the
 * sentinel is missing — callers that need the sentinel to exist should
 * ensure {@link CosmosDbProvider.ensureSchema} has run first.
 */
async function readRepositoryIndex(conn: CosmosDbConnection): Promise<string[]> {
  const result = await conn.submit(
    "g.V().has('repositoryId', pk).hasId(sid).values('repositoryIds')",
    { pk: REPOSITORY_INDEX_PARTITION, sid: REPOSITORY_INDEX_VERTEX_ID },
  );
  if (result.items.length === 0) return [];
  const raw = result.items[0];
  const json = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Build a .property() chain for Gremlin vertex creation/update. */
function propertyChain(bindings: Record<string, unknown>, props: Record<string, string | number | boolean | null | undefined>, startIndex: number): { chain: string; nextIndex: number } {
  const parts: string[] = [];
  let idx = startIndex;
  for (const [key, value] of Object.entries(props)) {
    if (value == null) continue;
    const paramName = `p${idx++}`;
    bindings[paramName] = value;
    parts.push(`.property('${key}', ${paramName})`);
  }
  return { chain: parts.join(''), nextIndex: idx };
}

// Fixed-shape property ladder for `_repository` vertex creation. The emitted
// query string is identical across every createRepository call regardless of
// which optional fields (description / type / legal / owner / metadata) are
// set, so the server-side plan cache reuses one compiled plan. A trailing
// `.sideEffect(...)` step updates the `_repository_index` sentinel in the
// `_index` partition in the same submit as the addV (a single-submit
// cross-partition mutation; see docs/cosmosdb-gremlin-compatibility.md).
const REPOSITORY_CREATE_QUERY =
  `g.addV('${REPO_LABEL}').property('id', vid).property('repositoryId', rid)${buildRepositoryPropertyLadder()}` +
  ".sideEffect(__.V().has('repositoryId', pk).hasId(sid).property('repositoryIds', updatedIndex))";

// Seeds the repository's `_vocabulary` vertex. The `version` copy is written
// with the blob so compare-and-set in `saveVocabulary` can match from the
// very first write.
const VOCABULARY_CREATE_QUERY =
  "g.addV('_vocabulary').property('id', vid).property('repositoryId', rid)" +
  ".property('version', vocabVersion).property('vocabulary', vocabJson)";

/**
 * Create the `_repository` vertex (plus its sentinel entry) and the
 * repository's `_vocabulary` vertex, seeded from `config.vocabulary` or an
 * empty vocabulary. `saveVocabulary` only ever updates that vertex, so this
 * is where the first stored version comes from.
 *
 * The create is refused unless the repository's partition is empty:
 *
 *   - an existing `_repository` vertex → `DuplicateRepositoryError`;
 *   - anything else in the partition with no `_repository` vertex →
 *     `ProviderError`. That state means a `deleteRepository` dropped the
 *     marker but did not finish its chunked drain; creating on top of it
 *     would leave the old repository's vertices (including a second
 *     vocabulary) under the new one. Re-running `deleteRepository` finishes
 *     the drain, and the message says so because tool surfaces may drop the
 *     suggestion.
 *
 * The vocabulary vertex is written first, then the `_repository` vertex and
 * its sentinel entry, in two submits. If the second fails or never lands
 * (the process dies, or the sentinel `sideEffect` fails on a busy
 * container), the partition holds a vocabulary and no marker: the repository
 * does not exist for any caller (entity / relationship creates are gated on
 * the marker, and `getRepository` finds nothing), a retried create is
 * refused with the "delete did not finish" `ProviderError` above, and
 * `deleteRepository` clears the partition, after which the create succeeds.
 * The opposite order would leave a marker with no vocabulary, which looks
 * like a live repository whose every `saveVocabulary` fails.
 *
 * A create racing a concurrent `deleteRepository` of the same id can land
 * after that delete's drain has passed; re-running `deleteRepository`
 * removes what it left.
 */
export async function createRepository(
  conn: CosmosDbConnection,
  config: StorageRepositoryConfig,
): Promise<StoredRepository> {
  const vertexId = repoVertexId(config.repositoryId);

  // Partition-wide probe: one document read from the repository's own
  // partition (the partition key is the first predicate). Only when it finds
  // something does the marker lookup run to decide which error applies, so
  // the common create pays one round-trip here, as before.
  const occupied = await conn.submit(
    "g.V().has('repositoryId', rid).limit(1).count()",
    { rid: config.repositoryId },
  );
  if (Number(occupied.items[0] ?? 0) > 0) {
    // Partition-scoped via `has('repositoryId', rid)` before `hasId(vid)`;
    // hasId alone is post-routing and fans out across partitions.
    const existing = await conn.submit(
      "g.V().has('repositoryId', rid).hasId(vid).has('label', lbl).count()",
      { vid: vertexId, rid: config.repositoryId, lbl: REPO_LABEL },
    );
    if (Number(existing.items[0] ?? 0) > 0) {
      throw new DuplicateRepositoryError(config.repositoryId);
    }
    throw new ProviderError(
      `Repository "${config.repositoryId}" still holds data from a delete that did not finish; call deleteRepository("${config.repositoryId}") to finish it, then create it again`,
      `Call deleteRepository("${config.repositoryId}") to finish the interrupted delete, then retry createRepository.`,
    );
  }

  // Vocabulary first — see the ordering note above.
  const initialVocabulary = config.vocabulary ?? createEmptyVocabulary(config.createdBy);
  // A 409 on either write means a concurrent create of the same repository
  // got there first.
  const duplicate = (cause: unknown): DuplicateRepositoryError =>
    new DuplicateRepositoryError(config.repositoryId, { cause });
  await submitCreate(
    conn,
    VOCABULARY_CREATE_QUERY,
    {
      vid: vocabVertexId(config.repositoryId),
      rid: config.repositoryId,
      vocabVersion: initialVocabulary.version,
      vocabJson: JSON.stringify(initialVocabulary),
    },
    duplicate,
  );

  // Compute the updated sentinel array client-side before the atomic write.
  // One extra round-trip (the sentinel read), but it lets the actual create
  // submit be a single round-trip that does both the addV and the sentinel
  // update via sideEffect.
  const currentIds = await readRepositoryIndex(conn);
  const updatedIds = currentIds.includes(config.repositoryId)
    ? currentIds
    : [...currentIds, config.repositoryId];

  const bindings: Record<string, unknown> = {
    vid: vertexId,
    rid: config.repositoryId,
    pk: REPOSITORY_INDEX_PARTITION,
    sid: REPOSITORY_INDEX_VERTEX_ID,
    updatedIndex: JSON.stringify(updatedIds),
    ...repositoryConfigToLadderBindings(config),
  };

  await submitCreate(conn, REPOSITORY_CREATE_QUERY, bindings, duplicate);

  return {
    repositoryId: config.repositoryId,
    type: config.type,
    label: config.label,
    description: config.description,
    legal: config.legal,
    owner: config.owner,
    governanceConfig: config.governanceConfig,
    metadata: config.metadata,
    createdAt: config.createdAt,
    createdBy: config.createdBy,
  };
}

export async function getRepository(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<StoredRepository | null> {
  // `has('repositoryId', rid)` scopes the lookup to a single partition before
  // `hasId(vid)`; hasId alone fans out across partitions in Cosmos Gremlin.
  const projection = buildRepositoryProjectChain();
  const result = await conn.submit(
    `g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').${projection}`,
    { vid: repoVertexId(repositoryId), rid: repositoryId },
  );
  if (result.items.length === 0) return null;
  return repositoryFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function listRepositories(
  conn: CosmosDbConnection,
  filter?: RepositoryFilter,
): Promise<PaginatedResult<StoredRepositorySummary>> {
  const limit = filter?.limit ?? 20;
  const offset = filter?.offset ?? 0;

  // Read the sentinel in the fixed `_index` partition — a single partition-
  // scoped lookup. The previous implementation issued a cross-partition
  // `g.V().hasLabel('_repository')` scan that fanned out across every
  // physical partition.
  const repositoryIds = await readRepositoryIndex(conn);

  if (repositoryIds.length === 0) {
    return { items: [], total: 0, hasMore: false, limit, offset };
  }

  // Hydrate each id via the partition-scoped `getRepository`. Parallel because
  // each call hits a different partition; the round-trips are independent.
  const hydrated = await Promise.all(
    repositoryIds.map((rid) => getRepository(conn, rid)),
  );

  // A null from getRepository means the sentinel references a vertex that no
  // longer exists — happens transiently during a partial create/delete or if
  // the sentinel was rebuilt from stale state. Drop those entries; the next
  // create or delete call will resync the sentinel.
  let summaries: StoredRepositorySummary[] = hydrated
    .filter((r): r is StoredRepository => r != null)
    .map((r) => {
      const summary: StoredRepositorySummary = {
        repositoryId: r.repositoryId,
        label: r.label,
        governanceConfig: r.governanceConfig,
      };
      if (r.type !== undefined) summary.type = r.type;
      if (r.description !== undefined) summary.description = r.description;
      return summary;
    });

  if (filter?.type) {
    summaries = summaries.filter((s) => s.type === filter.type);
  }

  const total = summaries.length;
  const items = summaries.slice(offset, offset + limit);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    limit,
    offset,
  };
}

// updateRepository intentionally keeps a variable-shape query (unlike the
// fixed-shape create path). Partial-update semantics would otherwise need a
// three-way discriminator per slot, and `_repository` writes are extremely
// rare (one per repo per config change) so a missed plan-cache is negligible.
export async function updateRepository(
  conn: CosmosDbConnection,
  repositoryId: string,
  updates: RepositoryUpdate,
): Promise<StoredRepository> {
  const vertexId = repoVertexId(repositoryId);

  // Verify exists
  const existing = await getRepository(conn, repositoryId);
  if (!existing) throw new RepositoryNotFoundError(repositoryId);

  // `has('repositoryId', rid)` scopes the update to one partition before
  // `hasId(vid)`; hasId alone fans out across partitions in Cosmos Gremlin.
  const bindings: Record<string, unknown> = { vid: vertexId, rid: repositoryId };
  const props: Record<string, string | number | boolean | null | undefined> = {};

  if (updates.label !== undefined) props['repoLabel'] = updates.label;
  if (updates.description !== undefined) props['description'] = updates.description;
  if (updates.type !== undefined) props['type'] = updates.type;
  if (updates.legal !== undefined) props['legal'] = updates.legal;
  if (updates.owner !== undefined) props['owner'] = updates.owner;
  if (updates.governanceConfig !== undefined) props['governanceConfig'] = JSON.stringify(updates.governanceConfig);
  if (updates.metadata !== undefined) {
    // Shallow merge with existing metadata
    const merged = { ...existing.metadata, ...updates.metadata };
    props['metadata'] = JSON.stringify(merged);
  }

  if (Object.keys(props).length === 0) return existing;

  const { chain } = propertyChain(bindings, props, 0);
  const query = `g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository')${chain}`;
  await conn.submit(query, bindings);

  return (await getRepository(conn, repositoryId))!;
}

const DELETE_BATCH_SIZE = 500;

// Returned by a delete step that found a `_repository` marker for the id it is
// deleting — the repository was re-created under the same id after this
// delete dropped the old marker (see deleteRepository).
const RECREATED_SENTINEL = '__recreated';

// Opens a delete step that only runs while the repository has no marker: when
// a marker exists the step emits RECREATED_SENTINEL and does nothing else;
// otherwise the second branch does the work. That branch starts its own
// lookup with `__.V()`: Cosmos does not resolve a bare `V()` as the first
// step of a coalesce branch, only after another step (`unfold().V()`). The
// check and the work are one traversal.
const UNLESS_RECREATED =
  "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').fold()" +
  `.coalesce(unfold().constant('${RECREATED_SENTINEL}'),`;

// One vertex-drain batch, skipped once a re-create has landed.
export const DELETE_VERTEX_BATCH_QUERY =
  `${UNLESS_RECREATED}__.V().has('repositoryId', rid).limit(batchSize).drop())`;

// One entity-vertex batch of deleteRepository's drain, skipped once a
// re-create has landed. Entities drain ahead of the remaining vertices so the
// delete can report how many entities it removed.
export const DELETE_ENTITY_BATCH_QUERY =
  `${UNLESS_RECREATED}__.V().has('repositoryId', rid).has('entityType').limit(batchSize).drop())`;

// One batch of edges / entity vertices, dropped in one submit that also
// reports what it dropped: the ids of the batch are collected into a bucket
// before the drop and the bucket is returned (the aggregate-then-drop shape of
// `deleteEntities`), so its length is the batch's count. Bounded by
// `batchSize`, so no submit covers the whole repository.
export const EDGE_BATCH_DROP_QUERY =
  "g.E().has('repositoryId', rid).limit(batchSize).aggregate('found').by('id').drop().cap('found')";
export const ENTITY_BATCH_DROP_QUERY =
  "g.V().has('repositoryId', rid).has('entityType').limit(batchSize).aggregate('found').by('id').drop().cap('found')";
// Sizing read for deleteRepository's entity batch, whose drop sits behind the
// re-create guard (DELETE_ENTITY_BATCH_QUERY). Bounded by `batchSize`.
export const ENTITY_BATCH_COUNT_QUERY = "g.V().has('repositoryId', rid).has('entityType').limit(batchSize).count()";
// Whether the repository marker exists: a partition-scoped point read of the
// marker vertex, read before deleteAllContents drains anything.
// `hasNot('entityType')` keeps an entity vertex out of the count: entity
// types are vertex labels, so an entity can carry the `_repository` label,
// and only entity vertices carry `entityType`.
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
  if (Number(count) === 0) throw new RepositoryNotFoundError(repositoryId);
}

// Sentinel cleanup, skipped once a re-create has landed. The marker check runs
// in the repository's partition; the write targets the sentinel in the
// `_index` partition (a cross-partition mutation in one submit, as in
// REPOSITORY_CREATE_QUERY).
export const DELETE_INDEX_ENTRY_QUERY =
  `${UNLESS_RECREATED}__.V().has('repositoryId', pk).hasId(sid).property('repositoryIds', updatedIndex))`;

/**
 * Drop every vertex and edge in the repository's partition, then remove the
 * id from the `_repository_index` sentinel:
 *
 *   1. Drop the `_repository` marker vertex in its own submit. The drain
 *      below spans many submits, and entity / relationship creates are gated
 *      on the marker in the same traversal as their write, so removing it
 *      first makes every later create fail with `RepositoryNotFoundError`
 *      instead of landing after the batch that would have removed it.
 *   2. Probe the partition. If no marker was dropped, decide whether there is
 *      anything to finish: an earlier delete that was interrupted after
 *      step 1 leaves vertices in the partition and/or the id in the
 *      sentinel, and a create interrupted before its marker write leaves its
 *      vocabulary vertex. Only when the partition is empty and the sentinel
 *      does not list the id did the repository never exist: throw
 *      `RepositoryNotFoundError`. Otherwise carry on, so a retry finishes
 *      the interrupted delete.
 *   3. Unless the probe found the partition empty, drain edges, then entity
 *      vertices, then the remaining vertices (the `_vocabulary` / change-log
 *      system vertices), in batches.
 *   4. Remove the id from the sentinel.
 *
 * Steps 3 (vertex batches) and 4 stand down if the repository is re-created
 * under the same id while they run. `createRepository` only proceeds once
 * the partition is empty, which first happens after the last vertex batch,
 * so a re-create can land between that batch and the drain's final
 * remaining-count check, or before the sentinel cleanup. Without a guard the
 * drain would see the new vertices and drop them, and the cleanup would
 * remove the new repository from the sentinel. Each vertex batch and the
 * cleanup therefore check for a marker in the same traversal as their write
 * and do nothing when one exists: everything in the partition at that point
 * belongs to the new repository, so the delete is complete. The check and the
 * write are one submit but not a transaction; a re-create landing inside a
 * single batch traversal is not excluded. Edge batches need no guard: they
 * run while the old repository's vertices still occupy the partition, so no
 * re-create can have started.
 *
 * A create already executing when the marker is dropped can still land after
 * the drain has passed it; re-running `deleteRepository` removes it.
 */
export async function deleteRepository(
  conn: CosmosDbConnection,
  repositoryId: string,
  onProgress?: DeleteProgressCallback,
): Promise<{ deletedEntities: number; deletedRelationships: number }> {
  // Same aggregate-then-drop shape as deleteEntities: the bucket holds the id
  // of the marker actually dropped, so an empty bucket means there was none.
  const marker = await conn.submit(
    "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository')" +
      ".aggregate('found').by('id').drop().cap('found')",
    { rid: repositoryId, vid: repoVertexId(repositoryId) },
  );
  const markerBucket = marker.items[0];
  const markerDropped = Array.isArray(markerBucket) && markerBucket.length > 0;

  // Probe the partition once, whichever way the marker step went. An empty
  // partition has nothing to drain (edges live with their source vertex, so
  // no vertices means no edges): skip straight to the sentinel cleanup.
  const probe = await conn.submit("g.V().has('repositoryId', rid).limit(1).count()", {
    rid: repositoryId,
  });
  const partitionEmpty = Number(probe.items[0] ?? 0) === 0;

  let indexedIds: string[] | null = null;
  if (!markerDropped && partitionEmpty) {
    indexedIds = await readRepositoryIndex(conn);
    if (!indexedIds.includes(repositoryId)) {
      throw new RepositoryNotFoundError(repositoryId);
    }
  }

  const markerVid = repoVertexId(repositoryId);
  let deleted = { deletedEntities: 0, deletedRelationships: 0 };
  if (!partitionEmpty) {
    const drained = await drainPartition(conn, repositoryId, markerVid, onProgress);
    deleted = drained.deleted;
    // Re-created under the same id: what is left belongs to the new
    // repository, and the new create has already listed it in the sentinel.
    if (drained.outcome === 'recreated') return deleted;
  }

  // Remove this repo's id from the sentinel — a property update on the
  // sentinel in the `_index` partition. It runs last: the `_repository`
  // vertex was dropped up front and the drain has emptied the partition, so
  // while any of the repository remains the sentinel still lists it and a
  // retried delete knows there is work left.
  const currentIds = indexedIds ?? (await readRepositoryIndex(conn));
  const updatedIds = currentIds.filter((id) => id !== repositoryId);
  if (updatedIds.length !== currentIds.length) {
    await conn.submit(DELETE_INDEX_ENTRY_QUERY, {
      rid: repositoryId,
      vid: markerVid,
      pk: REPOSITORY_INDEX_PARTITION,
      sid: REPOSITORY_INDEX_VERTEX_ID,
      updatedIndex: JSON.stringify(updatedIds),
    });
  }
  return deleted;
}

/**
 * Drop one batch at a time until a batch drops nothing, reporting each
 * batch's size. Each batch is bounded by the batch size and reports how many
 * it dropped, so the running count comes from the batches themselves rather
 * than a count of the whole repository up front: an unbounded count can
 * outlast a request timeout on a large repository, and then every re-run of
 * the delete would fail the same way. `dropBatch` returns `'recreated'` to
 * stop the drain.
 */
async function drainInBatches(
  dropBatch: () => Promise<number | 'recreated'>,
  onBatch: (dropped: number) => Promise<void>,
): Promise<'drained' | 'recreated'> {
  while (true) {
    const dropped = await dropBatch();
    if (dropped === 'recreated') return 'recreated';
    if (dropped === 0) return 'drained';
    await onBatch(dropped);
  }
}

/**
 * Drop one batch with an aggregate-then-drop query (`EDGE_BATCH_DROP_QUERY`,
 * `ENTITY_BATCH_DROP_QUERY`) and return how many it dropped.
 */
async function dropCountedBatch(conn: CosmosDbConnection, repositoryId: string, query: string): Promise<number> {
  const result = await conn.submit(query, { rid: repositoryId, batchSize: DELETE_BATCH_SIZE });
  const bucket = result.items[0];
  return Array.isArray(bucket) ? bucket.length : 0;
}

/**
 * Drain a repository's partition: edges first (avoids orphan-edge errors),
 * then entity vertices, then the remaining vertices, in batches — a single
 * unbounded drop() times out on large repositories. Each vertex batch stands
 * down when a re-created marker is present (see deleteRepository), reported
 * as `'recreated'`. Returns the edges and entity vertices it dropped.
 */
async function drainPartition(
  conn: CosmosDbConnection,
  repositoryId: string,
  markerVid: string,
  onProgress?: DeleteProgressCallback,
): Promise<{ outcome: 'drained' | 'recreated'; deleted: { deletedEntities: number; deletedRelationships: number } }> {
  let relationshipsDeleted = 0;
  let entitiesDeleted = 0;
  const deleted = (): { deletedEntities: number; deletedRelationships: number } => ({
    deletedEntities: entitiesDeleted,
    deletedRelationships: relationshipsDeleted,
  });

  await drainInBatches(
    () => dropCountedBatch(conn, repositoryId, EDGE_BATCH_DROP_QUERY),
    async (dropped) => {
      relationshipsDeleted += dropped;
      await onProgress?.({ entitiesDeleted, relationshipsDeleted });
    },
  );

  // The entity batch is sized by a bounded read, then dropped behind the
  // re-create guard. The guard's coalesce returns the sentinel or the drop's
  // (empty) output, so the batch's count comes from the sizing read; a write
  // that lands between the two can make one batch's count differ from what
  // it dropped.
  const entities = await drainInBatches(
    async () => {
      const count = await conn.submit(ENTITY_BATCH_COUNT_QUERY, { rid: repositoryId, batchSize: DELETE_BATCH_SIZE });
      const sized = Number(count.items[0] ?? 0);
      if (sized === 0) return 0;
      const batch = await conn.submit(DELETE_ENTITY_BATCH_QUERY, {
        rid: repositoryId,
        vid: markerVid,
        batchSize: DELETE_BATCH_SIZE,
      });
      return batch.items[0] === RECREATED_SENTINEL ? 'recreated' : sized;
    },
    async (dropped) => {
      entitiesDeleted += dropped;
      await onProgress?.({ entitiesDeleted, relationshipsDeleted });
    },
  );
  if (entities === 'recreated') return { outcome: 'recreated', deleted: deleted() };

  // The remaining vertices are system vertices; they are not counted.
  while (true) {
    const batch = await conn.submit(DELETE_VERTEX_BATCH_QUERY, {
      rid: repositoryId,
      vid: markerVid,
      batchSize: DELETE_BATCH_SIZE,
    });
    if (batch.items[0] === RECREATED_SENTINEL) return { outcome: 'recreated', deleted: deleted() };
    const remaining = await conn.submit(
      "g.V().has('repositoryId', rid).limit(1).count()",
      { rid: repositoryId },
    );
    const remainingCount = Number(remaining.items[0] ?? 0);
    if (remainingCount === 0) return { outcome: 'drained', deleted: deleted() };
  }
}

export async function deleteAllContents(
  conn: CosmosDbConnection,
  repositoryId: string,
  onProgress?: DeleteProgressCallback,
): Promise<{ deletedEntities: number; deletedRelationships: number }> {
  // A partition-scoped point read of the marker: a repository that does not
  // exist is refused rather than reported as empty.
  const marker = await conn.submit(REPOSITORY_MARKER_COUNT_QUERY, {
    rid: repositoryId,
    vid: repoVertexId(repositoryId),
  });
  if (Number(marker.items[0] ?? 0) === 0) {
    throw new RepositoryNotFoundError(repositoryId);
  }

  let relationshipsDeleted = 0;
  let entitiesDeleted = 0;

  // Drop edges first (avoids orphan-edge errors), then entity vertices, in
  // bounded batches that report what they dropped (see drainInBatches).
  // Preserves system vertices (_repository, _vocabulary).
  await drainInBatches(
    () => dropCountedBatch(conn, repositoryId, EDGE_BATCH_DROP_QUERY),
    async (dropped) => {
      relationshipsDeleted += dropped;
      await onProgress?.({ entitiesDeleted, relationshipsDeleted });
    },
  );
  await drainInBatches(
    () => dropCountedBatch(conn, repositoryId, ENTITY_BATCH_DROP_QUERY),
    async (dropped) => {
      entitiesDeleted += dropped;
      await onProgress?.({ entitiesDeleted, relationshipsDeleted });
    },
  );

  return { deletedEntities: entitiesDeleted, deletedRelationships: relationshipsDeleted };
}

/**
 * Entity and relationship counts per type, plus the vocabulary version. The
 * vocabulary read also checks the repository marker, so a deleted repository
 * throws `RepositoryNotFoundError` before any count runs instead of reporting
 * zero counts.
 */
export async function getRepositoryStats(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<RepositoryStats> {
  const vocabVersion = (await getVocabulary(conn, repositoryId)).version;

  // Count entities by type (exclude system vertices)
  const entityResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('entityType').group().by('entityType').by(count())",
    { rid: repositoryId },
  );
  const entityTypeBreakdown: Record<string, number> = {};
  let entityCount = 0;
  if (entityResult.items.length > 0) {
    const grouped = entityResult.items[0] as Record<string, number>;
    for (const [type, count] of Object.entries(grouped)) {
      entityTypeBreakdown[type] = Number(count);
      entityCount += Number(count);
    }
  }

  // Count relationships by type
  const relResult = await conn.submit(
    "g.E().has('repositoryId', rid).group().by('relationshipType').by(count())",
    { rid: repositoryId },
  );
  const relationshipTypeBreakdown: Record<string, number> = {};
  let relationshipCount = 0;
  if (relResult.items.length > 0) {
    const grouped = relResult.items[0] as Record<string, number>;
    for (const [type, count] of Object.entries(grouped)) {
      relationshipTypeBreakdown[type] = Number(count);
      relationshipCount += Number(count);
    }
  }

  return {
    entityCount,
    relationshipCount,
    vocabularyVersion: vocabVersion,
    entityTypeBreakdown,
    relationshipTypeBreakdown,
  };
}
