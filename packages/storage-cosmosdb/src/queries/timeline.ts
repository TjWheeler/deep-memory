// Timeline Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { StorageTimelineOptions } from '@utaba/deep-memory/types';
import type { StorageTimelineResult, StorageTimelineEvent } from '@utaba/deep-memory/types';

export async function getTimeline(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  options: StorageTimelineOptions,
): Promise<StorageTimelineResult> {
  const events: StorageTimelineEvent[] = [];

  // Entity creation event
  const entityResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('id', eid).has('entityType').valueMap('createdAt', 'modifiedAt')",
    { rid: repositoryId, eid: entityId },
  );

  if (entityResult.items.length > 0) {
    const props = entityResult.items[0] as Record<string, unknown>;
    const createdAt = unwrapValue(props['createdAt']);
    const modifiedAt = unwrapValue(props['modifiedAt']);

    if (createdAt && isInTimeRange(createdAt, options.timeRange)) {
      events.push({
        timestamp: createdAt,
        eventType: 'entity_created',
        entityId,
      });
    }
    if (modifiedAt && modifiedAt !== createdAt && isInTimeRange(modifiedAt, options.timeRange)) {
      events.push({
        timestamp: modifiedAt,
        eventType: 'entity_modified',
        entityId,
      });
    }
  }

  // Relationship events connected to this entity
  const relResult = await conn.submit(
    "g.V().has('repositoryId', rid).has('id', eid).has('entityType').bothE().valueMap('id', 'createdAt')",
    { rid: repositoryId, eid: entityId },
  );

  for (const item of relResult.items) {
    const props = item as Record<string, unknown>;
    const relId = unwrapValue(props['id']);
    const relCreatedAt = unwrapValue(props['createdAt']);

    if (relCreatedAt && isInTimeRange(relCreatedAt, options.timeRange)) {
      events.push({
        timestamp: relCreatedAt,
        eventType: 'relationship_created',
        entityId,
        relationshipId: relId,
      });
    }
  }

  // Sort by timestamp descending
  events.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

  // Filter by event types
  let filtered = events;
  if (options.eventTypes && options.eventTypes.length > 0) {
    filtered = events.filter(e => options.eventTypes!.includes(e.eventType));
  }

  const total = filtered.length;
  const paged = filtered.slice(options.offset, options.offset + options.limit);

  return { events: paged, total };
}

function unwrapValue(val: unknown): string {
  if (Array.isArray(val) && val.length > 0) return String(val[0]);
  return String(val ?? '');
}

function isInTimeRange(
  timestamp: string,
  timeRange?: { from: string; to: string },
): boolean {
  if (!timeRange) return true;
  return timestamp >= timeRange.from && timestamp <= timeRange.to;
}
