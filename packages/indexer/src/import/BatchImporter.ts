import type { ExportArchive, ImportResult, DeepMemory } from '@utaba/deep-memory';

/** Options for the batch import */
export interface BatchImportOptions {
  /** Import mode: 'create' for new repos, 'merge' for existing ones */
  mode: 'create' | 'merge';
  /** Repository ID */
  repositoryId: string;
  /** Repository label (required for create mode) */
  repositoryLabel?: string;
  /** How to handle vocabulary conflicts in merge mode */
  vocabularyConflict?: 'reject' | 'extend';
  /** How to handle entity conflicts in merge mode */
  entityConflict?: 'skip' | 'overwrite';
  /** Whether to re-embed entities after import */
  reEmbed?: boolean;
}

/**
 * Wraps deep-memory import for the indexing pipeline.
 *
 * Takes a DeepMemory instance and an ExportArchive (produced by the
 * Consolidator) and imports it into the target repository.
 */
export class BatchImporter {
  constructor(private readonly deepMemory: DeepMemory) {}

  /**
   * Import an ExportArchive into the repository.
   */
  async import(archive: ExportArchive, options: BatchImportOptions): Promise<ImportResult> {
    if (options.mode === 'create') {
      return this.deepMemory.importRepository(archive, {
        target: {
          mode: 'create',
          repositoryId: options.repositoryId,
          config: {
            repositoryId: options.repositoryId,
            label: options.repositoryLabel ?? 'Indexed Repository',
          },
        },
        reEmbed: options.reEmbed,
      });
    }

    return this.deepMemory.importRepository(archive, {
      target: {
        mode: 'merge',
        repositoryId: options.repositoryId,
      },
      vocabularyConflict: options.vocabularyConflict ?? 'extend',
      entityConflict: options.entityConflict ?? 'overwrite',
      reEmbed: options.reEmbed,
    });
  }

  /**
   * Import a large archive using streaming for better memory efficiency.
   */
  async importStreaming(archive: ExportArchive, options: BatchImportOptions): Promise<ImportResult> {
    const header = {
      manifest: archive.manifest,
      vocabulary: archive.vocabulary,
    };

    // Chunk entities and relationships into batches
    const BATCH_SIZE = 100;

    async function* chunks() {
      for (let i = 0; i < archive.entities.length; i += BATCH_SIZE) {
        yield { entities: archive.entities.slice(i, i + BATCH_SIZE) };
      }
      for (let i = 0; i < archive.relationships.length; i += BATCH_SIZE) {
        yield { relationships: archive.relationships.slice(i, i + BATCH_SIZE) };
      }
    }

    if (options.mode === 'create') {
      return this.deepMemory.importRepositoryStream(header, chunks(), {
        target: {
          mode: 'create',
          repositoryId: options.repositoryId,
          config: {
            repositoryId: options.repositoryId,
            label: options.repositoryLabel ?? 'Indexed Repository',
          },
        },
        reEmbed: options.reEmbed,
      });
    }

    return this.deepMemory.importRepositoryStream(header, chunks(), {
      target: {
        mode: 'merge',
        repositoryId: options.repositoryId,
      },
      vocabularyConflict: options.vocabularyConflict ?? 'extend',
      entityConflict: options.entityConflict ?? 'overwrite',
      reEmbed: options.reEmbed,
    });
  }
}
