import { readFile } from 'node:fs/promises';
import type {
  ExportManifest,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory';
import type {
  AdaptiveConcurrencyAdjustEvent,
  MemoryVocabulary,
} from '@utaba/deep-memory/types';
import { BaseToolController } from '../base/BaseToolController.js';
import { readZip } from './zip.js';

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ImportRepositoryTool extends BaseToolController {
  get name() {
    return 'memory_import_repository';
  }

  get description() {
    return (
      'Import a .dkg (Deep Knowledge Graph) archive. ' +
      'Also accepts legacy .zip archives. ' +
      'Mode "create" creates a new repository and uses fast bulk inserts (no existence checks). ' +
      'Mode "merge" (default) imports into an existing repository — entities with matching IDs are overwritten; new vocabulary types are added automatically. ' +
      'Supports both multi-file (manifest.json + chunks) and legacy single-file archives.'
    );
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: {
          type: 'string',
          description: 'UUID of the target repository to import into (merge) or for the new repository (create)',
        },
        path: {
          type: 'string',
          description: 'Absolute path to the .dkg or .zip archive to import',
        },
        mode: {
          type: 'string',
          enum: ['create', 'merge'],
          description: 'Import mode: "create" for a new repository (fast, no existence checks), "merge" to import into an existing repository (default: merge)',
        },
      },
      required: ['repositoryId', 'path'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string;
    const filePath = params['path'] as string;
    const mode = (params['mode'] as string) ?? 'merge';

    this.logger.info(this.name, `Importing ${filePath} into repository ${repositoryId} (mode: ${mode})`);
    const startTime = Date.now();

    const zipBuffer = await readFile(filePath);
    const files = readZip(zipBuffer);

    // Detect format: multi-file (has manifest.json) vs legacy single-file
    const manifestBuf = files.get('manifest.json');

    let manifest: ExportManifest;
    let vocabulary: MemoryVocabulary;
    const entities: StoredEntity[] = [];
    const relationships: StoredRelationship[] = [];

    if (manifestBuf) {
      // Multi-file format
      manifest = JSON.parse(manifestBuf.toString('utf8')) as ExportManifest;

      const vocabBuf = files.get('vocabulary.json');
      if (!vocabBuf) {
        throw new Error('Invalid archive: manifest.json present but vocabulary.json missing');
      }
      vocabulary = JSON.parse(vocabBuf.toString('utf8')) as MemoryVocabulary;

      // Collect entity and relationship chunks in sorted order
      const sortedNames = [...files.keys()].sort();
      for (const name of sortedNames) {
        if (name.startsWith('entities-') && name.endsWith('.json')) {
          const chunk = JSON.parse(files.get(name)!.toString('utf8')) as StoredEntity[];
          entities.push(...chunk);
        } else if (name.startsWith('relationships-') && name.endsWith('.json')) {
          const chunk = JSON.parse(files.get(name)!.toString('utf8')) as StoredRelationship[];
          relationships.push(...chunk);
        }
      }
    } else {
      // Legacy single-file format — first entry is the full archive JSON
      const firstEntry = files.values().next().value;
      if (!firstEntry) {
        throw new Error('Invalid archive: zip file is empty');
      }
      const legacy = JSON.parse(firstEntry.toString('utf8')) as {
        manifest: ExportManifest;
        vocabulary: MemoryVocabulary;
        entities: StoredEntity[];
        relationships: StoredRelationship[];
      };
      manifest = legacy.manifest;
      vocabulary = legacy.vocabulary;
      entities.push(...legacy.entities);
      relationships.push(...legacy.relationships);
    }

    const onAdjust = (event: AdaptiveConcurrencyAdjustEvent): void => {
      this.logger.info(
        this.name,
        `Adaptive concurrency ${event.reason}: ${event.previousConcurrency} -> ${event.concurrency} ` +
          `(tasks=${event.tasksCompleted}, throttled=${event.throttledCount})`,
      );
    };

    const importOptions = mode === 'create'
      ? {
          target: {
            mode: 'create' as const,
            repositoryId,
            config: {
              label: manifest.repository.label,
              type: manifest.repository.type,
              description: manifest.repository.description,
              governance: { mode: manifest.repository.governanceMode },
            },
          },
          bulk: {
            adaptiveConcurrency: { onAdjust },
          },
        }
      : {
          target: { mode: 'merge' as const, repositoryId },
          vocabularyConflict: 'extend' as const,
          entityConflict: 'overwrite' as const,
          bulk: {
            adaptiveConcurrency: { onAdjust },
          },
        };

    const result = await this.context.deepMemory.importRepository(
      { manifest, vocabulary, entities, relationships },
      importOptions,
    );

    const elapsedMs = Date.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    this.logger.info(
      this.name,
      `Import ${result.success ? 'succeeded' : 'failed'}: ` +
        `${result.statistics.entitiesImported} entities, ` +
        `${result.statistics.relationshipsImported} relationships ` +
        `in ${elapsedSec}s`,
    );

    return {
      success: result.success,
      repositoryId: result.repositoryId,
      statistics: result.statistics,
      warnings: result.warnings,
      timing: {
        elapsedMs,
        elapsedFormatted: `${elapsedSec}s`,
      },
    };
  }
}
