import type { VocabularyProposal } from '@utaba/deep-memory';
import { BaseToolController } from '../base/BaseToolController.js';

export class ProposeVocabularyExtensionTool extends BaseToolController {
  get name() { return 'memory_propose_vocabulary_extension'; }
  get description() { return 'Propose a new entity type or relationship type. Only needed when the vocabulary doesn\'t already include the type you need — check memory_open_repository response first.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository to modify' },
        proposalType: {
          type: 'string',
          enum: [
            'entity_type',
            'relationship_type',
            'edit_entity_type',
            'edit_relationship_type',
            'delete_entity_type',
            'delete_relationship_type',
          ],
          description: 'Type of vocabulary change',
        },
        entityType: {
          type: 'object',
          description: 'Entity type definition (when proposalType is entity_type)',
          properties: {
            type: { type: 'string', description: 'Type name' },
            description: { type: 'string', description: 'Type description' },
            properties: { type: 'array', items: { type: 'object' }, description: 'Property schema definitions' },
          },
          required: ['type', 'description'],
        },
        relationshipType: {
          type: 'object',
          description: 'Relationship type definition (when proposalType is relationship_type)',
          properties: {
            type: { type: 'string', description: 'Type name' },
            description: { type: 'string', description: 'Type description' },
            allowedSourceTypes: { type: 'array', items: { type: 'string' } },
            allowedTargetTypes: { type: 'array', items: { type: 'string' } },
            bidirectional: { type: 'boolean' },
            properties: { type: 'array', items: { type: 'object' }, description: 'Property schema definitions' },
          },
          required: ['type', 'description', 'allowedSourceTypes', 'allowedTargetTypes'],
        },
        editEntityType: {
          type: 'object',
          description: 'Edit an existing entity type (when proposalType is edit_entity_type)',
          properties: {
            type: { type: 'string', description: 'Name of the entity type to edit' },
            description: { type: 'string', description: 'New description (optional)' },
            addProperties: { type: 'array', items: { type: 'object' }, description: 'Properties to add' },
            removeProperties: { type: 'array', items: { type: 'string' }, description: 'Property names to remove' },
            updateProperties: { type: 'array', items: { type: 'object' }, description: 'Properties to update (matched by name)' },
          },
          required: ['type'],
        },
        editRelationshipType: {
          type: 'object',
          description: 'Edit an existing relationship type (when proposalType is edit_relationship_type)',
          properties: {
            type: { type: 'string', description: 'Name of the relationship type to edit' },
            description: { type: 'string', description: 'New description (optional)' },
            allowedSourceTypes: { type: 'array', items: { type: 'string' }, description: 'New allowed source types' },
            allowedTargetTypes: { type: 'array', items: { type: 'string' }, description: 'New allowed target types' },
            bidirectional: { type: 'boolean', description: 'New bidirectional flag' },
            addProperties: { type: 'array', items: { type: 'object' }, description: 'Properties to add' },
            removeProperties: { type: 'array', items: { type: 'string' }, description: 'Property names to remove' },
            updateProperties: { type: 'array', items: { type: 'object' }, description: 'Properties to update (matched by name)' },
          },
          required: ['type'],
        },
        deleteEntityType: {
          type: 'object',
          description: 'Delete an entity type and all its instances (when proposalType is delete_entity_type)',
          properties: {
            type: { type: 'string', description: 'Name of the entity type to delete' },
          },
          required: ['type'],
        },
        deleteRelationshipType: {
          type: 'object',
          description: 'Delete a relationship type and all its instances (when proposalType is delete_relationship_type)',
          properties: {
            type: { type: 'string', description: 'Name of the relationship type to delete' },
          },
          required: ['type'],
        },
        justification: { type: 'string', description: 'Why this vocabulary change is needed' },
      },
      required: ['repositoryId', 'proposalType'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);

    const proposal: VocabularyProposal = {
      proposalType: params['proposalType'] as VocabularyProposal['proposalType'],
      entityType: params['entityType'] as VocabularyProposal['entityType'],
      relationshipType: params['relationshipType'] as VocabularyProposal['relationshipType'],
      editEntityType: params['editEntityType'] as VocabularyProposal['editEntityType'],
      editRelationshipType: params['editRelationshipType'] as VocabularyProposal['editRelationshipType'],
      deleteEntityType: params['deleteEntityType'] as VocabularyProposal['deleteEntityType'],
      deleteRelationshipType: params['deleteRelationshipType'] as VocabularyProposal['deleteRelationshipType'],
      justification: (params['justification'] as string) ?? '',
    };

    return repo.proposeVocabularyChange(proposal);
  }
}
