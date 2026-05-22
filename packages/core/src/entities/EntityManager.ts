// EntityManager — CRUD orchestration for entities with validation, provenance, and events

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';
import type {
  CreateEntityInput,
  DetailLevel,
  Entity,
  EntityBrief,
  EntitySummary,
  StoredEntity,
  UpdateEntityInput,
} from '../types/entities.js';
import type { PaginatedResult, ReembedResult } from '../types/results.js';
import type { FindEntitiesQuery, StorageFindQuery } from '../types/queries.js';
import type { DeleteEntitiesResult } from '../types/entities.js';
import type { VocabularyEngine } from '../core/VocabularyEngine.js';
import type { ProvenanceTracker } from '../core/ProvenanceTracker.js';
import type { EventBus } from '../core/EventBus.js';
import { generateEntityId, generateUniqueSlug } from './IdGenerator.js';
import {
  EntityNotFoundError,
  VocabularyValidationError,
  OperationCancelledError,
  OperationAbortedError,
  EmbeddingProviderRequiredError,
} from '../core/errors.js';
import { getEntityTypeDef } from '../vocabulary/VocabularyValidator.js';

export class EntityManager {
  private embedding?: EmbeddingProvider;

  constructor(
    private readonly repositoryId: string,
    private readonly vocabularyEngine: VocabularyEngine,
    private readonly provenanceTracker: ProvenanceTracker,
    private readonly eventBus: EventBus,
    private readonly storage: StorageProvider,
    embedding?: EmbeddingProvider,
  ) {
    this.embedding = embedding;
  }

  /** Swap the embedding provider, e.g. after a repository re-embed changes the model or dimensionality */
  setEmbeddingProvider(embedding: EmbeddingProvider | undefined): void {
    this.embedding = embedding;
  }

  /** Create one or more entities with vocabulary validation, ID generation, provenance, and events */
  async create(inputs: CreateEntityInput[]): Promise<Entity[]> {
    const results: Entity[] = [];

    for (const input of inputs) {
      // Validate against vocabulary
      const validation = await this.vocabularyEngine.validateEntity(input);
      if (!validation.valid) {
        const errorMsg = validation.errors.map((e) => e.message).join('; ');
        const suggestions = validation.errors
          .filter((e) => e.suggestion)
          .map((e) => e.suggestion!);

        await this.eventBus.emit('validation:failed', {
          operation: 'createEntity',
          error: errorMsg,
          suggestions,
        });

        throw new VocabularyValidationError(validation.errors);
      }

      // Pre-mutation hook
      const hookResult = await this.eventBus.emitHook('entity:creating', { input });
      if (hookResult.cancelled) {
        throw new OperationCancelledError('Entity creation', hookResult.reason ?? 'cancelled by hook');
      }

      // Generate GUID (or use provided)
      const id = input.id ?? generateEntityId();

      // Generate unique slug
      const slug = await generateUniqueSlug(
        input.entityType,
        input.label,
        async (candidateSlug) => {
          const existing = await this.storage.getEntityBySlug(this.repositoryId, candidateSlug);
          return existing !== null;
        },
      );

      // Stamp provenance
      const provenance = this.provenanceTracker.stampCreate();

      // Generate embedding if provider available
      const entityEmbedding = await this.generateEmbedding(input.label, input.summary, input.properties ?? {}, input.entityType);

      // Build stored entity
      const storedEntity: StoredEntity = {
        id,
        slug,
        entityType: input.entityType,
        label: input.label,
        summary: input.summary,
        properties: input.properties ?? {},
        data: input.data,
        dataFormat: input.dataFormat,
        provenance,
        embedding: entityEmbedding,
      };

      // Persist
      const created = await this.storage.createEntity(this.repositoryId, storedEntity);

      // Map to public type
      const entity = storedToEntity(created);

      // Emit created event
      await this.eventBus.emit('entity:created', { entity });

      results.push(entity);
    }

    return results;
  }

  /** Update an existing entity */
  async update(entityId: string, updates: UpdateEntityInput): Promise<Entity> {
    // Get existing entity to determine its type for validation
    const existing = await this.storage.getEntity(this.repositoryId, entityId);
    if (!existing) {
      throw new EntityNotFoundError(entityId);
    }

    // Validate updates against vocabulary
    const validation = await this.vocabularyEngine.validateEntityUpdate(
      updates,
      existing.entityType,
    );
    if (!validation.valid) {
      await this.eventBus.emit('validation:failed', {
        operation: 'updateEntity',
        error: validation.errors.map((e) => e.message).join('; '),
        suggestions: validation.errors.filter((e) => e.suggestion).map((e) => e.suggestion!),
      });
      throw new VocabularyValidationError(validation.errors);
    }

    // Pre-mutation hook
    const hookResult = await this.eventBus.emitHook('entity:updating', {
      id: entityId,
      updates,
    });
    if (hookResult.cancelled) {
      throw new OperationCancelledError('Entity update', hookResult.reason ?? 'cancelled by hook');
    }

    // Stamp provenance
    const provenance = this.provenanceTracker.stampUpdate(existing.provenance);

    // Merge properties. RFC 7396 semantics: incoming `null` values delete the
    // corresponding key rather than storing `null`.
    let mergedProperties = existing.properties;
    if (updates.properties) {
      const merged: Record<string, unknown> = { ...existing.properties };
      for (const [key, value] of Object.entries(updates.properties)) {
        if (value === null) {
          delete merged[key];
        } else {
          merged[key] = value;
        }
      }
      mergedProperties = merged;
    }

    // Regenerate slug when entityType or label changes — both are part of the slug.
    const typeChanged = updates.entityType !== undefined && updates.entityType !== existing.entityType;
    const labelChanged = updates.label !== undefined && updates.label !== existing.label;
    let newSlug: string | undefined;
    if (typeChanged || labelChanged) {
      const nextType = updates.entityType ?? existing.entityType;
      const nextLabel = updates.label ?? existing.label;
      newSlug = await generateUniqueSlug(
        nextType,
        nextLabel,
        async (candidateSlug) => {
          if (candidateSlug === existing.slug) return false; // the entity's own slug isn't a conflict
          const other = await this.storage.getEntityBySlug(this.repositoryId, candidateSlug);
          return other !== null;
        },
      );
    }

    // Regenerate embedding if label/summary changed or reembed explicitly requested.
    // `summary === null` means "clear", so the embedding is computed from label alone.
    // Reembed when label, summary, or any property changes (properties may include embeddable ones).
    const needsReembed = updates.reembed === true || updates.label !== undefined || updates.summary !== undefined || updates.properties !== undefined;
    const nextSummary = updates.summary === undefined ? existing.summary : (updates.summary ?? undefined);
    const nextEntityType = updates.entityType ?? existing.entityType;
    const entityEmbedding = needsReembed
      ? await this.generateEmbedding(updates.label ?? existing.label, nextSummary, mergedProperties, nextEntityType)
      : undefined; // undefined preserves the existing embedding in storage

    // Persist
    const updated = await this.storage.updateEntity(this.repositoryId, entityId, {
      entityType: typeChanged ? updates.entityType : undefined,
      label: updates.label,
      slug: newSlug,
      summary: updates.summary,
      properties: updates.properties ? mergedProperties : undefined,
      data: updates.data,
      dataFormat: updates.dataFormat,
      provenance,
      embedding: entityEmbedding,
    });

    const entity = storedToEntity(updated);
    await this.eventBus.emit('entity:updated', { entity });

    return entity;
  }

  /** Get a single entity with configurable detail level */
  async get(entityId: string, detailLevel: DetailLevel = 'full'): Promise<Entity | EntitySummary | EntityBrief | null> {
    const stored = await this.storage.getEntity(this.repositoryId, entityId);
    if (!stored) return null;

    switch (detailLevel) {
      case 'brief':
        return storedToBrief(stored);
      case 'summary':
        return storedToSummary(stored);
      case 'full':
      default:
        return storedToEntity(stored);
    }
  }

  /** Get an entity by its slug */
  async getBySlug(slug: string, detailLevel: DetailLevel = 'full'): Promise<Entity | EntitySummary | EntityBrief | null> {
    const stored = await this.storage.getEntityBySlug(this.repositoryId, slug);
    if (!stored) return null;

    switch (detailLevel) {
      case 'brief':
        return storedToBrief(stored);
      case 'summary':
        return storedToSummary(stored);
      case 'full':
      default:
        return storedToEntity(stored);
    }
  }

  /** Get multiple entities in a single call (max 50, brief or summary only) */
  async getMany(
    entityIds: string[],
    detailLevel: 'brief' | 'summary' = 'summary',
  ): Promise<Map<string, EntitySummary | EntityBrief>> {
    const ids = entityIds.slice(0, 50);
    const storedMap = await this.storage.getEntities(this.repositoryId, ids);
    const result = new Map<string, EntitySummary | EntityBrief>();

    for (const [id, stored] of storedMap) {
      result.set(
        id,
        detailLevel === 'brief' ? storedToBrief(stored) : storedToSummary(stored),
      );
    }

    return result;
  }

  /** Find entities by search criteria */
  async find(query: FindEntitiesQuery): Promise<PaginatedResult<EntitySummary>> {
    const storageQuery: StorageFindQuery = {
      searchTerm: query.searchTerm,
      entityTypes: query.entityTypes,
      properties: query.properties,
      limit: Math.min(query.limit ?? 10, 50),
      offset: query.offset ?? 0,
    };

    const result = await this.storage.findEntities(this.repositoryId, storageQuery);

    return {
      items: result.items.map(storedToSummary),
      total: result.total,
      hasMore: result.hasMore,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /** Delete an entity — throws EntityNotFoundError if it does not exist */
  async delete(entityId: string): Promise<void> {
    const existing = await this.storage.getEntity(this.repositoryId, entityId);
    if (!existing) {
      throw new EntityNotFoundError(entityId);
    }

    const hookResult = await this.eventBus.emitHook('entity:deleting', { ids: [entityId] });
    if (hookResult.cancelled) {
      throw new OperationCancelledError('Entity deletion', hookResult.reason ?? 'cancelled by hook');
    }

    await this.storage.deleteEntity(this.repositoryId, entityId);
    await this.eventBus.emit('entity:deleted', { ids: [entityId] });
  }

  /** Delete multiple entities in a single batch operation */
  async deleteMany(ids: string[]): Promise<DeleteEntitiesResult> {
    const hookResult = await this.eventBus.emitHook('entity:deleting', { ids });
    if (hookResult.cancelled) {
      throw new OperationCancelledError('Entity deletion', hookResult.reason ?? 'cancelled by hook');
    }

    const { deleted, notFound } = await this.storage.deleteEntities(this.repositoryId, ids);

    if (deleted.length > 0) {
      await this.eventBus.emit('entity:deleted', { ids: deleted });
    }

    return {
      deleted,
      failed: notFound.map((id) => ({ id, error: `Entity '${id}' not found` })),
    };
  }

  /**
   * Re-embed a specific set of entities using the current EmbeddingProvider.
   * Retries embedBatch up to maxRetries times with exponential backoff on failure.
   */
  async reembedEntities(entityIds: string[], options?: {
    maxRetries?: number;
    /** Called with `{ entityId, error }` for every entity that fails during this batch. */
    onItemFailed?: (entityId: string, error: string) => void | Promise<void>;
  }): Promise<ReembedResult> {
    if (!this.embedding) {
      throw new EmbeddingProviderRequiredError();
    }

    const maxRetries = options?.maxRetries ?? 3;

    const storedMap = await this.storage.getEntities(this.repositoryId, entityIds);
    const entries = Array.from(storedMap.entries());

    const vocab = await this.vocabularyEngine.getVocabulary();
    const texts = entries.map(([, e]) => {
      const typeDef = getEntityTypeDef(e.entityType, vocab);
      const embeddableValues = typeDef
        ? typeDef.properties
            .filter((p) => p.embeddable === true && typeof e.properties[p.name] === 'string')
            .map((p) => e.properties[p.name] as string)
        : [];
      return [e.label, e.summary ?? '', ...embeddableValues].filter(Boolean).join(' ');
    });

    // Attempt embedBatch with retry and exponential backoff
    let embeddings: number[][];
    let attempt = 0;
    while (true) {
      try {
        embeddings = await this.embedding.embedBatch(texts);
        break;
      } catch (err) {
        attempt++;
        if (attempt > maxRetries) {
          // All retries exhausted — record every entity in this batch as failed
          const errorMsg = err instanceof Error ? err.message : String(err);
          const failureMessage = `embedBatch failed after ${maxRetries} retries: ${errorMsg}`;
          const failed = entries.map(([id]) => ({ entityId: id, error: failureMessage }));
          for (const { entityId, error } of failed) {
            await options?.onItemFailed?.(entityId, error);
          }
          return {
            processed: 0,
            failed: entries.length,
            errors: failed,
            modelId: this.embedding.modelId(),
            dimensions: this.embedding.dimensions(),
          };
        }
        // Exponential backoff: 1s, 2s, 4s, ...
        const backoffMs = 1000 * (2 ** (attempt - 1));
        await new Promise<void>((resolve) => { setTimeout(resolve, backoffMs); });
      }
    }

    // Persist embeddings — individual storage failures are non-fatal
    const errors: Array<{ entityId: string; error: string }> = [];
    let processed = 0;

    for (let i = 0; i < entries.length; i++) {
      const [id, entity] = entries[i]!;
      try {
        await this.storage.updateEntity(this.repositoryId, id, {
          provenance: entity.provenance, // preserve existing provenance — not a content edit
          embedding: embeddings[i],
        });
        processed++;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        errors.push({ entityId: id, error: errorMessage });
        await options?.onItemFailed?.(id, errorMessage);
      }
    }

    return {
      processed,
      failed: errors.length,
      errors,
      modelId: this.embedding.modelId(),
      dimensions: this.embedding.dimensions(),
    };
  }

  /**
   * Re-embed all entities in the repository, processing in batches.
   * @param options.batchSize — entities per batch (default 50)
   * @param options.maxRetries — retries per batch on embedding failure (default 3)
   * @param options.errorThresholdToAbort — abort after this many cumulative failures (default: no limit)
   * @param options.delayBetweenBatchesMs — milliseconds to wait between batches for rate limiting (default 0)
   * @param options.onProgress — callback invoked after each batch
   */
  async reembedAll(options?: {
    batchSize?: number;
    maxRetries?: number;
    errorThresholdToAbort?: number;
    delayBetweenBatchesMs?: number;
    onProgress?: (processed: number, total: number, failed: number) => void | Promise<void>;
    /**
     * Called for every entity that fails during the run — embedBatch retry
     * exhaustion (every entity in the batch fires) and per-entity storage
     * persist failures.
     */
    onItemFailed?: (entityId: string, error: string) => void | Promise<void>;
    /**
     * Caller-supplied abort signal. Checked at each batch boundary —
     * in-flight batches complete before abort is honoured, and entities
     * already re-embedded in completed batches are left as-is.
     */
    signal?: AbortSignal;
  }): Promise<ReembedResult> {
    if (!this.embedding) {
      throw new EmbeddingProviderRequiredError();
    }

    const batchSize = options?.batchSize ?? 50;
    const errorThreshold = options?.errorThresholdToAbort;
    const signal = options?.signal;

    // Count total entities
    const firstPage = await this.storage.findEntities(this.repositoryId, { limit: 1, offset: 0 });
    const total = firstPage.total;

    let totalProcessed = 0;
    let totalFailed = 0;
    const allErrors: Array<{ entityId: string; error: string }> = [];
    let offset = 0;

    while (offset < total) {
      if (signal?.aborted) {
        throw new OperationAbortedError('reembedAll');
      }

      const page = await this.storage.findEntities(this.repositoryId, {
        limit: batchSize,
        offset,
      });

      if (page.items.length === 0) break;

      const ids = page.items.map((e) => e.id);
      const result = await this.reembedEntities(ids, {
        maxRetries: options?.maxRetries,
        onItemFailed: options?.onItemFailed,
      });

      totalProcessed += result.processed;
      totalFailed += result.failed;
      allErrors.push(...result.errors);

      await options?.onProgress?.(totalProcessed, total, totalFailed);

      // Check abort threshold
      if (errorThreshold !== undefined && totalFailed >= errorThreshold) {
        allErrors.push({ entityId: '', error: `Aborted: error threshold of ${errorThreshold} reached (${totalFailed} failures)` });
        break;
      }

      offset += page.items.length;

      if (signal?.aborted) {
        throw new OperationAbortedError('reembedAll');
      }

      // Rate limiting: pause between batches if configured
      const delayMs = options?.delayBetweenBatchesMs ?? 0;
      if (delayMs > 0 && offset < total) {
        await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
      }
    }

    return {
      processed: totalProcessed,
      failed: totalFailed,
      errors: allErrors,
      modelId: this.embedding.modelId(),
      dimensions: this.embedding.dimensions(),
    };
  }

  /** Generate an embedding vector from label + summary + embeddable string properties if a provider is available */
  private async generateEmbedding(label: string, summary: string | undefined, properties: Record<string, unknown>, entityType: string): Promise<number[] | undefined> {
    if (!this.embedding) return undefined;
    const vocab = await this.vocabularyEngine.getVocabulary();
    const typeDef = getEntityTypeDef(entityType, vocab);
    const embeddableValues = typeDef
      ? typeDef.properties
          .filter((p) => p.embeddable === true && typeof properties[p.name] === 'string')
          .map((p) => properties[p.name] as string)
      : [];
    const text = [label, summary ?? '', ...embeddableValues].filter(Boolean).join(' ');
    return this.embedding.embed(text);
  }
}

// ─── Mapping helpers ────────────────────────────────────────────────

function storedToEntity(stored: StoredEntity): Entity {
  return {
    id: stored.id,
    slug: stored.slug,
    entityType: stored.entityType,
    label: stored.label,
    summary: stored.summary,
    properties: stored.properties,
    data: stored.data,
    dataFormat: stored.dataFormat,
    provenance: stored.provenance,
  };
}

function storedToSummary(stored: StoredEntity): EntitySummary {
  return {
    id: stored.id,
    slug: stored.slug,
    entityType: stored.entityType,
    label: stored.label,
    summary: stored.summary,
    properties: stored.properties,
  };
}

function storedToBrief(stored: StoredEntity): EntityBrief {
  return {
    id: stored.id,
    slug: stored.slug,
    entityType: stored.entityType,
    label: stored.label,
    summary: stored.summary,
  };
}
