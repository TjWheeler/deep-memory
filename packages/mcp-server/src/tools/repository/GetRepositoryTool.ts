import { BaseToolController } from '../base/BaseToolController.js';

export class GetRepositoryTool extends BaseToolController {
  get name() { return 'memory_get_repository'; }
  get description() { return 'Get the full stored record for a single repository — including legal, owner, metadata (embeddingModelId, embeddingDimensions), governance config, and creation provenance. Resolve by ID or label.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'ID of the repository' },
        label: { type: 'string', description: 'Repository label — use as alternative to repositoryId' },
      },
      required: [],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string | undefined;
    const label = params['label'] as string | undefined;

    if (!repositoryId && !label) {
      throw new Error('Provide either repositoryId or label');
    }

    let resolvedId: string;

    if (repositoryId) {
      resolvedId = repositoryId;
    } else {
      const allRepos = await this.context.deepMemory.listRepositories();
      const matches = allRepos.items.filter(
        (r) => r.label.toLowerCase() === label!.toLowerCase(),
      );

      if (matches.length === 0) {
        throw new Error(`No repository found with label '${label}'`);
      }
      if (matches.length > 1) {
        return {
          error: 'ambiguous_label',
          message: `Multiple repositories match label '${label}'. Provide a repositoryId.`,
          candidates: matches.map((r) => ({ repositoryId: r.repositoryId, label: r.label })),
        };
      }
      resolvedId = matches[0]!.repositoryId;
    }

    return this.context.deepMemory.getRepository(resolvedId);
  }
}
