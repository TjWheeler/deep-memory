// InMemorySearchProvider — basic in-memory full-text search

import type { SearchProvider, SearchableEntity } from '../providers/SearchProvider.js';
import type { SearchOptions } from '../types/queries.js';
import type { PaginatedResult, SearchHit } from '../types/results.js';

interface IndexedEntry {
  entityId: string;
  entityType: string;
  text: string; // concatenated searchable text (lowercased)
}

export class InMemorySearchProvider implements SearchProvider {
  private indices = new Map<string, Map<string, IndexedEntry>>();

  private getIndex(repositoryId: string): Map<string, IndexedEntry> {
    if (!this.indices.has(repositoryId)) {
      this.indices.set(repositoryId, new Map());
    }
    return this.indices.get(repositoryId)!;
  }

  async indexEntity(repositoryId: string, entity: SearchableEntity): Promise<void> {
    const index = this.getIndex(repositoryId);

    // Build searchable text from label, summary, properties, and data
    const parts = [entity.label, entity.summary ?? ''];

    if (entity.properties) {
      for (const value of Object.values(entity.properties)) {
        if (typeof value === 'string') {
          parts.push(value);
        }
      }
    }

    if (entity.data) {
      parts.push(entity.data);
    }

    index.set(entity.entityId, {
      entityId: entity.entityId,
      entityType: entity.entityType,
      text: parts.join(' ').toLowerCase(),
    });
  }

  async removeEntity(repositoryId: string, entityId: string): Promise<void> {
    this.getIndex(repositoryId).delete(entityId);
  }

  async search(
    repositoryId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<PaginatedResult<SearchHit>> {
    const index = this.getIndex(repositoryId);
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);

    if (terms.length === 0) {
      return { items: [], total: 0, hasMore: false, limit: options?.limit ?? 10, offset: options?.offset ?? 0 };
    }

    let hits: Array<{ entry: IndexedEntry; score: number }> = [];

    for (const entry of index.values()) {
      // Filter by entity types
      if (options?.entityTypes && options.entityTypes.length > 0) {
        if (!options.entityTypes.includes(entry.entityType)) continue;
      }

      // Score: count of matching terms / total terms
      let matchCount = 0;
      for (const term of terms) {
        if (entry.text.includes(term)) {
          matchCount++;
        }
      }

      if (matchCount > 0) {
        hits.push({ entry, score: matchCount / terms.length });
      }
    }

    // Sort by score descending
    hits.sort((a, b) => b.score - a.score);

    const total = hits.length;
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;
    const page = hits.slice(offset, offset + limit);

    return {
      items: page.map((h) => ({
        id: h.entry.entityId,
        score: h.score,
      })),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  async reindexRepository(
    repositoryId: string,
    entities: AsyncIterable<SearchableEntity>,
  ): Promise<void> {
    // Clear existing index
    this.indices.set(repositoryId, new Map());

    for await (const entity of entities) {
      await this.indexEntity(repositoryId, entity);
    }
  }
}
