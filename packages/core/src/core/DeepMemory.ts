// DeepMemory — top-level API for managing memory repositories

import { randomUUID } from 'node:crypto';
import type { StorageProvider, EnsureSchemaResult } from '../providers/StorageProvider.js';
import type { SearchProvider } from '../providers/SearchProvider.js';
import type { EmbeddingProvider, EmbeddingProviderFactory } from '../providers/EmbeddingProvider.js';
import type { LockProvider } from '../providers/LockProvider.js';
import type { GraphTraversalProvider } from '../providers/GraphTraversalProvider.js';
import type { ProvenanceContext } from '../types/provenance.js';
import type {
  RepositoryConfig,
  RepositoryUpdate,
  RepositorySummary,
  RepositoryFilter,
  StoredRepository,
} from '../types/repositories.js';
import type {
  DeepMemoryEventType,
  EventHandler,
  Unsubscribe,
} from '../types/events.js';
import type { PaginatedResult } from '../types/results.js';
import type { ExportArchive, ExportOptions, ExportStreamItem, ImportOptions, ImportResult, ImportChunk, ImportStreamHeader } from '../types/portability.js';
import type { ReembedResult } from '../types/results.js';
import { MemoryRepository } from './MemoryRepository.js';
import { VocabularyEngine } from './VocabularyEngine.js';
import { ProvenanceTracker } from './ProvenanceTracker.js';
import { EventBus } from './EventBus.js';
import {
  buildVocabulary,
  createEmptyVocabulary,
} from '../vocabulary/VocabularySchema.js';
import { RepositoryExporter } from '../portability/RepositoryExporter.js';
import { RepositoryImporter } from '../portability/RepositoryImporter.js';
import { InvalidInputError, RepositoryNotFoundError } from './errors.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generate a v4 UUID using Node's crypto.randomUUID (CSPRNG-backed). */
export function generateId(): string {
  return randomUUID();
}

/** Validate that a string is a valid UUID */
export function isValidUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/** Configuration for creating a DeepMemory instance */
export interface DeepMemoryConfig {
  /** Required: the storage provider for persistence */
  storage: StorageProvider;
  /** Optional: search provider for full-text search */
  search?: SearchProvider;
  /**
   * Optional: factory that produces an EmbeddingProvider configured for a specific
   * model + dimensionality. Called once per repository open/create using the repo's
   * stored embedding metadata, so different repositories can use different models
   * and embedding dimensions without any per-mutation lookups.
   */
  embeddingFactory?: EmbeddingProviderFactory;
  /** Default embedding model for new repositories that don't specify one in metadata */
  defaultEmbeddingModel?: string;
  /** Default embedding dimensions for new repositories that don't specify one in metadata */
  defaultEmbeddingDimensions?: number;
  /** Optional: lock provider for distributed locking */
  lock?: LockProvider;
  /** Optional: graph traversal provider for native multi-hop queries */
  graphTraversal?: GraphTraversalProvider;
  /** Required: provenance context identifying the actor */
  provenance: ProvenanceContext;
}

export class DeepMemory {
  private readonly storage: StorageProvider;
  private readonly search?: SearchProvider;
  private readonly embeddingFactory?: EmbeddingProviderFactory;
  private readonly defaultEmbeddingModel?: string;
  private readonly defaultEmbeddingDimensions?: number;
  /** Reserved for future distributed locking support */
  public readonly lock?: LockProvider;
  private readonly graphTraversalProvider?: GraphTraversalProvider;
  private readonly provenance: ProvenanceTracker;
  private readonly globalEventBus: EventBus;
  private initialized = false;

  public constructor(config: DeepMemoryConfig) {
    this.storage = config.storage;
    this.search = config.search;
    this.embeddingFactory = config.embeddingFactory;
    this.defaultEmbeddingModel = config.defaultEmbeddingModel;
    this.defaultEmbeddingDimensions = config.defaultEmbeddingDimensions;
    this.lock = config.lock;
    this.graphTraversalProvider = config.graphTraversal;
    this.provenance = new ProvenanceTracker(config.provenance);
    this.globalEventBus = new EventBus(config.provenance);
  }

  /**
   * Build an embedding provider for a repository given its stored model + dimensions.
   * Returns undefined when no factory is configured or when model/dimensions are missing.
   */
  private buildEmbeddingForRepository(
    model: string | undefined,
    dimensions: number | undefined,
  ): EmbeddingProvider | undefined {
    if (!this.embeddingFactory || !model || dimensions === undefined) return undefined;
    return this.embeddingFactory({ model, dimensions });
  }

  /** Initialize the storage provider and optional providers (call once before use) */
  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      if (this.storage.initialize) {
        await this.storage.initialize();
      }
      if (this.graphTraversalProvider?.initialize) {
        await this.graphTraversalProvider.initialize();
      }
      this.initialized = true;
    }
  }

  /** Create or migrate the storage schema. Call once at deployment / startup, not per-request. */
  public async ensureSchema(): Promise<EnsureSchemaResult> {
    const noOpResult: EnsureSchemaResult = {
      databaseCreated: false,
      schemaCreated: false,
      alreadyUpToDate: true,
      schemaVersion: 0,
    };

    // Try to initialize normally first. If the storage provider's ensureSchema
    // can create the database itself, we allow init to fail and retry after.
    try {
      await this.ensureInitialized();
    } catch {
      // initialize may fail if the database doesn't exist yet — ensureSchema
      // on the storage provider can create it, so we continue.
    }

    let result: EnsureSchemaResult = noOpResult;
    if (this.storage.ensureSchema) {
      result = await this.storage.ensureSchema();
    }

    // If initialize failed earlier (e.g. DB didn't exist), retry now that
    // ensureSchema may have created it.
    if (!this.initialized) {
      await this.ensureInitialized();
    }

    return result;
  }

  private validateRepositoryId(repositoryId: string): void {
    if (!isValidUuid(repositoryId)) {
      throw new InvalidInputError(
        'repositoryId',
        `Repository ID "${repositoryId}" is not a valid UUID`,
        `Provide a valid UUID (e.g. "550e8400-e29b-41d4-a716-446655440000") or omit repositoryId to auto-generate one.`,
      );
    }
  }

  /** Create a new memory repository */
  public async createRepository(config: RepositoryConfig): Promise<MemoryRepository> {
    await this.ensureInitialized();

    const repositoryId = config.repositoryId ?? generateId();
    this.validateRepositoryId(repositoryId);
    const context = this.provenance.getContext();
    const now = new Date().toISOString();

    const governanceConfig = config.governance ?? { mode: 'open' as const };

    // Build metadata: explicit config values take precedence, then fall back to server defaults.
    // Embedding model + dimensions live on the repository itself so each repo can use a
    // different configuration without per-mutation lookups.
    const metadata = { ...config.metadata };
    if (!metadata.embeddingModelId && this.defaultEmbeddingModel) {
      metadata.embeddingModelId = this.defaultEmbeddingModel;
    }
    if (metadata.embeddingDimensions === undefined && this.defaultEmbeddingDimensions !== undefined) {
      metadata.embeddingDimensions = this.defaultEmbeddingDimensions;
    }

    // Create the repository in storage
    await this.storage.createRepository({
      repositoryId,
      type: config.type,
      label: config.label,
      description: config.description,
      legal: config.legal,
      owner: config.owner,
      governanceConfig,
      metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
      createdAt: now,
      createdBy: context.actorId,
    });

    // Build and save initial vocabulary
    const vocabulary = config.vocabulary
      ? buildVocabulary(config.vocabulary, context.actorId)
      : createEmptyVocabulary(context.actorId);

    await this.storage.saveVocabulary(repositoryId, vocabulary);

    // Build per-repository embedding provider from the repo's stored model + dimensions
    const embedding = this.buildEmbeddingForRepository(
      metadata.embeddingModelId,
      metadata.embeddingDimensions,
    );

    // Create internal components
    const eventBus = new EventBus(context, repositoryId);
    const vocabularyEngine = new VocabularyEngine({
      repositoryId,
      storageProvider: this.storage,
      governanceConfig,
      embeddingProvider: embedding,
    });

    const repo = new MemoryRepository({
      repositoryId,
      storage: this.storage,
      search: this.search,
      embedding,
      embeddingFactory: this.embeddingFactory,
      graphTraversal: this.graphTraversalProvider,
      vocabularyEngine,
      provenanceTracker: this.provenance,
      eventBus,
    });

    // Emit repository created event
    await this.globalEventBus.emit('repository:created', {
      repositoryId,
      label: config.label,
    });

    return repo;
  }

  /** Open an existing repository */
  public async openRepository(repositoryId: string): Promise<MemoryRepository> {
    await this.ensureInitialized();
    this.validateRepositoryId(repositoryId);

    const storedRepo = await this.storage.getRepository(repositoryId);
    if (!storedRepo) {
      throw new RepositoryNotFoundError(repositoryId);
    }

    const context = this.provenance.getContext();
    const eventBus = new EventBus(context, repositoryId);

    // Build the per-repository embedding provider from stored metadata.
    // Falls back to server defaults only if the repo has no embedding metadata
    // recorded yet (e.g. created before this field existed).
    const embedding = this.buildEmbeddingForRepository(
      storedRepo.metadata?.embeddingModelId ?? this.defaultEmbeddingModel,
      storedRepo.metadata?.embeddingDimensions ?? this.defaultEmbeddingDimensions,
    );

    const vocabularyEngine = new VocabularyEngine({
      repositoryId,
      storageProvider: this.storage,
      governanceConfig: storedRepo.governanceConfig,
      embeddingProvider: embedding,
    });

    const repo = new MemoryRepository({
      repositoryId,
      storage: this.storage,
      search: this.search,
      embedding,
      embeddingFactory: this.embeddingFactory,
      graphTraversal: this.graphTraversalProvider,
      vocabularyEngine,
      provenanceTracker: this.provenance,
      eventBus,
    });

    await this.globalEventBus.emit('repository:opened', { repositoryId });

    return repo;
  }

  /** Get the full stored record for a single repository (including legal, owner, metadata, governance) */
  public async getRepository(repositoryId: string): Promise<StoredRepository> {
    await this.ensureInitialized();
    this.validateRepositoryId(repositoryId);

    const storedRepo = await this.storage.getRepository(repositoryId);
    if (!storedRepo) {
      throw new RepositoryNotFoundError(repositoryId);
    }
    return storedRepo;
  }

  /** List all repositories */
  public async listRepositories(
    filter?: RepositoryFilter,
  ): Promise<PaginatedResult<RepositorySummary>> {
    await this.ensureInitialized();

    const result = await this.storage.listRepositories(filter);

    return {
      items: result.items.map((stored) => ({
        repositoryId: stored.repositoryId,
        type: stored.type,
        label: stored.label,
        description: stored.description,
        governanceMode: stored.governanceConfig.mode,
      })),
      total: result.total,
      hasMore: result.hasMore,
      limit: result.limit,
      offset: result.offset,
    };
  }

  /** Update repository metadata and settings */
  public async updateRepository(repositoryId: string, updates: RepositoryUpdate): Promise<StoredRepository> {
    await this.ensureInitialized();
    this.validateRepositoryId(repositoryId);
    const updated = await this.storage.updateRepository(repositoryId, updates);
    await this.globalEventBus.emit('repository:updated', { repositoryId });
    return updated;
  }

  /** Delete a repository */
  public async deleteRepository(repositoryId: string): Promise<void> {
    await this.ensureInitialized();
    this.validateRepositoryId(repositoryId);

    const stats = await this.storage.getRepositoryStats(repositoryId);
    await this.globalEventBus.emit('delete:started', {
      repositoryId,
      totalEntities: stats.entityCount,
      totalRelationships: stats.relationshipCount,
    });

    await this.storage.deleteRepository(repositoryId, (progress) =>
      this.globalEventBus.emit('delete:progress', { repositoryId, ...progress }),
    );

    await this.globalEventBus.emit('delete:completed', {
      repositoryId,
      entitiesDeleted: stats.entityCount,
      relationshipsDeleted: stats.relationshipCount,
    });
    await this.globalEventBus.emit('repository:deleted', { repositoryId });
  }

  /** Delete all entities and relationships in a repository, preserving the repository and vocabulary */
  public async deleteAllContents(repositoryId: string): Promise<{ deletedEntities: number; deletedRelationships: number }> {
    await this.ensureInitialized();
    this.validateRepositoryId(repositoryId);

    const stats = await this.storage.getRepositoryStats(repositoryId);
    await this.globalEventBus.emit('delete:started', {
      repositoryId,
      totalEntities: stats.entityCount,
      totalRelationships: stats.relationshipCount,
    });

    const result = await this.storage.deleteAllContents(repositoryId, (progress) =>
      this.globalEventBus.emit('delete:progress', { repositoryId, ...progress }),
    );

    await this.globalEventBus.emit('delete:completed', {
      repositoryId,
      entitiesDeleted: result.deletedEntities,
      relationshipsDeleted: result.deletedRelationships,
    });

    return result;
  }

  /** Export a repository to a portable archive */
  public async exportRepository(repositoryId: string, options?: ExportOptions): Promise<ExportArchive> {
    await this.ensureInitialized();

    const stats = await this.storage.getRepositoryStats(repositoryId);
    await this.globalEventBus.emit('export:started', {
      repositoryId,
      totalEntities: stats.entityCount,
      totalRelationships: stats.relationshipCount,
    });

    const exporter = new RepositoryExporter({
      storage: this.storage,
      provenance: this.provenance.getContext(),
      legal: options?.legal,
    });

    const archive = await exporter.export(repositoryId);

    await this.globalEventBus.emit('export:completed', {
      repositoryId,
      entityCount: archive.entities.length,
      relationshipCount: archive.relationships.length,
    });

    return archive;
  }

  /** Import a repository from a portable archive */
  public async importRepository(
    archive: ExportArchive,
    options: ImportOptions,
  ): Promise<ImportResult> {
    await this.ensureInitialized();

    await this.globalEventBus.emit('import:started', { repositoryId: options.target.repositoryId });

    const importer = new RepositoryImporter({
      storage: this.storage,
      actorId: this.provenance.getContext().actorId,
      onProgress: (progress) => this.globalEventBus.emit('import:progress', progress),
      onItemFailed: (failure) =>
        this.globalEventBus.emit('import:item-failed', {
          repositoryId: options.target.repositoryId,
          itemId: failure.itemId,
          itemType: failure.itemType,
          error: failure.error,
        }),
      signal: options.signal,
    });

    try {
      const result = await importer.import(archive, options);

      if (result.success) {
        await this.globalEventBus.emit('import:completed', {
          repositoryId: result.repositoryId,
          entitiesImported: result.statistics.entitiesImported,
          relationshipsImported: result.statistics.relationshipsImported,
        });
      } else {
        await this.globalEventBus.emit('import:failed', {
          repositoryId: result.repositoryId,
          error: result.warnings.map((w) => w.message).join('; '),
        });
      }

      return result;
    } catch (err) {
      await this.globalEventBus.emit('import:failed', {
        repositoryId: options.target.repositoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Stream a repository export as an async generator.
   * Yields: manifest → vocabulary → entity chunks → relationship chunks.
   * Use for large repositories to avoid loading everything into memory.
   */
  public async *exportRepositoryStream(repositoryId: string, options?: ExportOptions): AsyncGenerator<ExportStreamItem> {
    await this.ensureInitialized();

    const exporter = new RepositoryExporter({
      storage: this.storage,
      provenance: this.provenance.getContext(),
      legal: options?.legal,
    });

    // Get stats up front so progress events have totals
    const stats = await this.storage.getRepositoryStats(repositoryId);
    const totalEntities = stats.entityCount;
    const totalRelationships = stats.relationshipCount;
    const estimatedChunkSize = 100;
    const totalChunks = Math.max(
      1,
      Math.ceil(totalEntities / estimatedChunkSize) + Math.ceil(totalRelationships / estimatedChunkSize),
    );

    await this.globalEventBus.emit('export:started', { repositoryId, totalEntities, totalRelationships });

    let entityCount = 0;
    let relationshipCount = 0;
    let chunksCompleted = 0;

    for await (const item of exporter.exportStream(repositoryId)) {
      yield item;

      if (item.type === 'entities') {
        entityCount += item.data.length;
        chunksCompleted++;
        await this.globalEventBus.emit('export:progress', {
          repositoryId,
          entitiesExported: entityCount,
          relationshipsExported: relationshipCount,
          totalEntities,
          totalRelationships,
          chunksCompleted,
          totalChunks,
        });
      } else if (item.type === 'relationships') {
        relationshipCount += item.data.length;
        chunksCompleted++;
        await this.globalEventBus.emit('export:progress', {
          repositoryId,
          entitiesExported: entityCount,
          relationshipsExported: relationshipCount,
          totalEntities,
          totalRelationships,
          chunksCompleted,
          totalChunks,
        });
      }
    }

    await this.globalEventBus.emit('export:completed', {
      repositoryId,
      entityCount,
      relationshipCount,
    });
  }

  /**
   * Import a repository from a stream of chunks.
   * Use for large repositories to avoid loading everything into memory.
   */
  public async importRepositoryStream(
    header: ImportStreamHeader,
    chunks: AsyncIterable<ImportChunk>,
    options: ImportOptions,
  ): Promise<ImportResult> {
    await this.ensureInitialized();

    const importer = new RepositoryImporter({
      storage: this.storage,
      actorId: this.provenance.getContext().actorId,
      onProgress: (progress) => this.globalEventBus.emit('import:progress', progress),
      onItemFailed: (failure) =>
        this.globalEventBus.emit('import:item-failed', {
          repositoryId: options.target.repositoryId,
          itemId: failure.itemId,
          itemType: failure.itemType,
          error: failure.error,
        }),
      signal: options.signal,
    });

    await this.globalEventBus.emit('import:started', { repositoryId: options.target.repositoryId });

    try {
      const result = await importer.importStream(header, chunks, options);

      if (result.success) {
        await this.globalEventBus.emit('import:completed', {
          repositoryId: result.repositoryId,
          entitiesImported: result.statistics.entitiesImported,
          relationshipsImported: result.statistics.relationshipsImported,
        });
      } else {
        await this.globalEventBus.emit('import:failed', {
          repositoryId: result.repositoryId,
          error: result.warnings.map((w) => w.message).join('; '),
        });
      }

      return result;
    } catch (err) {
      await this.globalEventBus.emit('import:failed', {
        repositoryId: options.target.repositoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /**
   * Re-embed all entities in a repository, emitting `reembed:*` events on the
   * global event bus (reachable via {@link DeepMemory.on}).
   *
   * Mirrors the lifecycle of {@link importRepositoryStream}: emits
   * `reembed:started` up front, `reembed:progress` after every batch,
   * and either `reembed:completed` or `reembed:failed` at the end.
   *
   * `options.signal` is honoured at batch boundaries — any vectors already
   * written by completed batches are retained, and `reembed:failed` is emitted
   * with the abort error message.
   */
  public async reembedAll(
    repositoryId: string,
    options?: {
      model?: string;
      dimensions?: number;
      batchSize?: number;
      maxRetries?: number;
      errorThresholdToAbort?: number;
      delayBetweenBatchesMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<ReembedResult> {
    await this.ensureInitialized();

    const repo = await this.openRepository(repositoryId);
    const stats = await repo.getStats();

    await this.globalEventBus.emit('reembed:started', {
      repositoryId,
      totalEntities: stats.entityCount,
    });

    try {
      const result = await repo.reembedAll({
        ...options,
        // The repo signature widens `totalEntities` to `number | undefined`
        // because PaginatedResult.total may be undefined under some provider/
        // query combinations. The `reembed:progress` event contract is
        // `totalEntities: number`, so fall back to the cached stats count
        // when the inner layer doesn't supply one.
        onProgress: (progress) =>
          this.globalEventBus.emit('reembed:progress', {
            repositoryId,
            processed: progress.processed,
            totalEntities: progress.totalEntities ?? stats.entityCount,
            failed: progress.failed,
          }),
        onItemFailed: (failure) =>
          this.globalEventBus.emit('reembed:item-failed', {
            repositoryId,
            entityId: failure.entityId,
            error: failure.error,
          }),
      });

      await this.globalEventBus.emit('reembed:completed', {
        repositoryId,
        processed: result.processed,
        failed: result.failed,
        modelId: result.modelId,
      });

      return result;
    } catch (err) {
      await this.globalEventBus.emit('reembed:failed', {
        repositoryId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  /** Subscribe to global events */
  public on<E extends DeepMemoryEventType>(event: E, handler: EventHandler<E>): Unsubscribe {
    return this.globalEventBus.on(event, handler);
  }

  /** Update the provenance context (e.g., new conversation) */
  public updateProvenance(context: Partial<ProvenanceContext>): void {
    this.provenance.updateContext(context);
    this.globalEventBus.updateProvenance(this.provenance.getContext());
  }

  /** Dispose of all resources */
  public async dispose(): Promise<void> {
    this.globalEventBus.removeAllListeners();
    if (this.graphTraversalProvider?.dispose) {
      await this.graphTraversalProvider.dispose();
    }
    if (this.storage.dispose) {
      await this.storage.dispose();
    }
    this.initialized = false;
  }
}
