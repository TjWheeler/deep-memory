import type { GovernanceMode } from '@utaba/deep-memory';
import { BaseToolController } from '../base/BaseToolController.js';

export class UpdateRepositoryTool extends BaseToolController {
  get name() { return 'memory_update_repository'; }
  get description() { return 'Update repository metadata and settings — label, description, governance mode, similarity threshold, etc.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to update' },
        label: { type: 'string', description: 'New label' },
        description: { type: 'string', description: 'New description' },
        type: { type: 'string', description: 'New repository type' },
        legal: { type: 'string', description: 'Legal terms, licence, or compliance notes' },
        owner: { type: 'string', description: 'New owner' },
        governanceMode: { type: 'string', enum: ['locked', 'managed', 'open'], description: 'New governance mode' },
        defaultSimilarityThreshold: { type: 'number', description: 'Default similarity threshold for semantic search (0.0-1.0). Model-dependent — lower for local models, higher for OpenAI.' },
        requireApproval: { type: 'boolean', description: 'Managed mode: if true, all vocabulary proposals queue for human approval' },
        deduplicationEnabled: { type: 'boolean', description: 'Open mode: whether vocabulary deduplication is enforced (default true)' },
        autoApproveThreshold: { type: 'number', description: 'Managed mode: similarity score below which vocabulary proposals auto-approve (default 0.3)' },
        metadata: { type: 'object', description: 'Metadata updates (shallow-merged with existing). E.g. { "embeddingModelId": "...", "embeddingDimensions": 4096 }' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repositoryId = params['repositoryId'] as string;

    // Build governance config update if any governance fields provided
    const governanceMode = params['governanceMode'] as GovernanceMode | undefined;
    const defaultSimilarityThreshold = params['defaultSimilarityThreshold'] as number | undefined;
    const requireApproval = params['requireApproval'] as boolean | undefined;
    const deduplicationEnabled = params['deduplicationEnabled'] as boolean | undefined;
    const autoApproveThreshold = params['autoApproveThreshold'] as number | undefined;

    const hasGovernanceUpdate = governanceMode !== undefined
      || defaultSimilarityThreshold !== undefined
      || requireApproval !== undefined
      || deduplicationEnabled !== undefined
      || autoApproveThreshold !== undefined;

    let governanceConfig: Record<string, unknown> | undefined;
    if (hasGovernanceUpdate) {
      // Fetch current governance to merge with
      const repo = await this.context.getRepository(repositoryId);
      const current = (await repo.getVocabulary()).governanceConfig;
      governanceConfig = {
        ...current,
        ...(governanceMode !== undefined ? { mode: governanceMode } : {}),
        ...(defaultSimilarityThreshold !== undefined ? { defaultSimilarityThreshold } : {}),
        ...(requireApproval !== undefined ? { requireApproval } : {}),
        ...(deduplicationEnabled !== undefined ? { deduplicationEnabled } : {}),
        ...(autoApproveThreshold !== undefined ? { autoApproveThreshold } : {}),
      };
    }

    const updated = await this.context.deepMemory.updateRepository(repositoryId, {
      label: params['label'] as string | undefined,
      description: params['description'] as string | undefined,
      type: params['type'] as string | undefined,
      legal: params['legal'] as string | undefined,
      owner: params['owner'] as string | undefined,
      governanceConfig: governanceConfig as import('@utaba/deep-memory').GovernanceConfig | undefined,
      metadata: params['metadata'] as import('@utaba/deep-memory').RepositoryMetadata | undefined,
    });

    // Evict cached repository so it reloads with new settings
    this.context.evictRepository(repositoryId);

    return { repositoryId: updated.repositoryId, message: `Repository '${updated.label}' updated` };
  }
}
