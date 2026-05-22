import { BaseToolController } from '../base/BaseToolController.js';
import { buildProvenanceFilter } from '../base/provenanceHelper.js';
import { stripProvenanceArray } from '../base/stripProvenance.js';

export class FindEntitiesTool extends BaseToolController {
  get name() { return 'memory_find_entities'; }
  get description() { return 'Search for entities by label, type, or properties with pagination. Requires a repository to be opened first via memory_open_repository.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to search in' },
        searchTerm: { type: 'string', description: 'Search term to match against entity labels' },
        entityType: { type: 'string', description: 'Filter by a single entity type (convenience alias for entityTypes)' },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by entity type(s)' },
        properties: { type: 'object', description: 'Filter by property values' },
        limit: { type: 'number', description: 'Max results (default 10, max 50)' },
        offset: { type: 'number', description: 'Pagination offset' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Detail level for returned entities (default: summary)' },
        conversationId: { type: 'string', description: 'Filter to entities from this conversation' },
        actor: { type: 'string', description: 'Filter to entities created/modified by this actor' },
        dateRange: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, description: 'Filter by date range (ISO 8601)' },
        includeRelationshipSummary: { type: 'boolean', description: 'Attach a relationship count summary (outbound/inbound by type) to each entity (default false)' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    // Support both singular entityType and plural entityTypes
    let entityTypes = params['entityTypes'] as string[] | undefined;
    if (!entityTypes && params['entityType']) {
      entityTypes = [params['entityType'] as string];
    }

    let result = await repo.findEntities({
      searchTerm: params['searchTerm'] as string | undefined,
      entityTypes,
      properties: params['properties'] as Record<string, unknown> | undefined,
      limit: params['limit'] as number | undefined,
      offset: params['offset'] as number | undefined,
      detailLevel: params['detailLevel'] as 'brief' | 'summary' | 'full' | undefined,
      provenance: buildProvenanceFilter(params),
    });

    if ((params['detailLevel'] as string) === 'full') {
      result = { ...result, items: stripProvenanceArray(result.items) };
    }

    if (!params['includeRelationshipSummary']) {
      return result;
    }

    const itemsWithSummary = await Promise.all(
      result.items.map(async (entity) => {
        const relationshipSummary = await repo.getRelationshipSummary(entity.id);
        return { ...entity, relationshipSummary };
      }),
    );

    return { ...result, items: itemsWithSummary };
  }
}
