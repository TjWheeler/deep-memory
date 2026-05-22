import { BaseToolController } from '../base/BaseToolController.js';
import { buildProvenanceFilter } from '../base/provenanceHelper.js';

export class GetTimelineTool extends BaseToolController {
  get name() { return 'memory_get_timeline'; }
  get description() { return 'Get the activity timeline for an entity — creation, updates, and relationship changes. Accepts entity ID (GUID) or slug.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entity' },
        entityId: { type: 'string', description: 'Entity ID (GUID) or slug' },
        from: { type: 'string', description: 'Start of time range (ISO 8601)' },
        to: { type: 'string', description: 'End of time range (ISO 8601)' },
        eventTypes: { type: 'array', items: { type: 'string' }, description: 'Filter by event types' },
        limit: { type: 'number', description: 'Max events (default 20, max 100)' },
        offset: { type: 'number', description: 'Pagination offset' },
        conversationId: { type: 'string', description: 'Filter to events from this conversation' },
        actor: { type: 'string', description: 'Filter to events by this actor' },
      },
      required: ['repositoryId', 'entityId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const resolvedId = await this.resolveEntityId(repo, params['entityId'] as string);
    const timeRange = params['from'] && params['to']
      ? { from: params['from'] as string, to: params['to'] as string }
      : undefined;
    const rawLimit = params['limit'] as number | undefined;
    const limit = Math.min(rawLimit ?? 20, 100);
    return repo.getTimeline(resolvedId, {
      timeRange,
      eventTypes: params['eventTypes'] as string[] | undefined,
      limit,
      offset: (params['offset'] as number | undefined) ?? 0,
      provenance: buildProvenanceFilter(params),
    });
  }
}
