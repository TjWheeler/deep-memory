// Vocabulary Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { PaginationOptions, PaginatedResult } from '@utaba/deep-memory/types';
import { vocabularyFromGremlin, changeRecordFromGremlin } from '../mapping.js';

function vocabVertexId(repositoryId: string): string {
  return `vocab:${repositoryId}`;
}

export async function getVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
): Promise<MemoryVocabulary> {
  const result = await conn.submit(
    "g.V().has('id', vid).hasLabel('_vocabulary').valueMap(true)",
    { vid: vocabVertexId(repositoryId) },
  );
  if (result.items.length === 0) {
    // Return default empty vocabulary
    return {
      version: '0.0.0',
      lastModified: new Date().toISOString(),
      modifiedBy: 'system',
      entityTypes: [],
      relationshipTypes: [],
    };
  }
  return vocabularyFromGremlin(result.items[0] as Record<string, unknown>);
}

export async function saveVocabulary(
  conn: CosmosDbConnection,
  repositoryId: string,
  vocabulary: MemoryVocabulary,
): Promise<void> {
  const vid = vocabVertexId(repositoryId);
  const vocabJson = JSON.stringify(vocabulary);

  // Upsert: try to update existing, create if not found
  const existing = await conn.submit(
    "g.V().has('id', vid).hasLabel('_vocabulary').count()",
    { vid },
  );

  if (Number(existing.items[0] ?? 0) > 0) {
    await conn.submit(
      "g.V().has('id', vid).hasLabel('_vocabulary').property('vocabulary', vocabJson)",
      { vid, vocabJson },
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

  const countResult = await conn.submit(
    "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').count()",
    { rid: repositoryId },
  );
  const total = Number(countResult.items[0] ?? 0);

  const dataResult = await conn.submit(
    "g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').order().by('proposedAt', decr).range(rangeStart, rangeEnd).valueMap(true)",
    { rid: repositoryId, rangeStart: offset, rangeEnd: offset + limit },
  );

  const items = (dataResult.items as Record<string, unknown>[]).map(changeRecordFromGremlin);

  return {
    items,
    total,
    hasMore: offset + limit < total,
    limit,
    offset,
  };
}
