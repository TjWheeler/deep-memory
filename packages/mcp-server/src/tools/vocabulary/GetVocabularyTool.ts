import { BaseToolController } from '../base/BaseToolController.js';

/** Strip createdAt/createdBy/modifiedAt/modifiedBy from a vocabulary type definition */
function stripVocabularyProvenance<T>(obj: T): Omit<T, 'createdAt' | 'createdBy' | 'modifiedAt' | 'modifiedBy'> {
  const { createdAt, createdBy, modifiedAt, modifiedBy, ...rest } = obj as Record<string, unknown>;
  return rest as Omit<T, 'createdAt' | 'createdBy' | 'modifiedAt' | 'modifiedBy'>;
}

export class GetVocabularyTool extends BaseToolController {
  get name() { return 'memory_get_vocabulary'; }
  get description() { return 'Get the vocabulary definition for a repository — shows available entity types, relationship types, and governance mode'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to get vocabulary for' },
        includeProvenance: { type: 'boolean', description: 'Include createdAt/createdBy/modifiedAt/modifiedBy on type definitions (default: false)' },
      },
      required: ['repositoryId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const result = await repo.getVocabulary();
    const includeProvenance = params['includeProvenance'] === true;

    if (!includeProvenance) {
      return {
        ...result,
        vocabulary: {
          ...result.vocabulary,
          entityTypes: result.vocabulary.entityTypes.map(stripVocabularyProvenance),
          relationshipTypes: result.vocabulary.relationshipTypes.map(stripVocabularyProvenance),
        },
      };
    }

    return result;
  }
}
