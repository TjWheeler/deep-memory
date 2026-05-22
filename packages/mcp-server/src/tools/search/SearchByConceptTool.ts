import { BaseToolController } from '../base/BaseToolController.js';

export class SearchByConceptTool extends BaseToolController {
  get name() { return 'memory_search_by_concept'; }
  get description() { return 'Semantic search for entities by concept similarity (requires an EmbeddingProvider)'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to search in' },
        query: { type: 'string', description: 'Natural language search query' },
        similarityThreshold: { type: 'number', description: 'Minimum similarity score 0.0-1.0 (default: 0.7)' },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by entity type(s)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
        offset: { type: 'number', description: 'Pagination offset' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Detail level for returned entities (default: summary)' },
      },
      required: ['repositoryId', 'query'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    return repo.searchByConcept(params['query'] as string, {
      similarityThreshold: params['similarityThreshold'] as number | undefined,
      entityTypes: params['entityTypes'] as string[] | undefined,
      limit: params['limit'] as number | undefined,
      offset: params['offset'] as number | undefined,
      detailLevel: params['detailLevel'] as 'brief' | 'summary' | 'full' | undefined,
    });
  }
}
