// RepositoryImporter — imports an export archive into a repository

import type { StorageProvider } from '../providers/StorageProvider.js';
import type {
  AdaptiveConcurrencyHandle,
  ExportArchive,
  ImportOptions,
  ImportResult,
  ImportWarning,
  ImportChunk,
  ImportStreamHeader,
} from '../types/portability.js';
import type { RepositoryConfig } from '../types/repositories.js';
import { MigrationEngine } from './MigrationEngine.js';
import { generateId } from '../core/DeepMemory.js';
import { DuplicateRelationshipError, OperationAbortedError } from '../core/errors.js';

/** Progress info emitted after each chunk is processed */
export interface ImportProgress {
  repositoryId: string;
  entitiesImported: number;
  relationshipsImported: number;
  totalEntities: number;
  totalRelationships: number;
  chunksCompleted: number;
  totalChunks: number;
}

/** A single item that failed to import. Streamed live via {@link ImporterConfig.onItemFailed}. */
export interface ImportItemFailure {
  /** GUID of the entity or relationship that failed. Empty string if the storage layer did not surface an id. */
  itemId: string;
  itemType: 'entity' | 'relationship';
  error: string;
}

export interface ImporterConfig {
  storage: StorageProvider;
  actorId: string;
  /** Called after each chunk is processed — wire to EventBus or progress UI */
  onProgress?: (progress: ImportProgress) => void | Promise<void>;
  /**
   * Called for every entity or relationship that fails to import. Streams
   * per-item errors as they happen, in addition to being collected in the
   * final {@link ImportResult.warnings}.
   */
  onItemFailed?: (failure: ImportItemFailure) => void | Promise<void>;
  /**
   * Caller-supplied abort signal. Honoured at chunk boundaries — the chunk
   * currently in flight completes before the abort is observed, and any
   * entities/relationships already written are left in place. Throws
   * {@link OperationAbortedError} when triggered.
   */
  signal?: AbortSignal;
}

/** Estimate total chunks from entity + relationship counts */
function estimateChunkCount(totalEntities: number, totalRelationships: number): number {
  const ESTIMATED_CHUNK_SIZE = 100;
  return Math.max(
    1,
    Math.ceil(totalEntities / ESTIMATED_CHUNK_SIZE) + Math.ceil(totalRelationships / ESTIMATED_CHUNK_SIZE),
  );
}

export class RepositoryImporter {
  private readonly storage: StorageProvider;
  private readonly actorId: string;
  private readonly onProgress?: (progress: ImportProgress) => void | Promise<void>;
  private readonly onItemFailed?: (failure: ImportItemFailure) => void | Promise<void>;
  private readonly signal?: AbortSignal;
  private readonly migrationEngine = new MigrationEngine();

  constructor(config: ImporterConfig) {
    this.storage = config.storage;
    this.actorId = config.actorId;
    this.onProgress = config.onProgress;
    this.onItemFailed = config.onItemFailed;
    this.signal = config.signal;
  }

  private throwIfAborted(): void {
    if (this.signal?.aborted) {
      throw new OperationAbortedError('import');
    }
  }

  /**
   * Import an export archive according to the provided options.
   * Convenience wrapper around importStream() — use for small repositories.
   * For large repositories, use importStream() directly.
   */
  async import(archive: ExportArchive, options: ImportOptions): Promise<ImportResult> {
    const validationWarnings = this.validateArchive(archive);
    if (validationWarnings.length > 0) {
      // If basic validation fails, return early
      const hasCritical = validationWarnings.some((w) => w.code === 'invalid_archive');
      if (hasCritical) {
        return {
          success: false,
          repositoryId: options.target.repositoryId,
          statistics: { entitiesImported: 0, entitiesSkipped: 0, relationshipsImported: 0, relationshipsSkipped: 0, vocabularyExtensions: 0 },
          warnings: validationWarnings,
        };
      }
    }

    const header: ImportStreamHeader = {
      manifest: archive.manifest,
      vocabulary: archive.vocabulary,
    };

    // Convert the archive arrays into a single chunk
    async function* toChunks(): AsyncGenerator<ImportChunk> {
      yield { entities: archive.entities };
      yield { relationships: archive.relationships };
    }

    return this.importStream(header, toChunks(), options);
  }

  /**
   * Streaming import — processes data from an async iterable of chunks.
   * For large repositories, this avoids loading everything into memory at once.
   *
   * The caller provides the header (manifest + vocabulary) up front,
   * then streams ImportChunks containing batches of entities and/or relationships.
   */
  async importStream(
    header: ImportStreamHeader,
    chunks: AsyncIterable<ImportChunk>,
    options: ImportOptions,
  ): Promise<ImportResult> {
    const warnings: ImportWarning[] = [];

    if (!header.manifest) {
      warnings.push({ code: 'invalid_archive', message: 'Header is missing manifest' });
    }
    if (!header.vocabulary) {
      warnings.push({ code: 'invalid_archive', message: 'Header is missing vocabulary' });
    }

    if (options.target.mode === 'create') {
      return this.importStreamCreate(header, chunks, options, warnings);
    } else {
      return this.importStreamMerge(header, chunks, options, warnings);
    }
  }

  /** Streaming create mode — fast bulk inserts with no existence checks */
  private async importStreamCreate(
    header: ImportStreamHeader,
    chunks: AsyncIterable<ImportChunk>,
    options: ImportOptions,
    warnings: ImportWarning[],
  ): Promise<ImportResult> {
    const target = options.target as { mode: 'create'; repositoryId: string; config: RepositoryConfig };

    // Create the repository if it doesn't already exist
    const existing = await this.storage.getRepository(target.repositoryId);
    if (!existing) {
      const now = new Date().toISOString();
      await this.storage.createRepository({
        repositoryId: target.repositoryId,
        type: target.config.type,
        label: target.config.label,
        description: target.config.description,
        governanceConfig: target.config.governance ?? { mode: 'open' },
        createdAt: now,
        createdBy: this.actorId,
      });
    }

    // Save the vocabulary from the header
    await this.storage.saveVocabulary(target.repositoryId, header.vocabulary);

    // Process chunks incrementally — skip existence checks since the repo is freshly created
    const totalEntities = header.manifest?.statistics?.entityCount ?? 0;
    const totalRelationships = header.manifest?.statistics?.relationshipCount ?? 0;
    const totalChunks = estimateChunkCount(totalEntities, totalRelationships);
    let entitiesImported = 0;
    let relationshipsImported = 0;
    let chunksCompleted = 0;

    // One adaptive-concurrency handle for the whole import. Threaded into
    // every importBulk call so providers that support adaptive concurrency
    // (e.g. CosmosDB) reuse a single controller across chunks instead of
    // resetting at each call. Providers that ignore the handle (e.g. SQL
    // Server) are unaffected. The handle is opaque — the caller's own
    // options.bulk.adaptiveConcurrencyHandle, if any, takes precedence so
    // direct consumers of importStream can pre-create one.
    const adaptiveConcurrencyHandle: AdaptiveConcurrencyHandle =
      options.bulk?.adaptiveConcurrencyHandle ?? {};

    for await (const chunk of chunks) {
      this.throwIfAborted();
      const bulkResult = await this.storage.importBulk(target.repositoryId, [chunk], {
        ...options.bulk,
        skipExistenceCheck: true,
        adaptiveConcurrencyHandle,
      });
      entitiesImported += bulkResult.entitiesImported;
      relationshipsImported += bulkResult.relationshipsImported;
      chunksCompleted++;

      for (const e of bulkResult.errors) {
        warnings.push({
          code: 'import_error',
          message: `Failed to import ${e.item}: ${e.error}`,
          id: e.item,
        });
        const itemType: 'entity' | 'relationship' =
          chunk.entities?.some((x) => x.id === e.item) ? 'entity' :
          chunk.relationships?.some((x) => x.id === e.item) ? 'relationship' :
          'entity';
        await this.onItemFailed?.({ itemId: e.item, itemType, error: e.error });
      }

      await this.onProgress?.({
        repositoryId: target.repositoryId,
        entitiesImported,
        relationshipsImported,
        totalEntities,
        totalRelationships,
        chunksCompleted,
        totalChunks,
      });
    }

    return {
      success: true,
      repositoryId: target.repositoryId,
      statistics: {
        entitiesImported,
        entitiesSkipped: 0,
        relationshipsImported,
        relationshipsSkipped: 0,
        vocabularyExtensions: 0,
      },
      warnings,
    };
  }

  /** Streaming merge mode — process chunks with per-entity conflict resolution */
  private async importStreamMerge(
    header: ImportStreamHeader,
    chunks: AsyncIterable<ImportChunk>,
    options: ImportOptions,
    warnings: ImportWarning[],
  ): Promise<ImportResult> {
    const target = options.target as { mode: 'merge'; repositoryId: string };
    const repositoryId = target.repositoryId;

    // Verify target exists
    const existingRepo = await this.storage.getRepository(repositoryId);
    if (!existingRepo) {
      return {
        success: false,
        repositoryId,
        statistics: { entitiesImported: 0, entitiesSkipped: 0, relationshipsImported: 0, relationshipsSkipped: 0, vocabularyExtensions: 0 },
        warnings: [{ code: 'repository_not_found', message: `Repository "${repositoryId}" not found` }],
      };
    }

    // Handle vocabulary migration
    const targetVocabulary = await this.storage.getVocabulary(repositoryId);
    const conflictMode = options.vocabularyConflict ?? 'reject';
    const migrationResult = this.migrationEngine.migrate(
      header.vocabulary,
      targetVocabulary,
      conflictMode,
      this.actorId,
    );

    warnings.push(...migrationResult.warnings);

    if (!migrationResult.success) {
      return {
        success: false,
        repositoryId,
        statistics: { entitiesImported: 0, entitiesSkipped: 0, relationshipsImported: 0, relationshipsSkipped: 0, vocabularyExtensions: 0 },
        warnings: [...warnings, { code: 'vocabulary_migration_failed', message: migrationResult.reason ?? 'Vocabulary migration failed' }],
      };
    }

    if (migrationResult.mergedVocabulary && migrationResult.mergedVocabulary !== targetVocabulary) {
      await this.storage.saveVocabulary(repositoryId, migrationResult.mergedVocabulary);
    }

    // Process chunks incrementally with conflict resolution
    const totalEntities = header.manifest?.statistics?.entityCount ?? 0;
    const totalRelationships = header.manifest?.statistics?.relationshipCount ?? 0;
    const totalChunks = estimateChunkCount(totalEntities, totalRelationships);
    const entityConflict = options.entityConflict ?? 'skip';
    let entitiesImported = 0;
    let entitiesSkipped = 0;
    let relationshipsImported = 0;
    let relationshipsSkipped = 0;
    let chunksCompleted = 0;

    for await (const chunk of chunks) {
      this.throwIfAborted();
      // Process entities in this chunk
      if (chunk.entities) {
        for (const entity of chunk.entities) {
          // Check for conflict by GUID first, then fall back to slug match
          let existing = await this.storage.getEntity(repositoryId, entity.id);
          if (!existing && entity.slug) {
            existing = await this.storage.getEntityBySlug(repositoryId, entity.slug);
          }

          if (existing) {
            const existingId = existing.id;
            switch (entityConflict) {
              case 'skip':
                entitiesSkipped++;
                warnings.push({
                  code: 'entity_skipped',
                  message: `Entity "${entity.slug}" already exists — skipped`,
                  id: existingId,
                });
                continue;

              case 'overwrite':
                await this.storage.updateEntity(repositoryId, existingId, {
                  label: entity.label,
                  slug: entity.slug,
                  summary: entity.summary,
                  properties: entity.properties,
                  data: entity.data,
                  dataFormat: entity.dataFormat,
                  provenance: entity.provenance,
                  embedding: entity.embedding,
                });
                entitiesImported++;
                warnings.push({
                  code: 'entity_overwritten',
                  message: `Entity "${entity.slug}" overwritten`,
                  id: existingId,
                });
                continue;

              case 'rename': {
                // Create a new entity with a new GUID and modified slug to avoid collision
                const renamedEntity = { ...entity, id: generateId(), slug: `${entity.slug}-imported` };
                await this.storage.createEntity(repositoryId, renamedEntity);
                entitiesImported++;
                warnings.push({
                  code: 'entity_renamed',
                  message: `Entity "${entity.slug}" slug renamed to "${renamedEntity.slug}"`,
                  id: entity.id,
                });
                continue;
              }
            }
          } else {
            await this.storage.createEntity(repositoryId, entity);
            entitiesImported++;
          }
        }
      }

      // Process relationships in this chunk
      if (chunk.relationships) {
        for (const rel of chunk.relationships) {
          const existing = await this.storage.getRelationship(repositoryId, rel.id);

          if (existing) {
            relationshipsSkipped++;
            warnings.push({
              code: 'relationship_skipped',
              message: `Relationship "${rel.id}" already exists — skipped`,
              relationshipId: rel.id,
            });
          } else {
            const sourceExists = await this.storage.getEntity(repositoryId, rel.sourceEntityId);
            const targetExists = await this.storage.getEntity(repositoryId, rel.targetEntityId);

            if (!sourceExists || !targetExists) {
              relationshipsSkipped++;
              const errorMsg = `source or target entity missing`;
              warnings.push({
                code: 'relationship_orphaned',
                message: `Relationship "${rel.id}" skipped — ${errorMsg}`,
                relationshipId: rel.id,
              });
              await this.onItemFailed?.({ itemId: rel.id, itemType: 'relationship', error: errorMsg });
            } else {
              try {
                await this.storage.createRelationship(repositoryId, rel);
                relationshipsImported++;
              } catch (err) {
                // Storage layers may enforce composite uniqueness (e.g. source+target+type)
                // that getRelationship() by ID cannot detect. Treat as skip+warning,
                // consistent with the duplicate-by-id branch above.
                if (err instanceof DuplicateRelationshipError) {
                  relationshipsSkipped++;
                  warnings.push({
                    code: 'relationship_skipped',
                    message: `Relationship "${rel.id}" already exists — skipped`,
                    relationshipId: rel.id,
                  });
                } else {
                  throw err;
                }
              }
            }
          }
        }
      }

      chunksCompleted++;
      await this.onProgress?.({
        repositoryId,
        entitiesImported,
        relationshipsImported,
        totalEntities,
        totalRelationships,
        chunksCompleted,
        totalChunks,
      });
    }

    const vocabExtensions = migrationResult.warnings.filter(
      (w) => w.code === 'entity_type_added' || w.code === 'relationship_type_added',
    ).length;

    return {
      success: true,
      repositoryId,
      statistics: {
        entitiesImported,
        entitiesSkipped,
        relationshipsImported,
        relationshipsSkipped,
        vocabularyExtensions: vocabExtensions,
      },
      warnings,
    };
  }

  /** Basic archive validation */
  private validateArchive(archive: ExportArchive): ImportWarning[] {
    const warnings: ImportWarning[] = [];

    if (!archive.manifest) {
      warnings.push({ code: 'invalid_archive', message: 'Archive is missing manifest' });
    }
    if (!archive.vocabulary) {
      warnings.push({ code: 'invalid_archive', message: 'Archive is missing vocabulary' });
    }
    if (!archive.entities) {
      warnings.push({ code: 'invalid_archive', message: 'Archive is missing entities array' });
    }
    if (!archive.relationships) {
      warnings.push({ code: 'invalid_archive', message: 'Archive is missing relationships array' });
    }

    return warnings;
  }
}
