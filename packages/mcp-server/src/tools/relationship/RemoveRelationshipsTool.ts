import { BaseToolController } from '../base/BaseToolController.js';

export class RemoveRelationshipsTool extends BaseToolController {
  get name() { return 'memory_remove_relationships'; }
  get description() { return 'Remove one or more relationships (edges) from the knowledge graph in a single batch operation'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the relationships' },
        relationshipIds: {
          type: 'array',
          description: 'IDs of relationships to remove',
          items: { type: 'string' },
          minItems: 1,
        },
      },
      required: ['repositoryId', 'relationshipIds'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    return repo.removeRelationships(params['relationshipIds'] as string[]);
  }
}
