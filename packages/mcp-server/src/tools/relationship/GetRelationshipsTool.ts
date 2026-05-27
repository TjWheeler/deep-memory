import { BaseToolController } from '../base/BaseToolController.js';
import { stripProvenanceArray } from '../base/stripProvenance.js';

export class GetRelationshipsTool extends BaseToolController {
  get name() { return 'memory_get_relationships'; }
  get description() { return 'Get all relationships for a given entity, with optional type and direction filters. Accepts entity ID (GUID) or slug.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entity' },
        entityId: { type: 'string', description: 'Entity ID (GUID) or slug' },
        relationshipTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by relationship type(s)' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'Direction filter relative to the queried entity (default: both)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
        offset: { type: 'number', description: 'Pagination offset (default 0)' },
        propertyFilters: { type: 'array', items: { type: 'object', properties: { key: { type: 'string' }, operator: { type: 'string', enum: ['eq', 'neq', 'isNull', 'isNotNull', 'gt', 'lt', 'gte', 'lte', 'contains'] }, value: {} }, required: ['key', 'operator'] }, description: 'Filter by relationship property values (AND)' },
      },
      required: ['repositoryId', 'entityId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const resolvedId = await this.resolveEntityId(repo, params['entityId'] as string);
    const rawLimit = params['limit'] as number | undefined;
    const limit = Math.min(rawLimit ?? 20, 100);
    const result = await repo.getRelationships(resolvedId, {
      relationshipTypes: params['relationshipTypes'] as string[] | undefined,
      direction: params['direction'] as 'out' | 'in' | 'both' | undefined,
      limit,
      offset: (params['offset'] as number | undefined) ?? 0,
      propertyFilters: params['propertyFilters'] as import('@utaba/deep-memory').PropertyFilter[] | undefined,
    });

    // Always strip provenance from relationships
    return { ...result, items: stripProvenanceArray(result.items) };
  }
}
