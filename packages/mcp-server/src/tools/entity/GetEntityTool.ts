import { BaseToolController } from '../base/BaseToolController.js';
import { stripProvenance } from '../base/stripProvenance.js';
import type { DetailLevel } from '@utaba/deep-memory';

export class GetEntityTool extends BaseToolController {
  get name() { return 'memory_get_entity'; }
  get description() { return 'Retrieve a single entity by ID (GUID) or slug with configurable detail level (brief, summary, or full)'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entity' },
        entityId: { type: 'string', description: 'Entity ID (GUID) or slug (e.g. "person:john-smith")' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Level of detail (default: full)' },
      },
      required: ['repositoryId', 'entityId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const resolvedId = await this.resolveEntityId(repo, params['entityId'] as string);
    const detailLevel = (params['detailLevel'] as DetailLevel) ?? 'full';
    const entity = await repo.getEntity(resolvedId, detailLevel);
    if (!entity) {
      throw new Error(`Entity '${params['entityId'] as string}' not found`);
    }

    return detailLevel === 'full' ? stripProvenance(entity) : entity;
  }
}
