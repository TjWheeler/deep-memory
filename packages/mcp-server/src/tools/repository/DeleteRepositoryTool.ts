import { BaseToolController } from '../base/BaseToolController.js';

export class DeleteRepositoryTool extends BaseToolController {
  get name() { return 'memory_delete_repository'; }
  get description() { return 'Delete a memory repository and all its data permanently. Use deleteContentsOnly to remove all entities and relationships while keeping the repository and vocabulary intact.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'ID of the repository to delete' },
        deleteContentsOnly: { type: 'boolean', description: 'When true, only delete entities and relationships — the repository and vocabulary are preserved. Defaults to false.' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string;
    const deleteContentsOnly = params['deleteContentsOnly'] === true;

    if (deleteContentsOnly) {
      const result = await this.context.deepMemory.deleteAllContents(repositoryId);
      this.context.evictRepository(repositoryId);
      return {
        message: `Repository '${repositoryId}' contents deleted (${result.deletedEntities} entities, ${result.deletedRelationships} relationships removed). Repository and vocabulary preserved.`,
        deletedEntities: result.deletedEntities,
        deletedRelationships: result.deletedRelationships,
      };
    }

    await this.context.deepMemory.deleteRepository(repositoryId);
    this.context.evictRepository(repositoryId);
    return { message: `Repository '${repositoryId}' deleted` };
  }
}
