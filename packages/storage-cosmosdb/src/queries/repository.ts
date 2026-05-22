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
import { repositoryFromGremlin, repositorySummaryFromGremlin } from '../mapping.js';
import { DuplicateRepositoryError, RepositoryNotFoundError } from '@utaba/deep-memory';

const REPO_LABEL = '_repository';

function repoVertexId(repositoryId: string): string {
  return `repo:${repositoryId}`;
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

export async function createRepository(
  conn: CosmosDbConnection,
  config: StorageRepositoryConfig,
): Promise<StoredRepository> {
  const vertexId = repoVertexId(config.repositoryId);

  // Check for existing
  const existing = await conn.submit(
    "g.V().has('id', vid).has('label', lbl).count()",
    { vid: vertexId, lbl: REPO_LABEL },
  );
  if (existing.items.length > 0 && Number(existing.items[0]) > 0) {
    throw new DuplicateRepositoryError(config.repositoryId);
  }

  const bindings: Record<string, unknown> = {
    vid: vertexId,
    rid: config.repositoryId,
  };

  const props: Record<string, string | number | boolean | null | undefined> = {
    repoLabel: config.label,
    description: config.description,
    type: config.type,
    legal: config.legal,
    owner: config.owner,
    governanceConfig: JSON.stringify(config.governanceConfig),
    metadata: config.metadata ? JSON.stringify(config.metadata) : undefined,
    createdAt: config.createdAt,
    createdBy: config.createdBy,
  };

  const { chain } = propertyChain(bindings, props, 0);

  const query = `g.addV('${REPO_LABEL}').property('id', vid).property('repositoryId', rid)${chain}`;
  await conn.submit(query, bindings);

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
  const result = await conn.submit(
    "g.V().has('id', vid).hasLabel('_repository').valueMap(true)",
    { vid: repoVertexId(repositoryId) },
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

  let countQuery = "g.V().hasLabel('_repository')";
  let dataQuery = "g.V().hasLabel('_repository')";
  const bindings: Record<string, unknown> = {};

  if (filter?.type) {
    countQuery += ".has('type', filterType)";
    dataQuery += ".has('type', filterType)";
    bindings['filterType'] = filter.type;
  }

  const countResult = await conn.submit(`${countQuery}.count()`, bindings);
  const total = Number(countResult.items[0] ?? 0);

  bindings['rangeStart'] = offset;
  bindings['rangeEnd'] = offset + limit;
  const dataResult = await conn.submit(
    `${dataQuery}.range(rangeStart, rangeEnd).valueMap(true)`,
    bindings,
  );

  const items = (dataResult.items as Record<string, unknown>[]).map(repositorySummaryFromGremlin);

  return {
    items,
    total,
    hasMore: offset + limit < total,
    limit,
    offset,
  };
}

export async function updateRepository(
  conn: CosmosDbConnection,
  repositoryId: string,
  updates: RepositoryUpdate,
): Promise<StoredRepository> {
  const vertexId = repoVertexId(repositoryId);

  // Verify exists
  const existing = await getRepository(conn, repositoryId);
  if (!existing) throw new RepositoryNotFoundError(repositoryId);

  const bindings: Record<string, unknown> = { vid: vertexId };
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
  const query = `g.V().has('id', vid).hasLabel('_repository')${chain}`;
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
