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
  BatchPartialFailureError,
  isSlugConflict,
  toError,
} from '../core/errors.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import { getEntityTypeDef } from '../vocabulary/VocabularyValidator.js';
import { assertWritablePropertyKeys } from '../validation/propertyNames.js';

/**
 * How many times a create or update re-picks a slug after the store refuses one as
 * taken. Each conflict means another writer committed the same type and label
 * in the window between the free-slug check and the write; a handful of
 * retries absorbs ordinary contention without looping under a pathological
 * burst.
 */
const MAX_SLUG_CONFLICT_RETRIES = 3;

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

  /**
   * Create one or more entities with vocabulary validation, ID generation,
   * provenance, and events.
   *
   * Every member is validated against a single read of the vocabulary before
   * any member is written, so a vocabulary refusal of any member writes
   * nothing and throws `VocabularyValidationError` for the first refused
   * member. Members are then written in input order, each in its own store
   * transaction. A failure while writing (a hook cancellation, a store error)
   * once at least one member is stored throws `BatchPartialFailureError`,
   * which carries the stored members; a failure that leaves nothing stored
   * throws the original error.
   */
  public async create(inputs: CreateEntityInput[]): Promise<Entity[]> {
    if (inputs.length === 0) return [];
    for (const input of inputs) assertWritablePropertyKeys(input.properties, 'entity');

    const vocabulary = await this.vocabularyEngine.getVocabulary();
    for (const input of inputs) {
      const validation = await this.vocabularyEngine.validateEntity(input, vocabulary);
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
    }

    const results: Entity[] = [];
    for (const [index, input] of inputs.entries()) {
      try {
        const entity = await this.writeOne(input, vocabulary);
        // Recorded before the event so `created` on a later failure includes
        // this member even when an `entity:created` handler is what failed.
        results.push(entity);
        await this.eventBus.emit('entity:created', { entity });
      } catch (err) {
        if (results.length === 0) throw err;
        throw new BatchPartialFailureError(results, index, inputs.length, toError(err));
      }
    }

    return results;
  }

  /** Run the pre-mutation hook for one validated create input and store it */
  private async writeOne(input: CreateEntityInput, vocabulary: MemoryVocabulary): Promise<Entity> {
    // Pre-mutation hook
    const hookResult = await this.eventBus.emitHook('entity:creating', { input });
    if (hookResult.cancelled) {
      throw new OperationCancelledError('Entity creation', hookResult.reason ?? 'cancelled by hook');
    }

    // Generate GUID (or use provided)
    const id = input.id ?? generateEntityId();

    // Generate unique slug
    const pickSlug = this.createSlugPicker(input.entityType, input.label);
    const slug = await pickSlug();

    // Stamp provenance
    const provenance = this.provenanceTracker.stampCreate();

    // Generate embedding if provider available
    const entityEmbedding = await this.generateEmbedding(
      input.label,
      input.summary,
      input.properties ?? {},
      input.entityType,
      vocabulary,
    );

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

    // Persist, re-picking the slug if a concurrent writer claimed it first.
    const created = await this.writeWithSlugRetry(
      slug,
      (candidateSlug) =>
        this.storage.createEntity(this.repositoryId, { ...storedEntity, slug: candidateSlug }),
      pickSlug,
    );

    return storedToEntity(created);
  }

  /**
   * A free-slug picker for one write. Called with no argument it returns the
   * first free candidate; called with a slug the store refused, it records
   * that slug as taken and returns the next free one. A refused slug counts
   * as taken even before the competing write is visible to a read, so every
   * retry moves on to a new candidate. `ownSlug` (the entity's current slug,
   * on update) is never a conflict.
   */
  private createSlugPicker(
    entityType: string,
    label: string,
    ownSlug?: string,
  ): (refusedSlug?: string) => Promise<string> {
    const refused = new Set<string>();
    return async (refusedSlug) => {
      if (refusedSlug !== undefined) refused.add(refusedSlug);
      return generateUniqueSlug(entityType, label, async (candidateSlug) => {
        if (refused.has(candidateSlug)) return true;
        if (candidateSlug === ownSlug) return false;
        const holder = await this.storage.getEntityBySlug(this.repositoryId, candidateSlug);
        return holder !== null;
      });
    };
  }

  /**
   * Run a write that stores `slug`, re-picking the slug when the store
   * reports it as held by another entity. The free-slug check and the write
   * are separate steps, so a concurrent writer with the same type and label
   * can claim the slug in between; a bounded number of retries absorbs that.
   * Any other error, and the conflict after the last retry, propagates.
   */
  private async writeWithSlugRetry<T>(
    slug: string,
    write: (slug: string) => Promise<T>,
    pickSlug: (refusedSlug: string) => Promise<string>,
  ): Promise<T> {
    let candidate = slug;
    for (let retry = 0; ; retry++) {
      try {
        return await write(candidate);
      } catch (err) {
        if (!isSlugConflict(err) || retry >= MAX_SLUG_CONFLICT_RETRIES) throw err;
        candidate = await pickSlug(candidate);
      }
    }
  }

  /** Update an existing entity */
  public async update(entityId: string, updates: UpdateEntityInput): Promise<Entity> {
    // Key rules govern the names being written. A null asks for a key's
    // removal and is allowed for any name, so a key stored before the rules
    // existed can still be cleared.
    if (updates.properties) {
      assertWritablePropertyKeys(
        Object.fromEntries(Object.entries(updates.properties).filter(([, value]) => value !== null)),
        'entity',
      );
    }

    // Get existing entity to determine its type for validation. Storage
    // answers a deleted repository with RepositoryNotFoundError before any
    // miss, so a null here is a missing entity.
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
    let pickSlug: ((refusedSlug?: string) => Promise<string>) | undefined;
    if (typeChanged || labelChanged) {
      pickSlug = this.createSlugPicker(
        updates.entityType ?? existing.entityType,
        updates.label ?? existing.label,
        existing.slug,
      );
      newSlug = await pickSlug();
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

    // Persist. When the slug changes, re-pick it if a concurrent writer
    // claimed it first.
    const write = (slug: string | undefined): Promise<StoredEntity> =>
      this.storage.updateEntity(this.repositoryId, entityId, {
        entityType: typeChanged ? updates.entityType : undefined,
        label: updates.label,
        slug,
        summary: updates.summary,
        properties: updates.properties ? mergedProperties : undefined,
        data: updates.data,
        dataFormat: updates.dataFormat,
        provenance,
        embedding: entityEmbedding,
      });
    const updated =
      newSlug !== undefined && newSlug !== existing.slug && pickSlug !== undefined
        ? await this.writeWithSlugRetry(newSlug, write, pickSlug)
        : await write(newSlug);

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

  /**
   * Delete an entity. Throws `RepositoryNotFoundError` when the repository is
   * gone (raised by storage's entity read), otherwise `EntityNotFoundError`
   * when the entity does not exist.
   */
  public async delete(entityId: string): Promise<void> {
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
    /**
     * Total is `number | undefined` because PaginatedResult.total may be
     * undefined under some provider/query combinations. For the unfiltered
     * count this method issues, total is always exact in practice — callers
     * that need a guaranteed number should fall back to RepositoryStats.
     */
    onProgress?: (processed: number, total: number | undefined, failed: number) => void | Promise<void>;
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

    // Count total entities. `total` is the exact count for unfiltered
    // findEntities calls on every provider — but PaginatedResult.total is
    // `number | undefined` (the properties-filtered Cosmos path returns
    // undefined; that does not apply here, but the type is shared). We
    // tolerate undefined defensively: the loop falls back to running until
    // pages run dry, and the empty-page break below still terminates.
    const firstPage = await this.storage.findEntities(this.repositoryId, { limit: 1, offset: 0 });
    const total = firstPage.total;

    let totalProcessed = 0;
    let totalFailed = 0;
    const allErrors: Array<{ entityId: string; error: string }> = [];
    let offset = 0;

    while (total === undefined || offset < total) {
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

      // Rate limiting: pause between batches if configured. When total is
      // unknown, pause as long as the page came back full (= more probably).
      const delayMs = options?.delayBetweenBatchesMs ?? 0;
      const moreLikely = total === undefined ? page.items.length === batchSize : offset < total;
      if (delayMs > 0 && moreLikely) {
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

  /**
   * Generate an embedding vector from label + summary + embeddable string
   * properties if a provider is available. `vocabulary` is the one the write
   * was validated against, when the caller has it; otherwise it is read.
   */
  private async generateEmbedding(
    label: string,
    summary: string | undefined,
    properties: Record<string, unknown>,
    entityType: string,
    vocabulary?: MemoryVocabulary,
  ): Promise<number[] | undefined> {
    if (!this.embedding) return undefined;
    const vocab = vocabulary ?? (await this.vocabularyEngine.getVocabulary());
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
