// Vocabulary Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { PaginationOptions, PaginatedResult } from '@utaba/deep-memory/types';
import { changeRecordFromGremlin } from '../mapping.js';

function vocabVertexId(repositoryId: string): string {
  return `vocab:${repositoryId}`;
}

const EMPTY_VOCABULARY = (): MemoryVocabulary => ({
  version: '0.0.0',
  lastModified: new Date().toISOString(),
  modifiedBy: 'system',
  entityTypes: [],
  relationshipTypes: [],
});

export async function getVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  // We only ever read the JSON-stringified `vocabulary` property; the full
  // valueMap(true) shipped every property on the vocab vertex (label,
  // repositoryId, etc.) for no reason. `.values('vocabulary').limit(1)`
  // returns just the JSON string — smaller wire payload, single column read.
  //
  // `has('repositoryId', rid)` scopes the lookup to a single partition before
  // `hasId(vid)`; `hasId` is post-routing in Cosmos Gremlin and fans out
  // across all partitions without the partition predicate.
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').values('vocabulary').limit(1)",
    { vid: vocabVertexId(repositoryId), rid: repositoryId },
  );
  if (result.items.length === 0) return EMPTY_VOCABULARY();
  const raw = result.items[0];
  const json = typeof raw === 'string' ? raw : String(raw ?? '');
  if (!json) return EMPTY_VOCABULARY();
  try {
    return JSON.parse(json) as MemoryVocabulary;
  } catch {
    return EMPTY_VOCABULARY();
  }
}

export async function saveVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
): Promise<void> {
  const vid = vocabVertexId(repositoryId);
  const vocabJson = JSON.stringify(vocabulary);

  // Upsert: try to update existing, create if not found.
  // Both branches scope by `has('repositoryId', rid)` before `hasId(vid)` —
  // hasId alone fans out across all partitions in Cosmos Gremlin.
  const existing = await conn.submit(
    "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').count()",
    { vid, rid: repositoryId },
  );

  if (Number(existing.items[0] ?? 0) > 0) {
    await conn.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').property('vocabulary', vocabJson)",
      { vid, rid: repositoryId, vocabJson },
    );
  } else {
    await conn.submit(
      "g.addV('_vocabulary').property('id', vid).property('repositoryId', rid).property('vocabulary', vocabJson)",
      { vid, rid: repositoryId, vocabJson },
    );
  }
}

export async function getVocabularyChangeLog(
  conn: CosmosDbConnection,
  repositoryId: string,
  options?: PaginationOptions,
): Promise<PaginatedResult<VocabularyChangeRecord>> {
  const limit = options?.limit ?? 10;
  const offset = options?.offset ?? 0;

  // Count and data round-trips are independent — run them in parallel. No
  // property filters here, so the count is exact and `total` is always a number.
  const [countResult, dataResult] = await Promise.all([
    conn.submit(
      "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').count()",
      { rid: repositoryId },
    ),
    conn.submit(
      "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').order().by('proposedAt', decr).range(rangeStart, rangeEnd).valueMap(true)",
      { rid: repositoryId, rangeStart: offset, rangeEnd: offset + limit },
    ),
  ]);

  const total = Number(countResult.items[0] ?? 0);
  const items = (dataResult.items as Record<string, unknown>[]).map(changeRecordFromGremlin);

  return {
    items,
    total,
    hasMore: offset + items.length < total,
    limit,
    offset,
  };
}
