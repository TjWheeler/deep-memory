// MemoryRepository — public API for a single memory repository

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { SearchProvider } from '../providers/SearchProvider.js';
import type { EmbeddingProvider, EmbeddingProviderFactory } from '../providers/EmbeddingProvider.js';
import type {
  CreateEntityInput,
  DeleteEntitiesResult,
  DetailLevel,
  Entity,
  EntityBrief,
  EntitySummary,
  UpdateEntityInput,
} from '../types/entities.js';
import type {
  CreateRelationshipInput,
  EnrichedRelationship,
  Relationship,
  RelationshipSummary,
  RemoveRelationshipsResult,
} from '../types/relationships.js';
import type {
  FindEntitiesQuery,
  ExploreOptions,
  PathOptions,
  TimelineOptions,
  ConceptSearchOptions,
} from '../types/queries.js';
import type { TraversalSpec, TraversalResult } from '../types/traversal.js';
import type { GraphTraversalProvider } from '../providers/GraphTraversalProvider.js';
import type {
  PaginatedResult,
  Neighborhood,
  PathResult,
  GraphResult,
  TimelineEvent,
  TimelineEntityRef,
  TimelineRelationshipDetail,
  TimelineResult,
  ScoredEntity,
  ReembedResult,
  EntityValidationPage,
  RelationshipValidationPage,
  ValidateEntitiesOptions,
  ValidateRelationshipsOptions,
} from '../types/results.js';
import type {
  ResolvedVocabulary,
  VocabularyProposal,
  VocabularyProposalResult,
  RepositoryStats,
} from '../types/index.js';
import type {
  DeepMemoryEventType,
  EventHandler,
  Unsubscribe,
} from '../types/events.js';
import type { VocabularyEngine } from './VocabularyEngine.js';
import type { ProvenanceTracker } from './ProvenanceTracker.js';
import type { EventBus, HookHandler } from './EventBus.js';
import { EntityManager } from '../entities/EntityManager.js';
import { RelationshipManager } from '../relationships/RelationshipManager.js';
import { GraphTraversal } from '../relationships/GraphTraversal.js';
import { SearchOrchestrator } from '../search/SearchOrchestrator.js';
import { RepositoryValidator } from '../validation/RepositoryValidator.js';

export interface MemoryRepositoryConfig {
  repositoryId: string;
  storage: StorageProvider;
  search?: SearchProvider;
  /** Embedding provider configured for this repository's model + dimensions */
  embedding?: EmbeddingProvider;
  /**
   * Factory for producing embedding providers with different model/dimensions.
   * Required only if reembedAll will be called with a new model or dimensions.
   */
  embeddingFactory?: EmbeddingProviderFactory;
  graphTraversal?: GraphTraversalProvider;
  vocabularyEngine: VocabularyEngine;
  provenanceTracker: ProvenanceTracker;
  eventBus: EventBus;
}

export class MemoryRepository {
  readonly repositoryId: string;
  private readonly storage: StorageProvider;
  private readonly search?: SearchProvider;
  private readonly vocabularyEngine: VocabularyEngine;
  private readonly provenanceTracker: ProvenanceTracker;
  private readonly eventBus: EventBus;
  private readonly entityManager: EntityManager;
  private readonly relationshipManager: RelationshipManager;
  private readonly graphTraversal: GraphTraversal;
  private readonly searchOrchestrator: SearchOrchestrator;
  private readonly embeddingFactory?: EmbeddingProviderFactory;
  private embedding?: EmbeddingProvider;

  constructor(config: MemoryRepositoryConfig) {
    this.repositoryId = config.repositoryId;
    this.storage = config.storage;
    this.search = config.search;
    this.vocabularyEngine = config.vocabularyEngine;
    this.provenanceTracker = config.provenanceTracker;
    this.eventBus = config.eventBus;
    this.embedding = config.embedding;
    this.embeddingFactory = config.embeddingFactory;

    this.entityManager = new EntityManager(
      config.repositoryId,
      config.vocabularyEngine,
      config.provenanceTracker,
      config.eventBus,
      config.storage,
      config.embedding,
    );

    this.relationshipManager = new RelationshipManager(
      config.repositoryId,
      config.vocabularyEngine,
      config.provenanceTracker,
      config.eventBus,
      config.storage,
    );

    this.graphTraversal = new GraphTraversal(
      config.repositoryId,
      config.storage,
      config.graphTraversal,
      config.vocabularyEngine,
    );

    this.searchOrchestrator = new SearchOrchestrator({
      repositoryId: config.repositoryId,
      storage: config.storage,
      search: config.search,
      embedding: config.embedding,
      eventBus: config.eventBus,
      vocabularyEngine: config.vocabularyEngine,
      defaultSimilarityThreshold: config.vocabularyEngine.getGovernanceConfig().defaultSimilarityThreshold,
    });
  }

  // ─── Vocabulary ────────────────────────────────────────────────────

  async getVocabulary(): Promise<ResolvedVocabulary> {
    return this.vocabularyEngine.getResolvedVocabulary();
  }

  async proposeVocabularyChange(
    proposal: VocabularyProposal,
  ): Promise<VocabularyProposalResult> {
    const context = this.provenanceTracker.getContext();
    return this.vocabularyEngine.proposeChange(proposal, context.actorId);
  }

  /** @deprecated Use proposeVocabularyChange instead */
  async proposeVocabularyExtension(
    proposal: VocabularyProposal,
  ): Promise<VocabularyProposalResult> {
    return this.proposeVocabularyChange(proposal);
  }

  // ─── Entities ──────────────────────────────────────────────────────

  async createEntities(inputs: CreateEntityInput[]): Promise<Entity[]> {
    const entities = await this.entityManager.create(inputs);

    // Index in search provider if available
    if (this.search) {
      for (const entity of entities) {
        await this.search.indexEntity(this.repositoryId, {
          entityId: entity.id,
          entityType: entity.entityType,
          label: entity.label,
          summary: entity.summary,
          properties: entity.properties,
          data: entity.data,
        });
      }
    }

    return entities;
  }

  async updateEntity(entityId: string, updates: UpdateEntityInput): Promise<Entity> {
    const entity = await this.entityManager.update(entityId, updates);

    // Re-index in search provider if available
    if (this.search) {
      await this.search.indexEntity(this.repositoryId, {
        entityId: entity.id,
        entityType: entity.entityType,
        label: entity.label,
        summary: entity.summary,
        properties: entity.properties,
        data: entity.data,
      });
    }

    return entity;
  }

  async getEntity(
    entityId: string,
    detailLevel?: DetailLevel,
  ): Promise<Entity | EntitySummary | EntityBrief | null> {
    return this.entityManager.get(entityId, detailLevel);
  }

  async getBySlug(
    slug: string,
    detailLevel?: DetailLevel,
  ): Promise<Entity | EntitySummary | EntityBrief | null> {
    return this.entityManager.getBySlug(slug, detailLevel);
  }

  async getEntities(
    entityIds: string[],
    detailLevel?: 'brief' | 'summary',
  ): Promise<Map<string, EntitySummary | EntityBrief>> {
    return this.entityManager.getMany(entityIds, detailLevel);
  }

  async findEntities(query: FindEntitiesQuery): Promise<PaginatedResult<Entity | EntitySummary | EntityBrief>> {
    return this.searchOrchestrator.findEntities(query);
  }

  async deleteEntities(ids: string[]): Promise<DeleteEntitiesResult> {
    const result = await this.entityManager.deleteMany(ids);

    if (this.search && result.deleted.length > 0) {
      for (const id of result.deleted) {
        await this.search.removeEntity(this.repositoryId, id);
      }
    }

    return result;
  }

  // ─── Re-embedding ──────────────────────────────────────────────────

  /** Re-embed specific entities using the current EmbeddingProvider */
  async reembedEntities(entityIds: string[]): Promise<ReembedResult> {
    return this.entityManager.reembedEntities(entityIds);
  }

  /**
   * Re-embed all entities in the repository. If `model` or `dimensions` is provided,
   * the repository's embedding configuration is updated to the new values before
   * re-embedding, so all subsequent entity writes use the new model/dimensionality.
   *
   * Processes in batches with optional rate limiting.
   *
   * Progress is delivered via the optional `onProgress` callback. Most callers
   * should use {@link DeepMemory.reembedAll} instead, which wires this callback
   * to the global event bus so `reembed:*` events are reachable via
   * `DeepMemory.on()`.
   *
   * Updates repository metadata with the new model ID and dimensions on completion.
   */
  async reembedAll(options?: {
    /** New embedding model to switch to. Requires an embeddingFactory on DeepMemory. */
    model?: string;
    /** New embedding dimensionality to switch to. Requires an embeddingFactory on DeepMemory. */
    dimensions?: number;
    batchSize?: number;
    /** Max retries per batch on embedding failure (default 3) */
    maxRetries?: number;
    /** Abort after this many cumulative failures (default: no limit) */
    errorThresholdToAbort?: number;
    /** Milliseconds to wait between batches for rate limiting (default 0) */
    delayBetweenBatchesMs?: number;
    /**
     * Called after each batch completes. Internal plumbing — the {@link DeepMemory}
     * facade wires this to `globalEventBus.emit('reembed:progress', ...)`.
     */
    /**
     * `totalEntities` is `number | undefined` because it derives from
     * PaginatedResult.total, which may be undefined for some provider/query
     * combinations. The {@link DeepMemory.reembedAll} facade coerces it to
     * a number via the cached RepositoryStats before emitting an event.
     */
    onProgress?: (progress: { processed: number; totalEntities: number | undefined; failed: number }) => void | Promise<void>;
    /**
     * Called for every entity that fails to re-embed (embedBatch retries
     * exhausted, or storage write failure). Internal plumbing — the facade
     * wires this to `globalEventBus.emit('reembed:item-failed', ...)`.
     */
    onItemFailed?: (failure: { entityId: string; error: string }) => void | Promise<void>;
    /**
     * Caller-supplied abort signal. Honoured at batch boundaries.
     * Any vectors already written by completed batches are left in place.
     */
    signal?: AbortSignal;
  }): Promise<ReembedResult> {
    // If the caller asked for a model or dimension change, swap in a new provider
    // built from the factory and point every component that uses embeddings at it.
    // This must happen before re-embedding so the new vectors use the new config.
    if (options?.model !== undefined || options?.dimensions !== undefined) {
      if (!this.embeddingFactory) {
        throw new Error(
          'Cannot change embedding model or dimensions: DeepMemory was constructed without an embeddingFactory. ' +
          'Provide embeddingFactory in DeepMemoryConfig to enable per-repository embedding reconfiguration.',
        );
      }
      const currentModel = this.embedding?.modelId();
      // dimensions() throws if unknown — fall back to undefined when the current provider has never embedded
      let currentDimensions: number | undefined;
      try { currentDimensions = this.embedding?.dimensions(); } catch { currentDimensions = undefined; }

      const nextModel = options.model ?? currentModel;
      const nextDimensions = options.dimensions ?? currentDimensions;

      if (!nextModel || nextDimensions === undefined) {
        throw new Error(
          'Cannot rebuild embedding provider: model and dimensions must both be known. ' +
          `Got model="${nextModel ?? 'undefined'}", dimensions=${nextDimensions ?? 'undefined'}.`,
        );
      }

      const newProvider = this.embeddingFactory({ model: nextModel, dimensions: nextDimensions });
      this.embedding = newProvider;
      this.entityManager.setEmbeddingProvider(newProvider);
      this.searchOrchestrator.setEmbeddingProvider(newProvider);

      // Persist the new embedding configuration on the repository itself, so that any
      // subsequent openRepository() call rebuilds a provider with the matching config.
      await this.storage.updateRepository(this.repositoryId, {
        metadata: {
          embeddingModelId: nextModel,
          embeddingDimensions: nextDimensions,
        },
      });
    }

    const result = await this.entityManager.reembedAll({
      batchSize: options?.batchSize,
      maxRetries: options?.maxRetries,
      errorThresholdToAbort: options?.errorThresholdToAbort,
      delayBetweenBatchesMs: options?.delayBetweenBatchesMs,
      signal: options?.signal,
      onProgress: async (processed, total, failed) => {
        await options?.onProgress?.({ processed, totalEntities: total, failed });
      },
      onItemFailed: async (entityId, error) => {
        await options?.onItemFailed?.({ entityId, error });
      },
    });

    // Update repository metadata with the model/dimensions actually produced by the run
    await this.storage.updateRepository(this.repositoryId, {
      metadata: {
        embeddingModelId: result.modelId,
        embeddingDimensions: result.dimensions,
      },
    });

    return result;
  }

  // ─── Relationships ─────────────────────────────────────────────────

  async createRelationships(inputs: CreateRelationshipInput[]): Promise<Relationship[]> {
    return this.relationshipManager.create(inputs);
  }

  async removeRelationships(ids: string[]): Promise<RemoveRelationshipsResult> {
    return this.relationshipManager.removeMany(ids);
  }

  async getRelationships(
    entityId: string,
    options?: { relationshipTypes?: string[]; direction?: 'outbound' | 'inbound' | 'both'; limit?: number; offset?: number; propertyFilters?: import('../types/queries.js').PropertyFilter[] },
  ): Promise<PaginatedResult<Relationship>> {
    return this.relationshipManager.getForEntity(entityId, options);
  }

  async getRelationshipSummary(entityId: string): Promise<RelationshipSummary> {
    const result = await this.storage.getEntityRelationships(
      this.repositoryId,
      entityId,
      { direction: 'both', limit: 10000 },
    );

    const outbound: Record<string, number> = {};
    const inbound: Record<string, number> = {};

    for (const rel of result.items) {
      if (rel.sourceEntityId === entityId) {
        outbound[rel.relationshipType] = (outbound[rel.relationshipType] ?? 0) + 1;
      }
      if (rel.targetEntityId === entityId) {
        inbound[rel.relationshipType] = (inbound[rel.relationshipType] ?? 0) + 1;
      }
    }

    return { outbound, inbound };
  }

  async getRelationshipsForEntities(entityIds: string[]): Promise<Relationship[]> {
    const seen = new Set<string>();
    const results: Relationship[] = [];

    for (const entityId of entityIds) {
      const rels = await this.relationshipManager.getForEntity(entityId, {
        direction: 'both',
        limit: 10000,
      });

      for (const rel of rels.items) {
        if (!seen.has(rel.id)) {
          seen.add(rel.id);
          results.push(rel);
        }
      }
    }

    return results;
  }

  // ─── Graph ─────────────────────────────────────────────────────────

  /** Get the full graph — entities with enriched relationships, vocabulary, and stats. Paginated. */
  async getGraph(options?: { limit?: number; offset?: number; detailLevel?: DetailLevel }): Promise<GraphResult> {
    const pageSize = options?.limit ?? 200;
    const offset = options?.offset ?? 0;

    const [stats, vocabulary] = await Promise.all([
      this.getStats(),
      this.getVocabulary(),
    ]);

    const entities = await this.findEntities({ limit: pageSize, offset, detailLevel: options?.detailLevel ?? 'summary' });

    // Fetch relationships for this page of entities
    const rawRelationships = await this.getRelationshipsForEntities(
      entities.items.map((e) => e.id),
    );

    // Build entity lookup for enrichment
    const entityLookup = new Map<string, { slug: string; label: string }>();
    for (const e of entities.items) {
      entityLookup.set(e.id, { slug: e.slug, label: e.label });
    }

    // Enrich relationships with slug/label, capped at 1000
    const MAX_RELATIONSHIPS = 1000;
    const totalRelationships = rawRelationships.length;
    const cappedRelationships = rawRelationships.slice(0, MAX_RELATIONSHIPS);
    const relationships: EnrichedRelationship[] = cappedRelationships.map((rel) => {
      const source = entityLookup.get(rel.sourceEntityId);
      const target = entityLookup.get(rel.targetEntityId);
      return {
        ...rel,
        sourceSlug: source?.slug ?? rel.sourceEntityId,
        sourceLabel: source?.label ?? rel.sourceEntityId,
        targetSlug: target?.slug ?? rel.targetEntityId,
        targetLabel: target?.label ?? rel.targetEntityId,
      };
    });

    const nextOffset = offset + entities.items.length;
    const hasMore = nextOffset < stats.entityCount;

    return {
      vocabulary,
      stats,
      entities: entities.items,
      relationships,
      totalRelationships,
      relationshipsTruncated: totalRelationships > MAX_RELATIONSHIPS,
      hasMore,
      ...(hasMore ? { cursor: `offset:${nextOffset}` } : {}),
    };
  }

  // ─── Graph Traversal ───────────────────────────────────────────────

  async exploreNeighborhood(
    entityId: string,
    options?: ExploreOptions,
  ): Promise<Neighborhood> {
    return this.graphTraversal.exploreNeighborhood(entityId, options);
  }

  async findPaths(
    sourceId: string,
    targetId: string,
    options?: PathOptions,
  ): Promise<PathResult> {
    return this.graphTraversal.findPaths(sourceId, targetId, options);
  }

  async traverse(spec: TraversalSpec): Promise<TraversalResult> {
    return this.graphTraversal.traverse(spec);
  }

  async executeNativeQuery(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]> {
    return this.graphTraversal.executeNativeQuery(query, params);
  }

  // ─── Search ────────────────────────────────────────────────────────

  async searchByConcept(
    query: string,
    options?: ConceptSearchOptions,
  ): Promise<PaginatedResult<ScoredEntity>> {
    return this.searchOrchestrator.searchByConcept(query, options);
  }

  // ─── Timeline ──────────────────────────────────────────────────────

  async getTimeline(entityId: string, options?: TimelineOptions): Promise<TimelineResult> {
    const storageOptions = {
      timeRange: options?.timeRange,
      eventTypes: options?.eventTypes,
      provenance: options?.provenance,
      limit: options?.limit ?? 20,
      offset: options?.offset ?? 0,
    };

    const storageResult = await this.storage.getTimeline(
      this.repositoryId,
      entityId,
      storageOptions,
    );

    // Get the center entity for slug info
    const entity = await this.storage.getEntity(this.repositoryId, entityId);
    const centerRef: TimelineEntityRef = {
      id: entityId,
      slug: entity?.slug ?? entityId,
      label: entity?.label ?? entityId,
    };

    // Batch-collect all relationship IDs to resolve
    const relIds = storageResult.events
      .filter((e) => e.relationshipId)
      .map((e) => e.relationshipId!);

    // Fetch relationships and collect entity IDs from them
    const relMap = new Map<string, { id: string; type: string; sourceId: string; targetId: string }>();
    const entityIdsToResolve = new Set<string>();

    for (const rid of relIds) {
      const rel = await this.storage.getRelationship(this.repositoryId, rid);
      if (rel) {
        relMap.set(rid, {
          id: rel.id,
          type: rel.relationshipType,
          sourceId: rel.sourceEntityId,
          targetId: rel.targetEntityId,
        });
        entityIdsToResolve.add(rel.sourceEntityId);
        entityIdsToResolve.add(rel.targetEntityId);
      }
    }

    // Batch-fetch all referenced entities
    const entityMap = await this.storage.getEntities(
      this.repositoryId,
      Array.from(entityIdsToResolve),
    );

    const toRef = (eid: string): TimelineEntityRef => {
      const e = entityMap.get(eid);
      return { id: eid, slug: e?.slug ?? eid, label: e?.label ?? eid };
    };

    // Build enriched events
    const events: TimelineEvent[] = storageResult.events.map((e) => {
      if (e.relationshipId && relMap.has(e.relationshipId)) {
        const rel = relMap.get(e.relationshipId)!;
        const sourceRef = toRef(rel.sourceId);
        const targetRef = toRef(rel.targetId);
        const otherRef = rel.sourceId === entityId ? targetRef : sourceRef;
        const direction = rel.sourceId === entityId ? 'to' : 'from';
        const relDetail: TimelineRelationshipDetail = {
          id: rel.id,
          relationshipType: rel.type,
          sourceEntity: sourceRef,
          targetEntity: targetRef,
        };

        return {
          timestamp: e.timestamp,
          eventType: e.eventType,
          description: `${rel.type} relationship created ${direction} ${otherRef.label}`,
          relatedEntities: [centerRef, otherRef],
          relationship: relDetail,
        };
      }

      // Entity events (created/updated)
      const action = e.eventType === 'entity:created' ? 'created' : 'updated';
      return {
        timestamp: e.timestamp,
        eventType: e.eventType,
        description: `${centerRef.label} ${action}`,
        relatedEntities: [centerRef],
      };
    });

    return {
      id: entityId,
      slug: centerRef.slug,
      totalEvents: storageResult.total,
      returned: events.length,
      events,
    };
  }

  // ─── Stats ─────────────────────────────────────────────────────────

  async getStats(): Promise<RepositoryStats> {
    return this.storage.getRepositoryStats(this.repositoryId);
  }

  // ─── Validation ────────────────────────────────────────────────────

  /**
   * Audit a window of entities against the current vocabulary. Returns a single
   * page; callers loop until `done` is true. Paging is over scanned entities,
   * not issues. Does not mutate anything.
   */
  async validateEntities(options?: ValidateEntitiesOptions): Promise<EntityValidationPage> {
    const validator = new RepositoryValidator(
      this.repositoryId,
      this.storage,
      this.vocabularyEngine,
    );
    return validator.validateEntities(options);
  }

  /**
   * Audit a window of relationships against the current vocabulary. Returns a
   * single page; callers loop until `done` is true. The full entity set is
   * loaded once per call to resolve orphan and type-mismatch checks, then
   * offset/take is applied to the relationship stream. Does not mutate anything.
   */
  async validateRelationships(options?: ValidateRelationshipsOptions): Promise<RelationshipValidationPage> {
    const validator = new RepositoryValidator(
      this.repositoryId,
      this.storage,
      this.vocabularyEngine,
    );
    return validator.validateRelationships(options);
  }

  // ─── Bulk Operations ──────────────────────────────────────────────

  /** Delete all entities and relationships in this repository, preserving the repository and vocabulary */
  async deleteAllContents(): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    return this.storage.deleteAllContents(this.repositoryId);
  }

  /**
   * Returns a static markdown guide describing the recommended query strategy
   * for AI agents and other consumers of the repository.
   */
  getQueryGuide(): string {
    return `## Query Strategy Guide

### Step 1 — Discover before you traverse

Before following relationships from an entity, check that it actually has relationships.
Graph queries include \`relationshipSummary\` on every returned entity by default
(outbound and inbound counts by type). Inspect this before traversing — entities with
zero outbound counts for the relationship type you need have no connections to follow.
To skip summaries and reduce response size, set \`includeRelationshipSummary: false\`.

### Step 2 — Use projection for aggregation

To understand what data exists (e.g. all distinct values of a property, or counts by
category), use a graph query with \`projection\` instead of fetching full entities:
\`{ start: { entityType: "..." }, projection: { properties: ["propName"], distinct: true }, limit: 200 }\`

This returns only the aggregated values — no entity objects — keeping responses lightweight.

### Step 3 — Traverse efficiently

- **Omit relationshipTypes** in a traversal step to follow all relationship types at once,
  rather than making separate calls per type.
- **Use multi-step traversals** for multi-hop patterns. A two-step traverse operation
  (e.g. Equipment → Component → MaintenanceProcedure) is one call, not two sequential calls.
- **Use returnMode "all"** when you need intermediate entities along the path, not just
  the terminal nodes.

### Step 4 — Use semantic search for known-unknowns

Semantic/concept search is best for finding specific entities when you know roughly
what you're looking for but not the exact label or type. It is not efficient for broad
discovery — use projection or entity finding for that.

### Common anti-patterns to avoid

- **Don't traverse from entities with zero relationship counts.** The \`relationshipSummary\` on each entity tells you what is connected before you traverse.
- **Don't split queries by relationship type.** One traverse step with no type filter is better
  than three separate single-type calls.
- **Don't use sequential single-hop traversals** when a multi-step traverse operation achieves the
  same result in one call.
- **Don't fetch full entities when you only need property values.** Use projection.`;
  }

  // ─── Events ────────────────────────────────────────────────────────

  on<E extends DeepMemoryEventType>(event: E, handler: EventHandler<E>): Unsubscribe {
    return this.eventBus.on(event, handler);
  }

  onHook<E extends Extract<DeepMemoryEventType, 'entity:creating' | 'entity:updating' | 'entity:deleting' | 'relationship:creating' | 'relationship:removing'>>(
    event: E,
    handler: HookHandler<E>,
  ): Unsubscribe {
    return this.eventBus.onHook(event, handler);
  }
}
