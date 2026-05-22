import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ExportLegalMetadata } from '@utaba/deep-memory';
import type { ILogger } from '../../interfaces/ILogger.js';
import { BaseToolController } from '../base/BaseToolController.js';
import type { ToolContext } from '../base/BaseToolController.js';
import { createZip, type ZipEntry } from './zip.js';

/** Maximum entities or relationships per chunk file */
const CHUNK_SIZE = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'repository'
  );
}

function formatDatetime(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

function toBuffer(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export class ExportRepositoryTool extends BaseToolController {
  constructor(
    context: ToolContext,
    logger: ILogger,
    private exportDir: string,
  ) {
    super(context, logger);
  }

  get name() {
    return 'memory_export_repository';
  }

  get description() {
    return (
      'Export a memory repository to a .dkg (Deep Knowledge Graph) file on the local filesystem. ' +
      'The archive contains manifest.json, vocabulary.json, and chunked ' +
      'entities/relationships files. Returns the path — no data is sent to the AI.'
    );
  }

  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: {
          type: 'string',
          description: 'UUID of the repository to export',
        },
        legal: {
          type: 'object',
          description: 'Optional legal/copyright metadata to embed in the archive manifest',
          properties: {
            copyright: {
              type: 'string',
              description: 'Copyright holder (e.g. "© 2026 Caterpillar Inc.")',
            },
            license: {
              type: 'string',
              description: 'SPDX license identifier or custom license name (e.g. "Apache-2.0", "LicenseRef-Proprietary")',
            },
            licenseUrl: {
              type: 'string',
              description: 'Full license text or URL pointing to license terms',
            },
            terms: {
              type: 'string',
              description: 'Human-readable usage terms or restrictions summary',
            },
            publisher: {
              type: 'string',
              description: 'Organization that published this archive',
            },
            contact: {
              type: 'string',
              description: 'Contact for licensing questions (e.g. email address)',
            },
          },
          required: ['copyright'],
        },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string;
    const legal = params['legal'] as ExportLegalMetadata | undefined;

    this.logger.info(this.name, `Exporting repository ${repositoryId}`);
    const startTime = Date.now();

    const exportOptions = legal ? { legal } : undefined;

    const entries: ZipEntry[] = [];
    let entityCount = 0;
    let relationshipCount = 0;
    let entityChunkNum = 0;
    let relationshipChunkNum = 0;
    let label = '';
    let vocabVersion = '';
    let exportedAt = '';

    for await (const item of this.context.deepMemory.exportRepositoryStream(repositoryId, exportOptions)) {
      switch (item.type) {
        case 'manifest':
          entries.push({ name: 'manifest.json', data: toBuffer(item.data) });
          label = item.data.repository.label;
          vocabVersion = item.data.repository.vocabularyVersion;
          exportedAt = item.data.exportedAt;
          break;

        case 'vocabulary':
          entries.push({ name: 'vocabulary.json', data: toBuffer(item.data) });
          break;

        case 'entities': {
          const allEntities = item.data;
          for (let i = 0; i < allEntities.length; i += CHUNK_SIZE) {
            const chunk = allEntities.slice(i, i + CHUNK_SIZE);
            entityChunkNum++;
            entries.push({
              name: `entities-${String(entityChunkNum).padStart(4, '0')}.json`,
              data: toBuffer(chunk),
            });
          }
          entityCount += allEntities.length;
          break;
        }

        case 'relationships': {
          const allRels = item.data;
          for (let i = 0; i < allRels.length; i += CHUNK_SIZE) {
            const chunk = allRels.slice(i, i + CHUNK_SIZE);
            relationshipChunkNum++;
            entries.push({
              name: `relationships-${String(relationshipChunkNum).padStart(4, '0')}.json`,
              data: toBuffer(chunk),
            });
          }
          relationshipCount += allRels.length;
          break;
        }
      }
    }

    const slug = slugify(label);
    const datetime = formatDatetime(new Date(exportedAt));
    const zipName = `${slug}-v${vocabVersion}-${datetime}.dkg`;

    const exportDir = resolve(this.exportDir);
    mkdirSync(exportDir, { recursive: true });

    const filePath = join(exportDir, zipName);
    const zipBuffer = createZip(entries);
    await writeFile(filePath, zipBuffer);

    const elapsedMs = Date.now() - startTime;
    const elapsedSec = (elapsedMs / 1000).toFixed(1);

    this.logger.info(this.name, `Exported to ${filePath} (${entries.length} files) in ${elapsedSec}s`);

    return {
      path: filePath,
      filename: zipName,
      repository: label,
      vocabularyVersion: vocabVersion,
      statistics: {
        entities: entityCount,
        relationships: relationshipCount,
        files: entries.length,
      },
      timing: {
        elapsedMs,
        elapsedFormatted: `${elapsedSec}s`,
      },
    };
  }
}
