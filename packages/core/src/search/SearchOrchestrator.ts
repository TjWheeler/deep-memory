// SearchOrchestrator — coordinates StorageProvider, SearchProvider, and EmbeddingProvider
// for entity finding and semantic concept search.

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { SearchProvider } from '../providers/SearchProvider.js';
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';
import type { EventBus } from '../core/EventBus.js';
import type { VocabularyEngine } from '../core/VocabularyEngine.js';
import { getEntityTypeDef } from '../vocabulary/VocabularyValidator.js';
import type { DetailLevel, StoredEntity } from '../types/entities.js';
import type {
  FindEntitiesQuery,
  ConceptSearchOptions,
  StorageFindQuery,
} from '../types/queries.js';
import type {
  PaginatedResult,
  ScoredEntity,
  SearchHit,
} from '../types/results.js';
import type { Entity, EntityBrief, EntitySummary } from '../types/entities.js';
import { projectEntity } from '../entities/entityProjection.js';
import { EmbeddingProviderRequiredError } from '../core/errors.js';

export interface SearchOrchestratorConfig {
  repositoryId: string;
  storage: StorageProvider;
  search?: SearchProvider;
  embedding?: EmbeddingProvider;
  eventBus?: EventBus;
  vocabularyEngine?: VocabularyEngine;
  /** Default similarity threshold for semantic search (0.0-1.0, default 0.5) */
  defaultSimilarityThreshold?: number;
  /** Maximum entities to scan for concept search (default 1000). Higher values improve recall at the cost of latency. */
  conceptSearchScanLimit?: number;
}

export class SearchOrchestrator {
  private readonly repositoryId: string;
  private readonly storage: StorageProvider;
  private readonly search?: SearchProvider;
  private embedding?: EmbeddingProvider;
  private readonly eventBus?: EventBus;
  private readonly vocabularyEngine?: VocabularyEngine;
  private readonly defaultSimilarityThreshold: number;
  private readonly conceptSearchScanLimit: number;

  constructor(config: SearchOrchestratorConfig) {
    this.repositoryId = config.repositoryId;
    this.storage = config.storage;
    this.search = config.search;
    this.embedding = config.embedding;
    this.eventBus = config.eventBus;
    this.vocabularyEngine = config.vocabularyEngine;
    this.defaultSimilarityThreshold = config.defaultSimilarityThreshold ?? 0.5;
    this.conceptSearchScanLimit = config.conceptSearchScanLimit ?? 1000;
  }

  /** Swap the embedding provider, e.g. after a repository re-embed changes the model or dimensionality */
  setEmbeddingProvider(embedding: EmbeddingProvider | undefined): void {
    this.embedding = embedding;
  }

  /**
   * Find entities by label, type, and property filters.
   * When a SearchProvider is available, its results are merged with
   * storage-level results for better relevance ranking.
   */
  async findEntities(query: FindEntitiesQuery): Promise<PaginatedResult<Entity | EntitySummary | EntityBrief>> {
    const limit = Math.min(query.limit ?? 10, 50);
    const offset = query.offset ?? 0;
    const detailLevel: DetailLevel = query.detailLevel ?? 'summary';

    const storageQuery: StorageFindQuery = {
      searchTerm: query.searchTerm,
      entityTypes: query.entityTypes,
      properties: query.properties,
      provenance: query.provenance,
      limit,
      offset,
    };

    // If we have a SearchProvider and a search term, merge results
    if (this.search && query.searchTerm) {
      const [storageResult, searchResult] = await Promise.all([
        this.storage.findEntities(this.repositoryId, storageQuery),
        this.search.search(this.repositoryId, query.searchTerm, {
          entityTypes: query.entityTypes,
          limit: limit * 2, // fetch more from search to merge
          offset: 0,
        }),
      ]);

      // Merge: use search result ordering but supplement with storage results
      const merged = this.mergeResults(storageResult.items, searchResult.items, limit, offset, detailLevel);

      await this.emitSearchEvent(query.searchTerm, merged.items.length);

      return merged;
    }

    // No SearchProvider or no search term — delegate to storage only
    const result = await this.storage.findEntities(this.repositoryId, storageQuery);

    if (query.searchTerm) {
      await this.emitSearchEvent(query.searchTerm, result.items.length);
    }

    return {
      items: result.items.map((e) => projectEntity(e, detailLevel)),
      total: result.total,
      hasMore: result.hasMore,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /**
   * Semantic concept search using the EmbeddingProvider.
   * Embeds the query, then compares against entity embeddings.
   * Falls back to label/summary text matching when no embeddings exist on entities.
   */
  async searchByConcept(
    query: string,
    options?: ConceptSearchOptions,
  ): Promise<PaginatedResult<ScoredEntity>> {
    if (!this.embedding) {
      throw new EmbeddingProviderRequiredError();
    }

    const limit = Math.min(options?.limit ?? 10, 50);
    const offset = options?.offset ?? 0;
    const threshold = options?.similarityThreshold ?? this.defaultSimilarityThreshold;

    // Embed the query
    const queryEmbedding = await this.embedding.embed(query);

    // Get all entities (paginated scan — for production, a vector index would be used).
    // Vector-search is the one legitimate consumer of stored embeddings on read,
    // so opt in via the storage `loadEmbeddings` option. Without it, providers
    // that strip embeddings on the wire (Phase 2 CosmosDB perf-fix) return no
    // embeddings and the cosine path falls back to embedding entities on the fly.
    const allEntities = await this.storage.findEntities(
      this.repositoryId,
      {
        entityTypes: options?.entityTypes,
        limit: this.conceptSearchScanLimit,
        offset: 0,
      },
      { loadEmbeddings: true },
    );

    // Score each entity against the query embedding
    const scored: ScoredEntity[] = [];

    for (const entity of allEntities.items) {
      let score: number;

      if (entity.embedding && entity.embedding.length > 0) {
        // Use stored embedding
        score = this.cosineSimilarity(queryEmbedding, entity.embedding);
      } else {
        // Generate embedding on the fly for comparison — include embeddable properties
        const entityText = await this.buildEmbeddingText(entity.entityType, entity.label, entity.summary, entity.properties);
        const entityEmbedding = await this.embedding.embed(entityText);
        score = this.cosineSimilarity(queryEmbedding, entityEmbedding);
      }

      if (score >= threshold) {
        scored.push({
          id: entity.id,
          slug: entity.slug,
          entityType: entity.entityType,
          label: entity.label,
          summary: entity.summary,
          score,
        });
      }
    }

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    const total = scored.length;
    const items = scored.slice(offset, offset + limit);

    await this.emitSearchEvent(query, items.length);

    return {
      items,
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  /** Merge storage results with search provider results */
  private mergeResults(
    storageItems: StoredEntity[],
    searchHits: SearchHit[],
    limit: number,
    offset: number,
    detailLevel: DetailLevel = 'summary',
  ): PaginatedResult<Entity | EntitySummary | EntityBrief> {
    // Build a map of search scores by entity ID
    const scoreMap = new Map<string, number>();
    for (const hit of searchHits) {
      scoreMap.set(hit.id, hit.score);
    }

    // Combine: entities from storage, ranked by search score if available
    const allEntityIds = new Set<string>();
    const rankedItems: Array<{ entity: StoredEntity; score: number }> = [];

    // Add search hits first (higher relevance)
    for (const hit of searchHits) {
      const storageEntity = storageItems.find((e) => e.id === hit.id);
      if (storageEntity) {
        rankedItems.push({ entity: storageEntity, score: hit.score });
        allEntityIds.add(hit.id);
      }
    }

    // Add remaining storage items (not in search results)
    for (const entity of storageItems) {
      if (!allEntityIds.has(entity.id)) {
        rankedItems.push({ entity, score: 0 });
        allEntityIds.add(entity.id);
      }
    }

    // Sort by score descending
    rankedItems.sort((a, b) => b.score - a.score);

    const total = rankedItems.length;
    const page = rankedItems.slice(offset, offset + limit);

    return {
      items: page.map((r) => projectEntity(r.entity, detailLevel)),
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  /** Build the embedding text for an entity — label + summary + embeddable string properties */
  private async buildEmbeddingText(entityType: string, label: string, summary: string | undefined, properties: Record<string, unknown>): Promise<string> {
    const embeddableValues: string[] = [];
    if (this.vocabularyEngine) {
      const vocab = await this.vocabularyEngine.getVocabulary();
      const typeDef = getEntityTypeDef(entityType, vocab);
      if (typeDef) {
        for (const p of typeDef.properties) {
          if (p.embeddable === true && typeof properties[p.name] === 'string') {
            embeddableValues.push(properties[p.name] as string);
          }
        }
      }
    }
    return [label, summary ?? '', ...embeddableValues].filter(Boolean).join(' ');
  }

  /** Cosine similarity between two vectors */
  private cosineSimilarity(a: number[], b: number[]): number {
    // Use provider's similarity if available
    if (this.embedding?.similarity) {
      return this.embedding.similarity(a, b);
    }

    // Fallback: manual cosine similarity
    if (a.length !== b.length || a.length === 0) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      const ai = a[i]!;
      const bi = b[i]!;
      dotProduct += ai * bi;
      normA += ai * ai;
      normB += bi * bi;
    }

    const denominator = Math.sqrt(normA) * Math.sqrt(normB);
    return denominator === 0 ? 0 : dotProduct / denominator;
  }

  private async emitSearchEvent(query: string, resultCount: number): Promise<void> {
    if (this.eventBus) {
      await this.eventBus.emit('search:executed', { query, resultCount });
    }
  }
}

