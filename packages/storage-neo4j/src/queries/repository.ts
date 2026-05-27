// Repository-level Cypher queries that depend on the broader storage shape
// (entity counts, relationship counts by type). Repository CRUD lives inline
// on the provider; this module is reserved for read paths that aggregate
// across the repository.

import type { Neo4jConnection } from '../Neo4jConnection.js';
import type { MemoryVocabulary, RepositoryStats } from '@utaba/deep-memory/types';
import { bigintToSafeNumber } from '../mapping.js';

/**
 * Entities-by-type breakdown. One row per distinct `entityType`. The single
 * `:_Entity` umbrella label decision (P5 lock) is load-bearing here — the
 * planner aggregates over `n.entityType` rather than walking per-type labels,
 * so the plan is byte-identical regardless of which entity types live in the
 * repository.
 */
const ENTITY_STATS_QUERY = `
MATCH (n:_Entity {repositoryId: $rid})
RETURN n.entityType AS type, count(n) AS count
`;

/**
 * Relationships-by-type breakdown. `type(r)` returns the Cypher relationship
 * type slug exactly as written by `createRelationship`. The pattern endpoints
 * carry the repository predicate explicitly so the planner narrows via the
 * `(repositoryId, id)` constraint's backing index — fanning out across every
 * relationship in the database first would defeat the per-repository scope.
 */
const RELATIONSHIP_STATS_QUERY = `
MATCH (:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]->(:_Entity {repositoryId: $rid})
RETURN type(r) AS type, count(r) AS count
`;

/**
 * Aggregate repository statistics: entity / relationship totals, per-type
 * breakdowns, vocabulary version.
 *
 * Two server round-trips fire in parallel (`Promise.all`) — the JS driver
 * multiplexes Bolt connections so the queries run concurrently rather than
 * serially. The vocabulary version comes from the caller-supplied
 * `MemoryVocabulary` value, which the provider sources from its 60 s
 * vocabulary cache; on a warm cache the stats path costs exactly two round-
 * trips total.
 *
 * `count(n)` and `count(r)` come back as `BigInt` under `useBigInt: true`
 * (D6b lock — confirmed by the Phase 10 probe results). The mapping helper
 * `bigintToSafeNumber` throws when a value exceeds `Number.MAX_SAFE_INTEGER`,
 * so callers never see a silent precision loss on extreme counts.
 *
 * Empty repository: both queries return zero rows; the returned breakdowns
 * are empty maps and the totals are 0. Cross-repository isolation is
 * structural — the `repositoryId` predicate on both endpoints scopes the
 * relationship pattern to this repository regardless of any overlapping
 * entity IDs in adjacent repositories.
 */
export async function getRepositoryStats(
  conn: Neo4jConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
): Promise<RepositoryStats> {
  const [entityResult, relationshipResult] = await Promise.all([
    conn.executeQuery(ENTITY_STATS_QUERY, {}, { repositoryId, routing: 'READ' }),
    conn.executeQuery(RELATIONSHIP_STATS_QUERY, {}, { repositoryId, routing: 'READ' }),
  ]);

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
