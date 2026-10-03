// Repository-level Cypher queries that depend on the broader storage shape
// (entity counts, relationship counts by type). Repository CRUD lives inline
// on the provider; this module is reserved for read paths that aggregate
// across the repository.

import type { Neo4jConnection } from '../Neo4jConnection.js';
import type { MemoryVocabulary, RepositoryStats } from '@utaba/deep-memory/types';
import { settledValue } from '../errors.js';
import { bigintToSafeNumber } from '../mapping.js';
import { assertRepositoryMarker } from './repositoryDrain.js';

/**
 * Entities-by-type breakdown. One row per distinct `entityType`. Every entity
 * carries the single `:_Entity` umbrella label, so the aggregation groups on
 * `n.entityType` rather than walking per-type labels, and the plan is the
 * same whichever entity types live in the repository.
 *
 * `WHERE n.id IS NOT NULL` lets the planner seek the `(repositoryId, id)`
 * unique index for the repository's entities. A bare `repositoryId` anchor
 * has no index to use and scans every `_Entity` in the database.
 */
export const ENTITY_STATS_QUERY = `
MATCH (n:_Entity {repositoryId: $rid})
WHERE n.id IS NOT NULL
RETURN n.entityType AS type, count(n) AS count
`;

/**
 * Relationships-by-type breakdown. `type(r)` returns the Cypher relationship
 * type exactly as written by `createRelationship`. The pattern is anchored on
 * the repository's entities through the `(repositoryId, id)` unique index
 * (`WHERE e.id IS NOT NULL`) and expands their outgoing edges, so each edge
 * is counted once from its source; `repositoryId` on the edge admits only
 * this repository's relationships. An unanchored relationship pattern would
 * scan every relationship in the database.
 */
export const RELATIONSHIP_STATS_QUERY = `
MATCH (e:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]->()
WHERE e.id IS NOT NULL
RETURN type(r) AS type, count(r) AS count
`;

/**
 * Aggregate repository statistics: entity / relationship totals, per-type
 * breakdowns, vocabulary version.
 *
 * Three server round-trips fire in parallel (`Promise.allSettled`) — the JS driver
 * multiplexes Bolt connections so the queries run concurrently rather than
 * serially: the two counts and a seek of the repository marker. The marker
 * check makes a deleted repository throw `RepositoryNotFoundError` instead of
 * reporting zero counts, even when the caller's vocabulary came from a cache
 * filled before another process deleted it. The vocabulary version comes
 * from the caller-supplied `MemoryVocabulary` value, which the provider
 * sources from its 60 s vocabulary cache.
 *
 * `count(n)` and `count(r)` come back as `BigInt` because the driver runs
 * with `useBigInt: true`. The mapping helper
 * `bigintToSafeNumber` throws when a value exceeds `Number.MAX_SAFE_INTEGER`,
 * so callers never see a silent precision loss on extreme counts.
 *
 * Empty repository: both queries return zero rows; the returned breakdowns
 * are empty maps and the totals are 0. Cross-repository isolation is
 * structural — the `repositoryId` predicate on the anchor entity and on the
 * edge scopes the relationship pattern to this repository regardless of any
 * overlapping entity ids in adjacent repositories.
 */
export async function getRepositoryStats(
  conn: Neo4jConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
): Promise<RepositoryStats> {
  const [entitySettled, relationshipSettled, markerSettled] = await Promise.allSettled([
    conn.executeQuery(ENTITY_STATS_QUERY, {}, { repositoryId, routing: 'READ' }),
    conn.executeQuery(RELATIONSHIP_STATS_QUERY, {}, { repositoryId, routing: 'READ' }),
    assertRepositoryMarker(conn, repositoryId, 'getRepositoryStats', 'READ'),
  ]);
  // The marker first, so a missing repository is reported ahead of a failed count.
  const context = { repositoryId, operation: 'getRepositoryStats' };
  settledValue(markerSettled, context);
  const entityResult = settledValue(entitySettled, context);
  const relationshipResult = settledValue(relationshipSettled, context);

  const entityTypeBreakdown: Record<string, number> = {};
  let entityCount = 0;
  for (const record of entityResult.records) {
    const type = record.get('type');
    if (typeof type !== 'string') continue;
    const count = bigintToSafeNumber(record.get('count') ?? 0);
    entityTypeBreakdown[type] = count;
    entityCount += count;
  }

  const relationshipTypeBreakdown: Record<string, number> = {};
  let relationshipCount = 0;
  for (const record of relationshipResult.records) {
    const type = record.get('type');
    if (typeof type !== 'string') continue;
    const count = bigintToSafeNumber(record.get('count') ?? 0);
    relationshipTypeBreakdown[type] = count;
    relationshipCount += count;
  }

  return {
    entityCount,
    relationshipCount,
    vocabularyVersion: vocabulary.version,
    entityTypeBreakdown,
    relationshipTypeBreakdown,
  };
}
