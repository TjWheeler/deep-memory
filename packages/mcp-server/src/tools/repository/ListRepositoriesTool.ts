import { BaseToolController } from '../base/BaseToolController.js';

export class ListRepositoriesTool extends BaseToolController {
  get name() { return 'memory_list_repositories'; }
  get description() { return 'List all available memory repositories'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by repository type' },
        limit: { type: 'number', description: 'Max results (default 20)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
      },
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const filter: Record<string, unknown> = {};
    if (params['type']) filter['type'] = params['type'] as string;
    filter['limit'] = (params['limit'] as number | undefined) ?? 20;
    filter['offset'] = (params['offset'] as number | undefined) ?? 0;
    return this.context.deepMemory.listRepositories(filter as Parameters<typeof this.context.deepMemory.listRepositories>[0]);
  }
}
