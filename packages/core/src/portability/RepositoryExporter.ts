// RepositoryExporter — exports a repository to a portable archive

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { ProvenanceContext } from '../types/provenance.js';
import type { ExportArchive, ExportLegalMetadata, ExportManifest, ExportStreamItem } from '../types/portability.js';
import { RepositoryNotFoundError } from '../core/errors.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';

declare const __DEEP_MEMORY_VERSION__: string | undefined;

/** Injected by tsup at build time; falls back to package.json version in dev/test */
const LIBRARY_VERSION: string =
  typeof __DEEP_MEMORY_VERSION__ !== 'undefined'
    ? __DEEP_MEMORY_VERSION__
    : '0.1.0';

export interface ExporterConfig {
  storage: StorageProvider;
  provenance: ProvenanceContext;
  /** Legal/copyright metadata to embed in the export manifest */
  legal?: ExportLegalMetadata;
}

export class RepositoryExporter {
  private readonly storage: StorageProvider;
  private readonly provenance: ProvenanceContext;
  private readonly legal?: ExportLegalMetadata;

  constructor(config: ExporterConfig) {
    this.storage = config.storage;
    this.provenance = config.provenance;
    this.legal = config.legal;
  }

  /**
   * Stream a repository export as an async generator.
   * Yields: manifest → vocabulary → entity chunks → relationship chunks.
   * The caller can pipe this to a file, zip stream, or HTTP response.
   */
  async *exportStream(repositoryId: string): AsyncGenerator<ExportStreamItem> {
    const repo = await this.storage.getRepository(repositoryId);
    if (!repo) {
      throw new RepositoryNotFoundError(repositoryId);
    }

    const vocabulary = await this.storage.getVocabulary(repositoryId);
    const stats = await this.storage.getRepositoryStats(repositoryId);

    // Build and yield manifest
    const manifest: ExportManifest = {
      formatVersion: '1.0.0',
      libraryVersion: LIBRARY_VERSION,
      exportedAt: new Date().toISOString(),
      exportedBy: this.provenance,
      repository: {
        repositoryId,
        type: repo.type,
        label: repo.label,
        description: repo.description,
        vocabularyVersion: vocabulary.version,
        governanceMode: repo.governanceConfig.mode,
      },
      statistics: {
        entityCount: stats.entityCount,
        relationshipCount: stats.relationshipCount,
        entityTypeBreakdown: stats.entityTypeBreakdown,
        relationshipTypeBreakdown: stats.relationshipTypeBreakdown,
      },
    };

    // Legal metadata — set by the publisher of the archive
    if (this.legal) {
      manifest.legal = this.legal;
    }

    // Embedding metadata from the repository record — no live provider needed
    if (repo.metadata?.embeddingModelId) {
      manifest.embedding = {
        modelId: repo.metadata.embeddingModelId,
        dimensions: (repo.metadata.embeddingDimensions as number) ?? 0,
        note: 'Embeddings are model-specific. Re-embed after import if using a different model.',
      };
    }

    yield { type: 'manifest', data: manifest };
    yield { type: 'vocabulary', data: vocabulary };

    // Stream entity and relationship chunks from the storage provider
    for await (const chunk of this.storage.exportAll(repositoryId)) {
      if (chunk.type === 'entities') {
        yield {
          type: 'entities',
          data: chunk.data as StoredEntity[],
          sequence: chunk.sequence,
          isLast: chunk.isLast,
        };
      } else {
        yield {
          type: 'relationships',
          data: chunk.data as StoredRelationship[],
          sequence: chunk.sequence,
          isLast: chunk.isLast,
        };
      }
    }
  }

  /**
   * Export a repository to a complete in-memory archive.
   * Convenience wrapper around exportStream() — use for small repositories.
   * For large repositories, use exportStream() directly.
   */
  async export(repositoryId: string): Promise<ExportArchive> {
    let manifest: ExportManifest | undefined;
    let vocabulary: import('../types/vocabulary.js').MemoryVocabulary | undefined;
    const entities: StoredEntity[] = [];
    const relationships: StoredRelationship[] = [];

    for await (const item of this.exportStream(repositoryId)) {
      switch (item.type) {
        case 'manifest':
          manifest = item.data;
          break;
        case 'vocabulary':
          vocabulary = item.data;
          break;
        case 'entities':
          entities.push(...item.data);
          break;
        case 'relationships':
          relationships.push(...item.data);
          break;
      }
    }

    return {
      manifest: manifest!,
      vocabulary: vocabulary!,
      entities,
      relationships,
    };
  }
}
