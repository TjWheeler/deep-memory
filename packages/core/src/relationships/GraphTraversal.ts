// GraphTraversal — BFS neighborhood exploration, path finding, and
// structured multi-hop traversal.
// Sits between MemoryRepository and StorageProvider, mapping storage-level
// results to the public Neighborhood, PathResult, and TraversalResult types.

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { GraphTraversalProvider } from '../providers/GraphTraversalProvider.js';
import type {
  ExploreOptions,
  PathOptions,
} from '../types/queries.js';
import type { DetailLevel } from '../types/entities.js';
import type { VocabularyEngine } from '../core/VocabularyEngine.js';
import type {
  Neighborhood,
  NeighborhoodLayer,
  PathResult,
} from '../types/results.js';
import type { TraversalSpec, TraversalResult } from '../types/traversal.js';
import { projectEntity } from '../entities/entityProjection.js';
import { EntityNotFoundError, GraphTraversalProviderRequiredError, TraversalValidationError, TraversalVocabularyError } from '../core/errors.js';
import { validateTraversalSpec } from './TraversalValidator.js';
import { executeFallbackTraversal } from './FallbackTraversalExecutor.js';

export class GraphTraversal {
  constructor(
    private readonly repositoryId: string,
    private readonly storage: StorageProvider,
    private readonly graphTraversalProvider?: GraphTraversalProvider,
    private readonly vocabularyEngine?: VocabularyEngine,
  ) {}

  /** BFS neighborhood exploration from a center entity */
  async exploreNeighborhood(
    entityId: string,
    options?: ExploreOptions,
  ): Promise<Neighborhood> {
    const storageOptions = {
      depth: options?.depth ?? 1,
      relationshipTypes: options?.relationshipTypes,
      entityTypes: options?.entityTypes,
      direction: options?.direction ?? 'both' as const,
      limitPerType: options?.limitPerType ?? 10,
      offsetPerType: options?.offsetPerType ?? 0,
      relationshipPropertyFilters: options?.relationshipPropertyFilters,
    };

    const storageResult = await this.storage.exploreNeighborhood(
      this.repositoryId,
      entityId,
      storageOptions,
    );

    // Get the center entity for the public response
    const centerEntity = await this.storage.getEntity(this.repositoryId, entityId);
    if (!centerEntity) {
      throw new EntityNotFoundError(entityId);
    }

    // Map storage layers to public layers with statistics
    const detailLevel: DetailLevel = options?.detailLevel ?? 'summary';
    let totalEntities = 0;
    let returnedEntities = 0;
    const truncatedTypes: string[] = [];

    const layers: NeighborhoodLayer[] = storageResult.layers.map((storageLayer) => {
      const layer: NeighborhoodLayer = {};

      for (const [relType, group] of Object.entries(storageLayer)) {
        totalEntities += group.total;
        returnedEntities += group.entities.length;

        if (group.entities.length < group.total && !truncatedTypes.includes(relType)) {
          truncatedTypes.push(relType);
        }

        layer[relType] = {
          total: group.total,
          returned: group.entities.length,
          entities: group.entities.map((e) => projectEntity(e, detailLevel)),
        };
      }

      return layer;
    });

    return {
      center: {
        id: centerEntity.id,
        slug: centerEntity.slug,
        entityType: centerEntity.entityType,
        label: centerEntity.label,
      },
      layers,
      statistics: {
        totalEntities,
        returnedEntities,
        truncatedTypes,
      },
    };
  }

  /** BFS shortest path finding between two entities */
  async findPaths(
    sourceId: string,
    targetId: string,
    options?: PathOptions,
  ): Promise<PathResult> {
    const storageOptions = {
      maxDepth: options?.maxDepth ?? 3,
      relationshipTypes: options?.relationshipTypes,
      entityTypes: options?.entityTypes,
      limit: options?.limit ?? 5,
      offset: options?.offset ?? 0,
      relationshipPropertyFilters: options?.relationshipPropertyFilters,
    };

    const storageResult = await this.storage.findPaths(
      this.repositoryId,
      sourceId,
      targetId,
      storageOptions,
    );

    // Collect all entity and relationship IDs for batch lookup
    const entityIdSet = new Set<string>();
    const relIdSet = new Set<string>();
    for (const path of storageResult.paths) {
      for (const eid of path.entityIds) entityIdSet.add(eid);
      for (const rid of path.relationshipIds) relIdSet.add(rid);
    }

    // Batch fetch entities
    const entityMap = await this.storage.getEntities(
      this.repositoryId,
      Array.from(entityIdSet),
    );

    // Fetch relationships individually
    const relMap = new Map<string, { id: string; type: string; sourceEntityId: string; properties: Record<string, unknown> }>();
    for (const rid of relIdSet) {
      const rel = await this.storage.getRelationship(this.repositoryId, rid);
      if (rel) {
        relMap.set(rid, {
          id: rel.id,
          type: rel.relationshipType,
          sourceEntityId: rel.sourceEntityId,
          properties: rel.properties,
        });
      }
    }

    // Filter paths by entity types if specified
    const entityTypeFilter = options?.entityTypes;
    const filteredPaths = entityTypeFilter
      ? storageResult.paths.filter((sp) =>
          sp.entityIds.every((eid) => {
            const e = entityMap.get(eid);
            return e ? entityTypeFilter.includes(e.entityType) : true;
          }),
        )
      : storageResult.paths;

    const pathDetailLevel: DetailLevel = options?.detailLevel ?? 'brief';

    return {
      totalPaths: entityTypeFilter ? filteredPaths.length : storageResult.totalPaths,
      returned: filteredPaths.length,
      paths: filteredPaths.map((sp) => ({
        length: sp.entityIds.length - 1,
        entities: sp.entityIds.map((eid) => {
          const e = entityMap.get(eid);
          if (e) return projectEntity(e, pathDetailLevel);
          return {
            id: eid,
            slug: eid,
            entityType: 'unknown',
            label: eid,
            summary: undefined,
          };
        }),
        relationships: sp.relationshipIds.map((rid, idx) => {
          const r = relMap.get(rid);
          const currentEntityId = sp.entityIds[idx];
          return {
            id: rid,
            type: r?.type ?? 'unknown',
            direction: r?.sourceEntityId === currentEntityId ? 'outbound' : 'inbound',
            properties: r?.properties ?? {},
          };
        }),
      })),
    };
  }

  /**
   * Execute a structured traversal.
   * Validates the spec, delegates to the GraphTraversalProvider if one is
   * registered (the provider owns native compilation), or falls back to
   * application-level BFS over StorageProvider.
   */
  async traverse(spec: TraversalSpec): Promise<TraversalResult> {
    // 1. Validate spec against structural rules and vocabulary
    const capabilities = this.graphTraversalProvider?.getCapabilities();
    const vocabulary = this.vocabularyEngine
      ? await this.vocabularyEngine.getVocabulary()
      : undefined;
    const validation = validateTraversalSpec(spec, vocabulary, capabilities);

    if (!validation.valid) {
      // Separate vocabulary errors from structural errors
      const vocabErrors = validation.errors.filter((e) => e.startsWith('Unknown vocabulary types:'));
      const structErrors = validation.errors.filter((e) => !e.startsWith('Unknown vocabulary types:'));

      if (vocabErrors.length > 0) {
        const unknownTypes = vocabErrors.join('; ')
          .replace(/Unknown vocabulary types: /g, '')
          .split(', ')
          .map((t) => t.trim());
        throw new TraversalVocabularyError(unknownTypes);
      }

      throw new TraversalValidationError(structErrors.length > 0 ? structErrors : validation.errors);
    }

    // 2. If GraphTraversalProvider registered, delegate — the provider owns
    //    compilation to its native dialect.
    if (this.graphTraversalProvider) {
      return this.graphTraversalProvider.traverse(this.repositoryId, spec);
    }

    // 3. Fallback: execute over StorageProvider
    return executeFallbackTraversal(this.repositoryId, this.storage, spec);
  }

  /**
   * Execute a native graph query.
   * Pass-through to GraphTraversalProvider.executeNativeQuery().
   * Throws GraphTraversalProviderRequiredError if no provider registered.
   */
  async executeNativeQuery(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]> {
    if (!this.graphTraversalProvider) {
      throw new GraphTraversalProviderRequiredError();
    }
    return this.graphTraversalProvider.executeNativeQuery(this.repositoryId, query, params);
  }
}
