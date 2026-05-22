import type { VocabularyInput, GovernanceMode } from '@utaba/deep-memory';
import { BaseToolController } from '../base/BaseToolController.js';

export class CreateRepositoryTool extends BaseToolController {
  get name() { return 'memory_create_repository'; }
  get description() { return 'Create a new memory repository with an optional vocabulary definition and governance mode'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Unique identifier for the repository' },
        label: { type: 'string', description: 'Human-readable name' },
        description: { type: 'string', description: 'Purpose of this repository' },
        type: { type: 'string', description: 'Repository type (optional classifier)' },
        legal: { type: 'string', description: 'Legal or compliance notes for this repository' },
        owner: { type: 'string', description: 'Owner of the repository (person, team, or org)' },
        governanceMode: { type: 'string', enum: ['locked', 'managed', 'open'], description: 'Vocabulary governance mode (default: open)' },
        defaultSimilarityThreshold: { type: 'number', description: 'Default similarity threshold for semantic search (0.0-1.0, default: 0.5). Lower for local embedding models, higher for OpenAI.' },
        metadata: {
          type: 'object',
          description: 'Extensible metadata object. Embedding model info (embeddingModelId, embeddingDimensions) is auto-detected from the configured provider if omitted.',
        },
        vocabulary: {
          type: 'object',
          description: 'Initial vocabulary with entityTypes and relationshipTypes arrays',
          properties: {
            entityTypes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  description: { type: 'string' },
                  properties: { type: 'array', items: { type: 'object' } },
                },
                required: ['type', 'description'],
              },
            },
            relationshipTypes: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string' },
                  description: { type: 'string' },
                  allowedSourceTypes: { type: 'array', items: { type: 'string' } },
                  allowedTargetTypes: { type: 'array', items: { type: 'string' } },
                  bidirectional: { type: 'boolean' },
                  properties: { type: 'array', items: { type: 'object' } },
                },
                required: ['type', 'description', 'allowedSourceTypes', 'allowedTargetTypes'],
              },
            },
          },
        },
      },
      required: ['repositoryId', 'label'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const mode = (params['governanceMode'] as GovernanceMode | undefined) ?? 'open';
    const repo = await this.context.deepMemory.createRepository({
      repositoryId: params['repositoryId'] as string,
      label: params['label'] as string,
      description: params['description'] as string | undefined,
      type: params['type'] as string | undefined,
      legal: params['legal'] as string | undefined,
      owner: params['owner'] as string | undefined,
      vocabulary: params['vocabulary'] as VocabularyInput | undefined,
      governance: {
        mode,
        defaultSimilarityThreshold: params['defaultSimilarityThreshold'] as number | undefined,
      },
      metadata: params['metadata'] as import('@utaba/deep-memory').RepositoryMetadata | undefined,
    });
    return { repositoryId: repo.repositoryId, message: `Repository '${params['label']}' created` };
  }
}
