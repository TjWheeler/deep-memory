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
import { DuplicateRepositoryError, RepositoryNotFoundError } from '@utaba/deep-memory';

const REPO_LABEL = '_repository';

// Sentinel vertex pinned in a fixed `_index` partition. It mirrors the list of
// every repository id in the container so `listRepositories` can be a single
// partition-scoped read rather than a cross-partition scan over every
// `_repository` vertex. ensureSchema bootstraps the sentinel; createRepository
// and deleteRepository keep it in sync atomically via single-submit
// cross-partition `sideEffect` updates.
//
// Shape: `repositoryIds: string[]` — flat ids. listRepositories hydrates each
// id via partition-scoped getRepository in parallel. Pagination and any
// `filter.type` narrowing happen client-side after hydration.
export const REPOSITORY_INDEX_VERTEX_ID = '_repository_index';
export const REPOSITORY_INDEX_PARTITION = '_index';
const REPOSITORY_INDEX_LABEL = '_repository_index';

function repoVertexId(repositoryId: string): string {
  return `repo:${repositoryId}`;
}

/**
 * Bootstrap the `_repository_index` sentinel vertex.
 *
 * Called once per Cosmos account by {@link CosmosDbProvider.ensureSchema}.
 * If the sentinel is missing, runs the legacy cross-partition
 * `g.V().hasLabel('_repository').values('repositoryId')` scan to collect every
 * existing repository's id and writes the sentinel with that array. This is
 * the only cross-partition Gremlin read remaining after Phase 11 — it runs
 * once per account on first migration and never again.
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
// `_index` partition atomically with the addV — probe-verified single-submit
// cross-partition mutation on the emulator (2026-05-26).
const REPOSITORY_CREATE_QUERY =
  `g.addV('${REPO_LABEL}').property('id', vid).property('repositoryId', rid)${buildRepositoryPropertyLadder()}` +
  ".sideEffect(__.V().has('repositoryId', pk).hasId(sid).property('repositoryIds', updatedIndex))";

export async function createRepository(
  conn: CosmosDbConnection,
  config: StorageRepositoryConfig,
): Promise<StoredRepository> {
  const vertexId = repoVertexId(config.repositoryId);

  // Existence check — partition-scoped via `has('repositoryId', rid)` before
  // `hasId(vid)`. hasId alone is post-routing and fans out across partitions.
  const existing = await conn.submit(
    "g.V().has('repositoryId', rid).hasId(vid).has('label', lbl).count()",
    { vid: vertexId, rid: config.repositoryId, lbl: REPO_LABEL },
  );
  if (existing.items.length > 0 && Number(existing.items[0]) > 0) {
    throw new DuplicateRepositoryError(config.repositoryId);
  }

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

  await conn.submit(REPOSITORY_CREATE_QUERY, bindings);

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

export async function deleteRepository(
  conn: CosmosDbConnection,
  repositoryId: string,
  onProgress?: DeleteProgressCallback,
): Promise<void> {
  // Get totals for progress reporting
  const entityCountResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('entityType').count()",
    { rid: repositoryId },
  );
  const totalEntities = Number(entityCountResult.items[0] ?? 0);

  const relCountResult = await conn.submit(
    "g.E().has('repositoryId', rid).count()",
    { rid: repositoryId },
  );
  const totalRelationships = Number(relCountResult.items[0] ?? 0);

  let relationshipsDeleted = 0;
  let entitiesDeleted = 0;

  // Drop edges first (avoids orphan-edge errors), then all vertices, in batches.
  // A single unbounded drop() times out on large repositories.
  while (true) {
    await conn.submit(
      "g.E().has('repositoryId', rid).limit(batchSize).drop()",
      { rid: repositoryId, batchSize: DELETE_BATCH_SIZE },
    );
    const remaining = await conn.submit(
      "g.E().has('repositoryId', rid).limit(1).count()",
      { rid: repositoryId },
    );
    const remainingCount = Number(remaining.items[0] ?? 0);
    relationshipsDeleted = totalRelationships - remainingCount;
    await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    if (remainingCount === 0) break;
  }

  while (true) {
    await conn.submit(
      "g.V().has('repositoryId', rid).limit(batchSize).drop()",
      { rid: repositoryId, batchSize: DELETE_BATCH_SIZE },
    );
    const remaining = await conn.submit(
      "g.V().has('repositoryId', rid).limit(1).count()",
      { rid: repositoryId },
    );
    const remainingCount = Number(remaining.items[0] ?? 0);
    entitiesDeleted = totalEntities - remainingCount;
    await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    if (remainingCount === 0) break;
  }

  // Remove this repo's id from the sentinel. The drain above already dropped
  // the `_repository` vertex (it lives in the repo's partition), so this is
  // the only remaining cross-partition write — a property update on the
  // sentinel in the `_index` partition.
  const currentIds = await readRepositoryIndex(conn);
  const updatedIds = currentIds.filter((id) => id !== repositoryId);
  if (updatedIds.length !== currentIds.length) {
    await conn.submit(
      "g.V().has('repositoryId', pk).hasId(sid).property('repositoryIds', updatedIndex)",
      {
        pk: REPOSITORY_INDEX_PARTITION,
        sid: REPOSITORY_INDEX_VERTEX_ID,
        updatedIndex: JSON.stringify(updatedIds),
      },
    );
  }
}

export async function deleteAllContents(
  conn: CosmosDbConnection,
  repositoryId: string,
  onProgress?: DeleteProgressCallback,
): Promise<{ deletedEntities: number; deletedRelationships: number }> {
  // Count before deleting
  const entityCountResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('entityType').count()",
    { rid: repositoryId },
  );
  const totalEntities = Number(entityCountResult.items[0] ?? 0);

  const relCountResult = await conn.submit(
    "g.E().has('repositoryId', rid).count()",
    { rid: repositoryId },
  );
  const totalRelationships = Number(relCountResult.items[0] ?? 0);

  let relationshipsDeleted = 0;
  let entitiesDeleted = 0;

  // Drop edges first (avoids orphan-edge errors), then entity vertices, in batches.
  // Preserves system vertices (_repository, _vocabulary).
  while (true) {
    await conn.submit(
      "g.E().has('repositoryId', rid).limit(batchSize).drop()",
      { rid: repositoryId, batchSize: DELETE_BATCH_SIZE },
    );
    const remaining = await conn.submit(
      "g.E().has('repositoryId', rid).limit(1).count()",
      { rid: repositoryId },
    );
    const remainingCount = Number(remaining.items[0] ?? 0);
    relationshipsDeleted = totalRelationships - remainingCount;
    await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    if (remainingCount === 0) break;
  }

  while (true) {
    await conn.submit(
      "g.V().has('repositoryId', rid).has('entityType').limit(batchSize).drop()",
      { rid: repositoryId, batchSize: DELETE_BATCH_SIZE },
    );
    const remaining = await conn.submit(
      "g.V().has('repositoryId', rid).has('entityType').limit(1).count()",
      { rid: repositoryId },
    );
    const remainingCount = Number(remaining.items[0] ?? 0);
    entitiesDeleted = totalEntities - remainingCount;
    await onProgress?.({ entitiesDeleted, relationshipsDeleted, totalEntities, totalRelationships });
    if (remainingCount === 0) break;
  }

  return { deletedEntities: totalEntities, deletedRelationships: totalRelationships };
}

export async function getRepositoryStats(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<RepositoryStats> {
  // Get vocabulary version
  const vocabResult = await conn.submit(
    "g.V().has('repositoryId', rid).hasLabel('_vocabulary').values('vocabulary')",
    { rid: repositoryId },
  );
  let vocabVersion = '0.0.0';
  if (vocabResult.items.length > 0) {
    try {
      const vocab = JSON.parse(vocabResult.items[0] as string);
      vocabVersion = vocab.version ?? '0.0.0';
    } catch { /* default */ }
  }

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
