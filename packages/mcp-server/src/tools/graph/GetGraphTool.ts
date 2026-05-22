import { BaseToolController } from '../base/BaseToolController.js';
const PAGE_SIZE = 200;

export class GetGraphTool extends BaseToolController {
  get name() { return 'memory_get_graph'; }
  get description() { return 'Get the knowledge graph for a repository — entities, relationships, vocabulary, and stats. Returns up to 200 entities per page with a cursor for continuation. For large repositories, prefer memory_query_graph, memory_find_entities with filters and memory_explore_neighborhood for targeted exploration.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to get the graph for' },
        cursor: { type: 'string', description: 'Opaque cursor from a previous response to fetch the next page' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Detail level for returned entities (default: summary)' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string;
    const cursor = params['cursor'] as string | undefined;
    const repo = await this.context.getRepository(repositoryId);

    const offset = cursor ? parseInt(cursor.split(':')[1]!, 10) : 0;
    const detailLevel = params['detailLevel'] as 'brief' | 'summary' | 'full' | undefined;
    const result = await repo.getGraph({ limit: PAGE_SIZE, offset, detailLevel });

    // Always strip provenance from relationships
    result.relationships = result.relationships.map(
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      ({ provenance, ...rest }) => rest,
    ) as typeof result.relationships;

    return result;
  }
}
