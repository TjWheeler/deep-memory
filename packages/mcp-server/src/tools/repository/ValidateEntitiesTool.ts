import { BaseToolController } from '../base/BaseToolController.js';

export class ValidateEntitiesTool extends BaseToolController {
  get name() { return 'memory_validate_entities'; }
  get description() {
    return 'Audit entities in the repository against the current vocabulary. Paging is issue-based: `take` caps how many issues are returned, `offset` skips that many issues. Typical workflow: call with offset=0, fix the returned issues, call again with offset=0. `offset` is only for inspecting a later slice without mutating. Loop until `done` is true. Returns issues fixable with memory_update_entity. Use memory_validate_relationships for relationships.';
  }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to validate' },
        offset: { type: 'number', description: 'Number of issues to skip before returning (default 0). The normal fix-and-retry workflow always uses 0; pass nextOffset only to inspect a later slice without fixing.' },
        take: { type: 'number', description: 'Maximum issues to return in this call (default 200)' },
        delayBetweenChunksMs: { type: 'number', description: 'Pause between export chunks for manual rate limiting (default 0)' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    return repo.validateEntities({
      offset: params['offset'] as number | undefined,
      take: params['take'] as number | undefined,
      delayBetweenChunksMs: params['delayBetweenChunksMs'] as number | undefined,
    });
  }
}
