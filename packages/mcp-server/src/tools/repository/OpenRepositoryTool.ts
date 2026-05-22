import type { ResolvedVocabulary } from '@utaba/deep-memory';
import { BaseToolController } from '../base/BaseToolController.js';

export class OpenRepositoryTool extends BaseToolController {
  get name() { return 'memory_open_repository'; }
  get description() { return 'Open a memory repository by ID or label. Call this first before any entity, relationship, or graph operations. Returns vocabulary and stats.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'ID of the repository to open' },
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
      // Look up by label
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

    const repo = await this.context.getRepository(resolvedId);
    const [vocabulary, stats] = await Promise.all([
      repo.getVocabulary(),
      repo.getStats(),
    ]);

    return {
      repositoryId: repo.repositoryId,
      message: `Repository '${resolvedId}' opened`,
      vocabulary: OpenRepositoryTool.stripAuditFields(vocabulary),
      stats,
      agentInstructions: repo.getQueryGuide(),
    };
  }

  /** Strip audit/versioning fields from vocabulary to reduce response size for AI consumers */
  private static stripAuditFields(resolved: ResolvedVocabulary) {
    const { vocabulary, governanceMode, governanceConfig } = resolved;

    return {
      governanceMode,
      governanceConfig,
      entityTypes: vocabulary.entityTypes.map(({ type, description, properties }) => ({
        type,
        description,
        properties,
      })),
      relationshipTypes: vocabulary.relationshipTypes.map(({ type, description, allowedSourceTypes, allowedTargetTypes, bidirectional, properties }) => ({
        type,
        description,
        allowedSourceTypes,
        allowedTargetTypes,
        bidirectional,
        ...(properties?.length ? { properties } : {}),
      })),
    };
  }
}
