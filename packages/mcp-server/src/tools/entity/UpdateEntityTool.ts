import { BaseToolController } from '../base/BaseToolController.js';

export class UpdateEntityTool extends BaseToolController {
  get name() { return 'memory_update_entity'; }
  get description() { return 'Update an existing entity — entityType, label, summary, properties, or data. Accepts entity ID (GUID) or slug. Changing entityType must be valid in the vocabulary and regenerates the slug with the new type prefix. To clear an optional field, pass null: summary/data/dataFormat set to null are cleared, and property values set to null are removed from the entity (RFC 7396 JSON Merge Patch). Omitting a field leaves it unchanged.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        repositoryId: { type: 'string', description: 'Repository containing the entity' },
        entityId: { type: 'string', description: 'Entity ID (GUID) or slug' },
        entityType: { type: 'string', description: 'New entity type — must exist in the vocabulary. Regenerates the slug and re-validates properties against the new type.' },
        label: { type: 'string', description: 'New label' },
        summary: { type: ['string', 'null'], description: 'New summary. Pass null to clear the existing summary.' },
        properties: { type: 'object', description: 'Properties to merge with existing. Property values set to null are removed from the entity (RFC 7396 JSON Merge Patch semantics).' },
        data: { type: ['string', 'null'], description: 'New raw content/data. Pass null to clear.' },
        dataFormat: { type: ['string', 'null'], description: 'Format of the data field. Pass null to clear.' },
        reembed: { type: 'boolean', description: 'Force regeneration of the embedding vector (e.g. after switching embedding models)' },
      },
      required: ['repositoryId', 'entityId'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const repo = await this.context.getRepository(params['repositoryId'] as string);
    const resolvedId = await this.resolveEntityId(repo, params['entityId'] as string);
    // `null` is meaningful for summary/data/dataFormat (clear sentinel). Preserve it;
    // only drop fields that were omitted (undefined).
    const updates: Record<string, unknown> = {};
    if (params['entityType'] !== undefined) updates['entityType'] = params['entityType'];
    if (params['label'] !== undefined) updates['label'] = params['label'];
    if (params['summary'] !== undefined) updates['summary'] = params['summary'];
    if (params['properties'] !== undefined) updates['properties'] = params['properties'];
    if (params['data'] !== undefined) updates['data'] = params['data'];
    if (params['dataFormat'] !== undefined) updates['dataFormat'] = params['dataFormat'];
    if (params['reembed'] !== undefined) updates['reembed'] = params['reembed'];
    return repo.updateEntity(resolvedId, updates as Parameters<typeof repo.updateEntity>[1]);
  }
}
