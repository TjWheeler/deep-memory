import { BatchPartialFailureError } from '@utaba/deep-memory';
import { BaseToolController } from '../base/BaseToolController.js';
import { batchPartialFailureResponse } from '../base/batchPartialFailure.js';

interface EntityInput {
  entityType: string;
  label: string;
  summary?: string;
  properties?: Record<string, unknown>;
  data?: string;
  dataFormat?: string;
}

export class CreateEntitiesTool extends BaseToolController {
  get name() { return 'memory_create_entities'; }
  get description() { return 'Create one or more entities (nodes) in a repository. Entity types and properties must match the repository vocabulary — call memory_open_repository first to see valid types. Property names must match ^[A-Za-z_][A-Za-z0-9_]*$ and must not be reserved system fields (label, slug, createdAt, ...). Every entity is validated before any is written: if one fails validation, nothing is created. If storing fails part-way, the error response lists code BATCH_PARTIAL_FAILURE, failedIndex and the entities already stored in "created"; resend only the entities not in "created", because resending a stored entity creates a duplicate.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to create the entities in' },
        entities: {
          type: 'array',
          description: 'Array of entities to create',
          items: {
            type: 'object',
            properties: {
              entityType: { type: 'string', description: 'Entity type (must exist in vocabulary)' },
              label: { type: 'string', description: 'Human-readable label' },
              summary: { type: 'string', description: 'Brief description of the entity' },
              properties: { type: 'object', description: 'Typed properties per vocabulary schema' },
              data: { type: 'string', description: 'Raw content/data for the entity' },
              dataFormat: { type: 'string', description: 'Format of the data field (e.g. text/plain, text/markdown)' },
            },
            required: ['entityType', 'label'],
          },
          minItems: 1,
        },
      },
      required: ['repositoryId', 'entities'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const entities = params['entities'] as EntityInput[];
    try {
      return await repo.createEntities(entities.map((e) => ({
        entityType: e.entityType,
        label: e.label,
        summary: e.summary,
        properties: e.properties,
        data: e.data,
        dataFormat: e.dataFormat,
      })));
    } catch (error: unknown) {
      if (!(error instanceof BatchPartialFailureError)) throw error;
      this.logger.error(this.name, `Execution failed: ${error.message}`);
      return batchPartialFailureResponse(error);
    }
  }
}
