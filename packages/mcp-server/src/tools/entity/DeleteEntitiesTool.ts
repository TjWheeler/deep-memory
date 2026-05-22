import { BaseToolController } from '../base/BaseToolController.js';

export class DeleteEntitiesTool extends BaseToolController {
  get name() { return 'memory_delete_entities'; }
  get description() { return 'Delete one or more entities and their associated relationships from the knowledge graph in a single batch operation. Accepts entity IDs (GUIDs) or slugs.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entities' },
        entityIds: {
          type: 'array',
          description: 'Entity IDs (GUIDs or slugs) to delete',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['repositoryId', 'entityIds'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const rawIds = params['entityIds'] as string[];
    const resolvedIds = await Promise.all(rawIds.map((id) => this.resolveEntityId(repo, id)));
    return repo.deleteEntities(resolvedIds);
  }
}
