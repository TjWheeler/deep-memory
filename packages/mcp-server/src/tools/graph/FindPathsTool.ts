import { BaseToolController } from '../base/BaseToolController.js';
import { stripProvenance, stripProvenanceArray } from '../base/stripProvenance.js';

export class FindPathsTool extends BaseToolController {
  get name() { return 'memory_find_paths'; }
  get description() { return 'Find paths between two entities in the knowledge graph. Accepts entity IDs (GUID) or slugs.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entities' },
        sourceEntityId: { type: 'string', description: 'Starting entity ID (GUID) or slug' },
        targetEntityId: { type: 'string', description: 'Destination entity ID (GUID) or slug' },
        maxDepth: { type: 'number', description: 'Maximum path depth (default: 3, max: 5)' },
        relationshipTypes: { type: 'array', items: { type: 'string' }, description: 'Filter allowed relationship types' },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter entities in paths by type(s)' },
        limit: { type: 'number', description: 'Maximum number of paths to return (default: 5)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Detail level for returned entities (default: brief)' },
        relationshipPropertyFilters: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'neq', 'isNull', 'isNotNull', 'gt', 'lt', 'gte', 'lte', 'contains'] }, value: {} }, required: ['key', 'operator'] }, description: 'Filter relationships by property values (AND)' },
      },
      required: ['repositoryId', 'sourceEntityId', 'targetEntityId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const sourceId = await this.resolveEntityId(repo, params['sourceEntityId'] as string);
    const targetId = await this.resolveEntityId(repo, params['targetEntityId'] as string);
    const detailLevel = params['detailLevel'] as 'brief' | 'summary' | 'full' | undefined;
    const result = await repo.findPaths(sourceId, targetId, {
      maxDepth: params['maxDepth'] as number | undefined,
      relationshipTypes: params['relationshipTypes'] as string[] | undefined,
      entityTypes: params['entityTypes'] as string[] | undefined,
      limit: params['limit'] as number | undefined,
      offset: params['offset'] as number | undefined,
      detailLevel,
      relationshipPropertyFilters: params['relationshipPropertyFilters'] as import('@utaba/deep-memory').PropertyFilter[] | undefined,
    });

    // Always strip provenance from entities and relationships
    if (detailLevel === 'full') {
      for (const path of result.paths) {
        path.entities = stripProvenanceArray(path.entities);
        path.relationships = path.relationships.map(r => stripProvenance(r));
      }
    } else {
      // Relationships always have provenance regardless of detail level
      for (const path of result.paths) {
        path.relationships = path.relationships.map(r => stripProvenance(r));
      }
    }

    return result;
  }
}
