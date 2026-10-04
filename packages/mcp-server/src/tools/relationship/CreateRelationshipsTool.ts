import { BatchPartialFailureError } from '@utaba/deep-memory';
import { BaseToolController } from '../base/BaseToolController.js';
import { batchPartialFailureResponse } from '../base/batchPartialFailure.js';

interface RelationshipInput {
  relationshipType: string;
  sourceEntityId: string;
  targetEntityId: string;
  properties?: Record<string, unknown>;
}

export class CreateRelationshipsTool extends BaseToolController {
  get name() { return 'memory_create_relationships'; }
  get description() { return 'Create one or more relationships (edges) between entities. Relationship types must be in the vocabulary. Entity references accept either GUID or slug. Property names must match ^[A-Za-z_][A-Za-z0-9_]*$ and must not be reserved system fields. Every relationship (including its endpoints) is validated before any is written: if one fails validation, nothing is created. If storing fails part-way, the error response lists code BATCH_PARTIAL_FAILURE, failedIndex and the relationships already stored in "created"; resend only the relationships not in "created", because resending a stored relationship creates a duplicate.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entities' },
        relationships: {
          type: 'array',
          description: 'Array of relationships to create',
          items: {
            type: 'object',
            properties: {
              relationshipType: { type: 'string', description: 'Relationship type (must exist in vocabulary)' },
              sourceEntityId: { type: 'string', description: 'Source entity ID (GUID) or slug' },
              targetEntityId: { type: 'string', description: 'Target entity ID (GUID) or slug' },
              properties: { type: 'object', description: 'Typed properties per vocabulary schema' },
            },
            required: ['relationshipType', 'sourceEntityId', 'targetEntityId'],
          },
          minItems: 1,
        },
      },
      required: ['repositoryId', 'relationships'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const relationships = params['relationships'] as RelationshipInput[];

    // Resolve all entity IDs (supports both GUID and slug)
    const resolved = await Promise.all(
      relationships.map(async (r) => ({
        relationshipType: r.relationshipType,
        sourceEntityId: await this.resolveEntityId(repo, r.sourceEntityId),
        targetEntityId: await this.resolveEntityId(repo, r.targetEntityId),
        properties: r.properties,
      })),
    );

    try {
      return await repo.createRelationships(resolved);
    } catch (error: unknown) {
      if (!(error instanceof BatchPartialFailureError)) throw error;
      this.logger.error(this.name, `Execution failed: ${error.message}`);
      return batchPartialFailureResponse(error);
    }
  }
}
