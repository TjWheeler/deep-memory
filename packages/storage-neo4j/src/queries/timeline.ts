// Timeline Cypher queries.
//
// The timeline event stream for an entity is the union of:
//   - one `entity:created` event at `n.createdAt`,
//   - one `entity:updated` event at `n.modifiedAt` when `modifiedAt !==
//     createdAt`,
//   - one `relationship:created` event per incident edge (in either direction),
//     keyed by the edge's `createdAt`.
//
// Cypher's `OPTIONAL MATCH + collect()` lifts the union into a single
// round-trip: the centre entity row carries an aggregated list of every
// incident edge regardless of direction. The Cosmos provider needs two
// round-trips for the same information because Gremlin cannot bind an
// aggregated edge list to a vertex projection in one shot — this is a
// platform divergence, not an inherent trade-off.
//
// Event-type strings match the InMemory provider's contract (`entity:created`,
// `entity:updated`, `relationship:created`) — `MemoryRepository.getTimeline`
// reads the storage-level event type unchanged when it builds the
// public-facing description and uses `e.eventType === 'entity:created'` as
// the discriminator for the description string.

import type { Neo4jConnection } from '../Neo4jConnection.js';
import type {
  StorageTimelineEvent,
  StorageTimelineOptions,
  StorageTimelineResult,
} from '@utaba/deep-memory/types';

const ENTITY_CREATED = 'entity:created';
const ENTITY_UPDATED = 'entity:updated';
const RELATIONSHIP_CREATED = 'relationship:created';

/**
 * One-shot Cypher: the centre entity's provenance scalars plus every incident
 * edge's id + createdAt. `[x IN rels WHERE x IS NOT NULL | …]` is load-bearing:
 * `OPTIONAL MATCH` produces a single null sentinel inside `collect()` when no
 * row matches, and the inline filter strips it before the result reaches the
 * client (otherwise the no-edges case would surface as `[null]` rather than
 * `[]`).
 *
 * `collect(DISTINCT r)` dedupes the rare self-loop case where the same edge
 * matches the undirected pattern as both source and target.
 */
const TIMELINE_QUERY = `
MATCH (n:_Entity {repositoryId: $rid, id: $id})
OPTIONAL MATCH (n)-[r {repositoryId: $rid}]-()
WITH n, collect(DISTINCT r) AS rels
RETURN
  n.createdAt AS createdAt,
  n.modifiedAt AS modifiedAt,
  [x IN rels WHERE x IS NOT NULL | {id: x.id, createdAt: x.createdAt}] AS rels
`;

/**
 * Build the timeline event stream for an entity. Returns an empty result when
 * the centre entity does not exist (matching the Cosmos contract — the
 * InMemory provider throws `EntityNotFoundError`, but the storage-level
 * contract leaves the error to higher layers; `MemoryRepository.getTimeline`
 * re-fetches the centre via `getEntity` afterwards regardless).
 *
 * Filter ordering matches the InMemory precedent — `timeRange` first, then
 * `eventTypes`, then descending-timestamp sort, then page. `provenance` is
 * not applied at the storage layer because it requires re-fetching the
 * underlying entity / relationship for each event; `MemoryRepository` handles
 * that enrichment after the storage call returns. This mirrors the Cosmos
 * provider's surface — the storage call returns the raw event stream;
 * provenance filtering lives in the higher layer.
 */
export async function getTimeline(
  conn: Neo4jConnection,
  repositoryId: string,
  entityId: string,
  options: StorageTimelineOptions,
): Promise<StorageTimelineResult> {
  const result = await conn.executeQuery(
    TIMELINE_QUERY,
    { id: entityId },
    { repositoryId, routing: 'READ' },
  );
  const record = result.records[0];
  if (record === undefined) {
    return { events: [], total: 0 };
  }

  const createdAt = record.get('createdAt');
  const modifiedAt = record.get('modifiedAt');
  const relsRaw = record.get('rels');

  const events: StorageTimelineEvent[] = [];

  if (typeof createdAt === 'string' && createdAt.length > 0) {
    events.push({ timestamp: createdAt, eventType: ENTITY_CREATED, entityId });
  }
  if (
    typeof modifiedAt === 'string' &&
    modifiedAt.length > 0 &&
    modifiedAt !== createdAt
  ) {
    events.push({ timestamp: modifiedAt, eventType: ENTITY_UPDATED, entityId });
  }

  if (Array.isArray(relsRaw)) {
    for (const item of relsRaw) {
      if (item === null || typeof item !== 'object') continue;
      const rel = item as { id?: unknown; createdAt?: unknown };
      const relId = rel.id;
      const relCreatedAt = rel.createdAt;
      if (typeof relId !== 'string' || typeof relCreatedAt !== 'string') continue;
      events.push({
        timestamp: relCreatedAt,
        eventType: RELATIONSHIP_CREATED,
        entityId,
        relationshipId: relId,
      });
    }
  }

  let filtered = events;
  if (options.timeRange) {
    const from = options.timeRange.from;
    const to = options.timeRange.to;
    // ISO-8601 Z-suffixed timestamps compare lexicographically in chronological
    // order, same shape used elsewhere (e.g. findEntities provenance.dateRange).
    filtered = filtered.filter((e) => e.timestamp >= from && e.timestamp <= to);
  }
  if (options.eventTypes && options.eventTypes.length > 0) {
    const allow = new Set(options.eventTypes);
    filtered = filtered.filter((e) => allow.has(e.eventType));
  }

  filtered.sort((a, b) => (a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0));

  const total = filtered.length;
  const paged = filtered.slice(options.offset, options.offset + options.limit);

  return { events: paged, total };
}
