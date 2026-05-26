// InMemoryStorageProvider — reference implementation of StorageProvider using Maps

import type { StorageProvider, EntityReadOptions } from '../providers/StorageProvider.js';
import type {
  StoredEntity,
  StoredEntityUpdate,
} from '../types/entities.js';
import type {
  StoredRelationship,
  RelationshipQueryOptions,
} from '../types/relationships.js';
import type { MemoryVocabulary, VocabularyChangeRecord } from '../types/vocabulary.js';
import type {
  StorageRepositoryConfig,
  StoredRepository,
  StoredRepositorySummary,
  RepositoryFilter,
  RepositoryStats,
  RepositoryUpdate,
} from '../types/repositories.js';
import type {
  StorageFindQuery,
  StorageExploreOptions,
  StoragePathOptions,
  StorageTimelineOptions,
  PaginationOptions,
  ProvenanceFilter,
} from '../types/queries.js';
import type { Provenance } from '../types/provenance.js';
import type {
  PaginatedResult,
  StorageNeighborhood,
  StoragePathResult,
  StorageTimelineResult,
  BulkImportResult,
} from '../types/results.js';
import type { ExportChunk, ImportChunk } from '../types/portability.js';
import { matchesPropertyFilters } from '../relationships/PropertyFilterMatcher.js';
import { createEmptyVocabulary } from '../vocabulary/VocabularySchema.js';
import {
  RepositoryNotFoundError,
  DuplicateRepositoryError,
  EntityNotFoundError,
  DuplicateEntityError,
  RelationshipNotFoundError,
  DuplicateRelationshipError,
} from '../core/errors.js';

/** Per-repository data store */
interface RepositoryStore {
  repository: StoredRepository;
  vocabulary: MemoryVocabulary;
  vocabularyChangeLog: VocabularyChangeRecord[];
  entities: Map<string, StoredEntity>;
  /** Secondary index: slug → GUID for fast slug lookups */
  slugIndex: Map<string, string>;
  relationships: Map<string, StoredRelationship>;
}

export class InMemoryStorageProvider implements StorageProvider {
  private stores = new Map<string, RepositoryStore>();

  private getStore(repositoryId: string): RepositoryStore {
    const store = this.stores.get(repositoryId);
    if (!store) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    return store;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    // No-op for in-memory
  }

  async dispose(): Promise<void> {
    this.stores.clear();
  }

  // ─── Repository ────────────────────────────────────────────────────

  async createRepository(config: StorageRepositoryConfig): Promise<StoredRepository> {
    if (this.stores.has(config.repositoryId)) {
      throw new DuplicateRepositoryError(config.repositoryId);
    }

    const repository: StoredRepository = {
      repositoryId: config.repositoryId,
      type: config.type,
      label: config.label,
      description: config.description,
      legal: config.legal,
      owner: config.owner,
      governanceConfig: config.governanceConfig,
      metadata: config.metadata,
      createdAt: config.createdAt,
      createdBy: config.createdBy,
    };

    this.stores.set(config.repositoryId, {
      repository,
      vocabulary: createEmptyVocabulary(config.createdBy),
      vocabularyChangeLog: [],
      entities: new Map(),
      slugIndex: new Map(),
      relationships: new Map(),
    });

    return repository;
  }

  async getRepository(repositoryId: string): Promise<StoredRepository | null> {
    return this.stores.get(repositoryId)?.repository ?? null;
  }

  async listRepositories(
    filter?: RepositoryFilter,
  ): Promise<PaginatedResult<StoredRepositorySummary>> {
    let items = Array.from(this.stores.values()).map((store) => ({
      repositoryId: store.repository.repositoryId,
      type: store.repository.type,
      label: store.repository.label,
      description: store.repository.description,
      governanceConfig: store.repository.governanceConfig,
    }));

    if (filter?.type) {
      items = items.filter((r) => r.type === filter.type);
    }

    const total = items.length;
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? 20;
    const paged = items.slice(offset, offset + limit);

    return {
      items: paged,
      total,
      hasMore: offset + paged.length < total,
      limit,
      offset,
    };
  }

  async updateRepository(repositoryId: string, updates: RepositoryUpdate): Promise<StoredRepository> {
    const store = this.stores.get(repositoryId);
    if (!store) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    const repo = store.repository;
    if (updates.label !== undefined) repo.label = updates.label;
    if (updates.description !== undefined) repo.description = updates.description;
    if (updates.type !== undefined) repo.type = updates.type;
    if (updates.legal !== undefined) repo.legal = updates.legal;
    if (updates.owner !== undefined) repo.owner = updates.owner;
    if (updates.governanceConfig !== undefined) repo.governanceConfig = updates.governanceConfig;
    if (updates.metadata !== undefined) repo.metadata = { ...repo.metadata, ...updates.metadata };
    return repo;
  }

  async deleteRepository(repositoryId: string, _onProgress?: import('../types/portability.js').DeleteProgressCallback): Promise<void> {
    if (!this.stores.has(repositoryId)) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    this.stores.delete(repositoryId);
  }

  async deleteAllContents(repositoryId: string, _onProgress?: import('../types/portability.js').DeleteProgressCallback): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const store = this.getStore(repositoryId);
    const deletedEntities = store.entities.size;
    const deletedRelationships = store.relationships.size;
    store.entities.clear();
    store.slugIndex.clear();
    store.relationships.clear();
    return { deletedEntities, deletedRelationships };
  }

  async getRepositoryStats(repositoryId: string): Promise<RepositoryStats> {
    const store = this.getStore(repositoryId);

    const entityTypeBreakdown: Record<string, number> = {};
    for (const entity of store.entities.values()) {
      entityTypeBreakdown[entity.entityType] = (entityTypeBreakdown[entity.entityType] ?? 0) + 1;
    }

    const relationshipTypeBreakdown: Record<string, number> = {};
    for (const rel of store.relationships.values()) {
      relationshipTypeBreakdown[rel.relationshipType] =
        (relationshipTypeBreakdown[rel.relationshipType] ?? 0) + 1;
    }

    return {
      entityCount: store.entities.size,
      relationshipCount: store.relationships.size,
      vocabularyVersion: store.vocabulary.version,
      entityTypeBreakdown,
      relationshipTypeBreakdown,
    };
  }

  // ─── Vocabulary ────────────────────────────────────────────────────

  async getVocabulary(repositoryId: string): Promise<MemoryVocabulary> {
    const store = this.getStore(repositoryId);
    return store.vocabulary;
  }

  async saveVocabulary(repositoryId: string, vocabulary: MemoryVocabulary): Promise<void> {
    const store = this.getStore(repositoryId);
    store.vocabulary = vocabulary;
  }

  async getVocabularyChangeLog(
    repositoryId: string,
    options?: PaginationOptions,
  ): Promise<PaginatedResult<VocabularyChangeRecord>> {
    const store = this.getStore(repositoryId);
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;
    const items = store.vocabularyChangeLog.slice(offset, offset + limit);

    return {
      items,
      total: store.vocabularyChangeLog.length,
      hasMore: offset + limit < store.vocabularyChangeLog.length,
      limit,
      offset,
    };
  }

  // ─── Entities ──────────────────────────────────────────────────────

  async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    const store = this.getStore(repositoryId);
    if (store.entities.has(entity.id)) {
      throw new DuplicateEntityError(entity.id);
    }
    store.entities.set(entity.id, entity);
    store.slugIndex.set(entity.slug, entity.id);
    return entity;
  }

  // The in-memory provider always carries the full entity (embedding and all).
  // The `loadEmbeddings` option is accepted for interface symmetry but ignored —
  // there is no light/full split to switch between when entities live in a Map.
  async getEntity(repositoryId: string, entityId: string, _options?: EntityReadOptions): Promise<StoredEntity | null> {
    const store = this.getStore(repositoryId);
    return store.entities.get(entityId) ?? null;
  }

  async getEntityBySlug(repositoryId: string, slug: string, _options?: EntityReadOptions): Promise<StoredEntity | null> {
    const store = this.getStore(repositoryId);
    const id = store.slugIndex.get(slug);
    if (!id) return null;
    return store.entities.get(id) ?? null;
  }

  async getEntities(
    repositoryId: string,
    entityIds: string[],
    _options?: EntityReadOptions,
  ): Promise<Map<string, StoredEntity>> {
    const store = this.getStore(repositoryId);
    const result = new Map<string, StoredEntity>();
    for (const id of entityIds) {
      const entity = store.entities.get(id);
      if (entity) {
        result.set(id, entity);
      }
    }
    return result;
  }

  async updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity> {
    const store = this.getStore(repositoryId);
    const existing = store.entities.get(entityId);
    if (!existing) {
      throw new EntityNotFoundError(entityId);
    }

    // For optional string fields, null clears, undefined preserves, string sets.
    const updated: StoredEntity = {
      ...existing,
      entityType: updates.entityType ?? existing.entityType,
      label: updates.label ?? existing.label,
      summary: updates.summary === undefined ? existing.summary : (updates.summary ?? undefined),
      properties: updates.properties ?? existing.properties,
      data: updates.data === undefined ? existing.data : (updates.data ?? undefined),
      dataFormat: updates.dataFormat === undefined ? existing.dataFormat : (updates.dataFormat ?? undefined),
      provenance: updates.provenance,
      embedding: updates.embedding ?? existing.embedding,
    };

    // If slug needs to change (type or label changed), update slug index
    if (updates.slug && updates.slug !== existing.slug) {
      store.slugIndex.delete(existing.slug);
      updated.slug = updates.slug;
      store.slugIndex.set(updates.slug, entityId);
    }

    store.entities.set(entityId, updated);
    return updated;
  }

  async deleteEntity(repositoryId: string, entityId: string): Promise<void> {
    const store = this.getStore(repositoryId);
    const existing = store.entities.get(entityId);
    if (!existing) {
      throw new EntityNotFoundError(entityId);
    }
    store.slugIndex.delete(existing.slug);
    store.entities.delete(entityId);

    // Also remove relationships involving this entity
    for (const [relId, rel] of store.relationships) {
      if (rel.sourceEntityId === entityId || rel.targetEntityId === entityId) {
        store.relationships.delete(relId);
      }
    }
  }

  async deleteEntitiesByType(
    repositoryId: string,
    entityType: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    const store = this.getStore(repositoryId);

    // Collect entity IDs of the given type
    const entityIds = new Set<string>();
    for (const [id, entity] of store.entities) {
      if (entity.entityType === entityType) {
        entityIds.add(id);
        store.slugIndex.delete(entity.slug);
      }
    }

    // Delete relationships involving those entities
    let deletedRelationships = 0;
    for (const [relId, rel] of store.relationships) {
      if (entityIds.has(rel.sourceEntityId) || entityIds.has(rel.targetEntityId)) {
        store.relationships.delete(relId);
        deletedRelationships++;
      }
    }

    // Delete the entities
    for (const id of entityIds) {
      store.entities.delete(id);
    }

    return { deletedEntities: entityIds.size, deletedRelationships };
  }

  async findEntities(
    repositoryId: string,
    query: StorageFindQuery,
    _options?: EntityReadOptions,
  ): Promise<PaginatedResult<StoredEntity>> {
    const store = this.getStore(repositoryId);
    let matches = Array.from(store.entities.values());

    // Filter by entity types
    if (query.entityTypes && query.entityTypes.length > 0) {
      matches = matches.filter((e) => query.entityTypes!.includes(e.entityType));
    }

    // Filter by search term (label substring, case-insensitive)
    if (query.searchTerm) {
      const term = query.searchTerm.toLowerCase();
      matches = matches.filter(
        (e) =>
          e.label.toLowerCase().includes(term) ||
          (e.summary && e.summary.toLowerCase().includes(term)),
      );
    }

    // Filter by property values
    if (query.properties) {
      const entries = Object.entries(query.properties);
      matches = matches.filter((e) =>
        entries.every(([key, value]) => e.properties[key] === value),
      );
    }

    // Filter by provenance
    if (query.provenance) {
      matches = matches.filter((e) => matchesProvenance(e.provenance, query.provenance!));
    }

    const total = matches.length;
    const items = matches.slice(query.offset, query.offset + query.limit);

    return {
      items,
      total,
      hasMore: query.offset + query.limit < total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  // ─── Relationships ─────────────────────────────────────────────────

  async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
  ): Promise<StoredRelationship> {
    const store = this.getStore(repositoryId);
    if (store.relationships.has(relationship.id)) {
      throw new DuplicateRelationshipError(relationship.id);
    }
    store.relationships.set(relationship.id, relationship);
    return relationship;
  }

  async getRelationship(
    repositoryId: string,
    relationshipId: string,
  ): Promise<StoredRelationship | null> {
    const store = this.getStore(repositoryId);
    return store.relationships.get(relationshipId) ?? null;
  }

  async getEntityRelationships(
    repositoryId: string,
    entityId: string,
    options?: RelationshipQueryOptions,
  ): Promise<PaginatedResult<StoredRelationship>> {
    const store = this.getStore(repositoryId);
    const direction = options?.direction ?? 'both';
    let matches = Array.from(store.relationships.values());

    // Filter by entity involvement and direction
    matches = matches.filter((rel) => {
      const isSource = rel.sourceEntityId === entityId;
      const isTarget = rel.targetEntityId === entityId;
      const isBidirectionalTarget = rel.bidirectional && isTarget;

      switch (direction) {
        case 'outbound':
          return isSource || isBidirectionalTarget;
        case 'inbound':
          return isTarget || (rel.bidirectional && isSource);
        case 'both':
        default:
          return isSource || isTarget;
      }
    });

    // Filter by relationship types
    if (options?.relationshipTypes && options.relationshipTypes.length > 0) {
      matches = matches.filter((r) => options.relationshipTypes!.includes(r.relationshipType));
    }

    // Filter by property values
    if (options?.propertyFilters && options.propertyFilters.length > 0) {
      matches = matches.filter((r) => matchesPropertyFilters(r.properties, options.propertyFilters!));
    }

    const total = matches.length;
    const limit = options?.limit ?? 10;
    const offset = options?.offset ?? 0;
    const items = matches.slice(offset, offset + limit);

    return {
      items,
      total,
      hasMore: offset + limit < total,
      limit,
      offset,
    };
  }

  async deleteEntities(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    const store = this.getStore(repositoryId);
    const deleted: string[] = [];
    const notFound: string[] = [];
    const deletedSet = new Set<string>();

    for (const id of ids) {
      const existing = store.entities.get(id);
      if (!existing) {
        notFound.push(id);
        continue;
      }
      store.slugIndex.delete(existing.slug);
      store.entities.delete(id);
      deleted.push(id);
      deletedSet.add(id);
    }

    // Cascade-delete relationships involving any of the deleted entities
    for (const [relId, rel] of store.relationships) {
      if (deletedSet.has(rel.sourceEntityId) || deletedSet.has(rel.targetEntityId)) {
        store.relationships.delete(relId);
      }
    }

    return { deleted, notFound };
  }

  async deleteRelationship(repositoryId: string, relationshipId: string): Promise<void> {
    const store = this.getStore(repositoryId);
    if (!store.relationships.has(relationshipId)) {
      throw new RelationshipNotFoundError(relationshipId);
    }
    store.relationships.delete(relationshipId);
  }

  async deleteRelationships(
    repositoryId: string,
    ids: string[],
  ): Promise<{ deleted: string[]; notFound: string[] }> {
    const store = this.getStore(repositoryId);
    const deleted: string[] = [];
    const notFound: string[] = [];
    for (const id of ids) {
      if (store.relationships.has(id)) {
        store.relationships.delete(id);
        deleted.push(id);
      } else {
        notFound.push(id);
      }
    }
    return { deleted, notFound };
  }

  async deleteRelationshipsByType(
    repositoryId: string,
    relationshipType: string,
  ): Promise<{ deletedRelationships: number }> {
    const store = this.getStore(repositoryId);
    let deletedRelationships = 0;
    for (const [relId, rel] of store.relationships) {
      if (rel.relationshipType === relationshipType) {
        store.relationships.delete(relId);
        deletedRelationships++;
      }
    }
    return { deletedRelationships };
  }

  // ─── Graph Traversal ───────────────────────────────────────────────

  async exploreNeighborhood(
    repositoryId: string,
    entityId: string,
    options: StorageExploreOptions,
  ): Promise<StorageNeighborhood> {
    const store = this.getStore(repositoryId);

    if (!store.entities.has(entityId)) {
      throw new EntityNotFoundError(entityId);
    }

    const layers: StorageNeighborhood['layers'] = [];
    const visited = new Set<string>([entityId]);
    let currentFrontier = new Set<string>([entityId]);

    for (let depth = 0; depth < options.depth; depth++) {
      const layer: Record<string, { total: number; entities: StoredEntity[]; relationships: StoredRelationship[] }> = {};
      const nextFrontier = new Set<string>();

      for (const frontierEntityId of currentFrontier) {
        for (const rel of store.relationships.values()) {
          // Check direction filter
          const isSource = rel.sourceEntityId === frontierEntityId;
          const isTarget = rel.targetEntityId === frontierEntityId;

          let matchesDirection = false;
          let connectedEntityId: string | undefined;

          if (isSource && (options.direction === 'outbound' || options.direction === 'both')) {
            matchesDirection = true;
            connectedEntityId = rel.targetEntityId;
          } else if (isTarget && (options.direction === 'inbound' || options.direction === 'both')) {
            matchesDirection = true;
            connectedEntityId = rel.sourceEntityId;
          } else if (rel.bidirectional) {
            if (isSource && options.direction === 'inbound') {
              matchesDirection = true;
              connectedEntityId = rel.targetEntityId;
            } else if (isTarget && options.direction === 'outbound') {
              matchesDirection = true;
              connectedEntityId = rel.sourceEntityId;
            }
          }

          if (!matchesDirection || !connectedEntityId) continue;
          if (visited.has(connectedEntityId)) continue;

          // Filter by relationship type
          if (options.relationshipTypes && !options.relationshipTypes.includes(rel.relationshipType)) {
            continue;
          }

          // Filter by relationship property values
          if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
            if (!matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters)) {
              continue;
            }
          }

          const connectedEntity = store.entities.get(connectedEntityId);
          if (!connectedEntity) continue;

          // Filter by entity type
          if (options.entityTypes && !options.entityTypes.includes(connectedEntity.entityType)) {
            continue;
          }

          const relType = rel.relationshipType;
          if (!layer[relType]) {
            layer[relType] = { total: 0, entities: [], relationships: [] };
          }

          layer[relType].total++;

          // Apply per-type pagination
          const group = layer[relType];
          if (group.entities.length < options.limitPerType) {
            group.entities.push(connectedEntity);
            group.relationships.push(rel);
          }

          nextFrontier.add(connectedEntityId);
        }
      }

      for (const id of nextFrontier) {
        visited.add(id);
      }

      layers.push(layer);
      currentFrontier = nextFrontier;

      if (nextFrontier.size === 0) break;
    }

    return {
      centerId: entityId,
      layers,
    };
  }

  async findPaths(
    repositoryId: string,
    sourceId: string,
    targetId: string,
    options: StoragePathOptions,
  ): Promise<StoragePathResult> {
    const store = this.getStore(repositoryId);

    if (!store.entities.has(sourceId)) {
      throw new EntityNotFoundError(sourceId);
    }
    if (!store.entities.has(targetId)) {
      throw new EntityNotFoundError(targetId);
    }

    if (sourceId === targetId) {
      return { paths: [{ entityIds: [sourceId], relationshipIds: [] }], totalPaths: 1 };
    }

    // BFS path finding
    const paths: Array<{ entityIds: string[]; relationshipIds: string[] }> = [];
    const queue: Array<{ entityId: string; path: string[]; relPath: string[] }> = [
      { entityId: sourceId, path: [sourceId], relPath: [] },
    ];

    // Track visited per path-length to allow multiple paths
    const visitedAtDepth = new Map<string, number>();
    visitedAtDepth.set(sourceId, 0);

    while (queue.length > 0 && paths.length < options.limit + options.offset) {
      const current = queue.shift()!;

      if (current.path.length > options.maxDepth + 1) continue;

      for (const rel of store.relationships.values()) {
        // Filter by relationship type
        if (options.relationshipTypes && !options.relationshipTypes.includes(rel.relationshipType)) {
          continue;
        }

        // Filter by relationship property values
        if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
          if (!matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters)) {
            continue;
          }
        }

        // Traverse edges in both directions for path discovery,
        // regardless of bidirectional flag. The flag controls semantic
        // meaning, not graph reachability — paths should follow all edges.
        let nextEntityId: string | undefined;
        if (rel.sourceEntityId === current.entityId) {
          nextEntityId = rel.targetEntityId;
        } else if (rel.targetEntityId === current.entityId) {
          nextEntityId = rel.sourceEntityId;
        }

        if (!nextEntityId) continue;
        if (current.path.includes(nextEntityId) && nextEntityId !== targetId) continue;

        // Filter intermediate entities by type (always allow source and target)
        if (options.entityTypes && nextEntityId !== targetId) {
          const nextEntity = store.entities.get(nextEntityId);
          if (nextEntity && !options.entityTypes.includes(nextEntity.entityType)) continue;
        }

        const newPath = [...current.path, nextEntityId];
        const newRelPath = [...current.relPath, rel.id];

        if (nextEntityId === targetId) {
          paths.push({ entityIds: newPath, relationshipIds: newRelPath });
        } else if (newPath.length <= options.maxDepth) {
          const prevDepth = visitedAtDepth.get(nextEntityId);
          if (prevDepth === undefined || prevDepth >= newPath.length - 1) {
            visitedAtDepth.set(nextEntityId, newPath.length - 1);
            queue.push({ entityId: nextEntityId, path: newPath, relPath: newRelPath });
          }
        }
      }
    }

    const paginatedPaths = paths.slice(options.offset, options.offset + options.limit);

    return {
      paths: paginatedPaths,
      totalPaths: paths.length,
    };
  }

  // ─── Timeline ──────────────────────────────────────────────────────

  async getTimeline(
    repositoryId: string,
    entityId: string,
    options: StorageTimelineOptions,
  ): Promise<StorageTimelineResult> {
    const store = this.getStore(repositoryId);
    const entity = store.entities.get(entityId);
    if (!entity) {
      throw new EntityNotFoundError(entityId);
    }

    const events: StorageTimelineResult['events'] = [];

    // Entity creation event
    events.push({
      timestamp: entity.provenance.createdAt,
      eventType: 'entity:created',
      entityId,
    });

    // Entity modification event (if different from creation)
    if (entity.provenance.modifiedAt !== entity.provenance.createdAt) {
      events.push({
        timestamp: entity.provenance.modifiedAt,
        eventType: 'entity:updated',
        entityId,
      });
    }

    // Relationship events involving this entity
    for (const rel of store.relationships.values()) {
      if (rel.sourceEntityId === entityId || rel.targetEntityId === entityId) {
        events.push({
          timestamp: rel.provenance.createdAt,
          eventType: 'relationship:created',
          entityId,
          relationshipId: rel.id,
        });
      }
    }

    // Filter by time range
    let filtered = events;
    if (options.timeRange) {
      const from = new Date(options.timeRange.from).getTime();
      const to = new Date(options.timeRange.to).getTime();
      filtered = filtered.filter((e) => {
        const t = new Date(e.timestamp).getTime();
        return t >= from && t <= to;
      });
    }

    // Filter by event types
    if (options.eventTypes && options.eventTypes.length > 0) {
      filtered = filtered.filter((e) => options.eventTypes!.includes(e.eventType));
    }

    // Filter by provenance (conversation ID)
    if (options.provenance) {
      const prov = options.provenance;
      filtered = filtered.filter((e) => {
        // For entity events, check entity provenance
        if (e.eventType.startsWith('entity:')) {
          const ent = store.entities.get(e.entityId);
          return ent ? matchesProvenance(ent.provenance, prov) : false;
        }
        // For relationship events, check relationship provenance
        if (e.relationshipId) {
          const rel = store.relationships.get(e.relationshipId);
          return rel ? matchesProvenance(rel.provenance, prov) : false;
        }
        return true;
      });
    }

    // Sort by timestamp descending (most recent first)
    filtered.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    const total = filtered.length;
    const items = filtered.slice(options.offset, options.offset + options.limit);

    return {
      events: items,
      total,
    };
  }

  // ─── Bulk Operations ───────────────────────────────────────────────

  async *exportAll(repositoryId: string): AsyncIterable<ExportChunk> {
    const store = this.getStore(repositoryId);

    const entities = Array.from(store.entities.values());
    const batchSize = 100;

    for (let i = 0; i < entities.length; i += batchSize) {
      const batch = entities.slice(i, i + batchSize);
      yield {
        type: 'entities',
        data: batch,
        sequence: Math.floor(i / batchSize),
        isLast: i + batchSize >= entities.length,
      };
    }

    // If no entities, still yield an empty last chunk
    if (entities.length === 0) {
      yield { type: 'entities', data: [], sequence: 0, isLast: true };
    }

    const relationships = Array.from(store.relationships.values());
    for (let i = 0; i < relationships.length; i += batchSize) {
      const batch = relationships.slice(i, i + batchSize);
      yield {
        type: 'relationships',
        data: batch,
        sequence: Math.floor(i / batchSize),
        isLast: i + batchSize >= relationships.length,
      };
    }

    if (relationships.length === 0) {
      yield { type: 'relationships', data: [], sequence: 0, isLast: true };
    }
  }

  async importBulk(
    repositoryId: string,
    data: ImportChunk[],
    _options?: import('../types/portability.js').BulkImportOptions,
  ): Promise<BulkImportResult> {
    const store = this.getStore(repositoryId);
    let entitiesImported = 0;
    let relationshipsImported = 0;
    const errors: Array<{ item: string; error: string }> = [];

    for (const chunk of data) {
      if (chunk.entities) {
        for (const entity of chunk.entities) {
          try {
            store.entities.set(entity.id, entity);
            store.slugIndex.set(entity.slug, entity.id);
            entitiesImported++;
          } catch (err) {
            errors.push({
              item: entity.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      if (chunk.relationships) {
        for (const rel of chunk.relationships) {
          try {
            store.relationships.set(rel.id, rel);
            relationshipsImported++;
          } catch (err) {
            errors.push({
              item: rel.id,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    return { entitiesImported, relationshipsImported, errors };
  }
}

// ─── Provenance filter helper ──────────────────────────────────────

function matchesProvenance(prov: Provenance, filter: ProvenanceFilter): boolean {
  if (filter.conversationIds && filter.conversationIds.length > 0) {
    const matchesCreated = prov.createdInConversation && filter.conversationIds.includes(prov.createdInConversation);
    const matchesModified = prov.modifiedInConversation && filter.conversationIds.includes(prov.modifiedInConversation);
    if (!matchesCreated && !matchesModified) return false;
  }
  if (filter.actors && filter.actors.length > 0) {
    const matchesCreator = filter.actors.includes(prov.createdBy);
    const matchesModifier = filter.actors.includes(prov.modifiedBy);
    if (!matchesCreator && !matchesModifier) return false;
  }
  if (filter.dateRange) {
    const from = new Date(filter.dateRange.from).getTime();
    const to = new Date(filter.dateRange.to).getTime();
    const created = new Date(prov.createdAt).getTime();
    const modified = new Date(prov.modifiedAt).getTime();
    if (!(created >= from && created <= to) && !(modified >= from && modified <= to)) return false;
  }
  return true;
}
