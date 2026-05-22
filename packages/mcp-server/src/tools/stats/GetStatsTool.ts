import { BaseToolController } from '../base/BaseToolController.js';

export class GetStatsTool extends BaseToolController {
  get name() { return 'memory_get_stats'; }
  get description() { return 'Get statistics for a repository — entity count, relationship count, type breakdowns'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to get stats for' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    return repo.getStats();
  }
}
