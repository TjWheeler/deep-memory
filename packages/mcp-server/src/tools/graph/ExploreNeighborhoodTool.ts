import { BaseToolController } from '../base/BaseToolController.js';
import { stripProvenance, stripProvenanceArray } from '../base/stripProvenance.js';

export class ExploreNeighborhoodTool extends BaseToolController {
  get name() { return 'memory_explore_neighborhood'; }
  get description() { return 'Explore the neighborhood of an entity using BFS traversal (depth 1-3). Accepts entity ID (GUID) or slug.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entity' },
        entityId: { type: 'string', description: 'Starting entity ID (GUID) or slug' },
        depth: { type: 'number', enum: [1, 2, 3], description: 'Exploration depth (default: 1)' },
        relationshipTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by relationship type(s)' },
        entityTypes: { type: 'array', items: { type: 'string' }, description: 'Filter result entity types' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Direction filter relative to the queried entity (default: both)' },
        limitPerType: { type: 'number', description: 'Max entities per relationship type (default 10, max 50)' },
        offsetPerType: { type: 'number', description: 'Pagination offset per relationship type (default 0)' },
        detailLevel: { type: 'string', enum: ['brief', 'summary', 'full'], description: 'Detail level for returned entities (default: summary)' },
        relationshipPropertyFilters: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'neq', 'isNull', 'isNotNull', 'gt', 'lt', 'gte', 'lte', 'contains'] }, value: {} }, required: ['key', 'operator'] }, description: 'Filter relationships by property values (AND)' },
      },
      required: ['repositoryId', 'entityId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const resolvedId = await this.resolveEntityId(repo, params['entityId'] as string);
    const rawLimitPerType = params['limitPerType'] as number | undefined;
    const limitPerType = Math.min(rawLimitPerType ?? 10, 50);
    const detailLevel = params['detailLevel'] as 'brief' | 'summary' | 'full' | undefined;
    const result = await repo.exploreNeighborhood(resolvedId, {
      depth: params['depth'] as 1 | 2 | 3 | undefined,
      relationshipTypes: params['relationshipTypes'] as string[] | undefined,
      entityTypes: params['entityTypes'] as string[] | undefined,
      direction: params['direction'] as 'out' | 'in' | 'both' | undefined,
      limitPerType,
      offsetPerType: (params['offsetPerType'] as number | undefined) ?? 0,
      detailLevel,
      relationshipPropertyFilters: params['relationshipPropertyFilters'] as import('@utaba/deep-memory').PropertyFilter[] | undefined,
    });

    if (detailLevel === 'full') {
      result.center = stripProvenance(result.center);
      for (const layer of result.layers) {
        for (const key of Object.keys(layer)) {
          const bucket = layer[key];
          if (bucket && typeof bucket === 'object' && 'entities' in bucket) {
            const b = bucket as { entities: Array<{ provenance?: unknown }> };
            b.entities = stripProvenanceArray(b.entities) as typeof b.entities;
          }
        }
      }
    }

    return result;
  }
}
