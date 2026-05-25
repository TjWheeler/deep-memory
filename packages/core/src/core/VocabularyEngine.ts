// VocabularyEngine — orchestrates vocabulary validation, governance, and deduplication

import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';
import type { StorageProvider } from '../providers/StorageProvider.js';
import type { CreateEntityInput, UpdateEntityInput } from '../types/entities.js';
import type { CreateRelationshipInput } from '../types/relationships.js';
import type {
  GovernanceConfig,
  MemoryVocabulary,
  VocabularyProposal,
  VocabularyProposalResult,
  ResolvedVocabulary,
  EntityTypeDefinition,
} from '../types/vocabulary.js';
import {
  SemanticDeduplicator,
  type ExistingType,
} from '../vocabulary/SemanticDeduplicator.js';
import {
  processProposal,
} from '../vocabulary/VocabularyGovernor.js';
import {
  validateEntity,
  validateEntityUpdate,
  validateRelationship,
  validatePropertySchema,
  getEntityTypeDef,
  type ValidationResult,
} from '../vocabulary/VocabularyValidator.js';
import type { PropertySchema } from '../types/vocabulary.js';

export interface VocabularyEngineConfig {
  repositoryId: string;
  storageProvider: StorageProvider;
  governanceConfig: GovernanceConfig;
  embeddingProvider?: EmbeddingProvider;
  /** Similarity threshold for deduplication (default 0.85) */
  deduplicationThreshold?: number;
}

export class VocabularyEngine {
  private readonly repositoryId: string;
  private readonly storage: StorageProvider;
  private readonly governanceConfig: GovernanceConfig;
  private readonly deduplicator: SemanticDeduplicator;

  /** Cached vocabulary — invalidated on mutation */
  private cachedVocabulary: MemoryVocabulary | null = null;

  constructor(config: VocabularyEngineConfig) {
    this.repositoryId = config.repositoryId;
    this.storage = config.storageProvider;
    this.governanceConfig = config.governanceConfig;
    this.deduplicator = new SemanticDeduplicator({
      similarityThreshold: config.deduplicationThreshold,
      embeddingProvider: config.embeddingProvider,
    });
  }

  /** Get the governance configuration for this repository */
  getGovernanceConfig(): GovernanceConfig {
    return this.governanceConfig;
  }

  /** Get the current vocabulary from storage (cached) */
  async getVocabulary(): Promise<MemoryVocabulary> {
    if (!this.cachedVocabulary) {
      this.cachedVocabulary = await this.storage.getVocabulary(this.repositoryId);
    }
    return this.cachedVocabulary;
  }

  /** Get the resolved vocabulary with governance info */
  async getResolvedVocabulary(): Promise<ResolvedVocabulary> {
    const vocabulary = await this.getVocabulary();
    return {
      vocabulary,
      governanceMode: this.governanceConfig.mode,
      governanceConfig: this.governanceConfig,
    };
  }

  /** Invalidate the cached vocabulary (call after external mutations) */
  invalidateCache(): void {
    this.cachedVocabulary = null;
  }

  /** Validate an entity creation input against the vocabulary */
  async validateEntity(input: CreateEntityInput): Promise<ValidationResult> {
    const vocabulary = await this.getVocabulary();
    return validateEntity(input, vocabulary);
  }

  /** Validate an entity update input against the vocabulary */
  async validateEntityUpdate(
    input: UpdateEntityInput,
    entityType: string,
  ): Promise<ValidationResult> {
    const vocabulary = await this.getVocabulary();
    const typeDef = getEntityTypeDef(entityType, vocabulary);
    if (!typeDef) {
      return {
        valid: false,
        errors: [
          {
            field: 'entityType',
            message: `Entity type "${entityType}" does not exist in the vocabulary`,
          },
        ],
      };
    }
    return validateEntityUpdate(input, typeDef, vocabulary);
  }

  /** Validate a relationship creation input against the vocabulary */
  async validateRelationship(
    input: CreateRelationshipInput,
    sourceEntityType: string,
    targetEntityType: string,
  ): Promise<ValidationResult> {
    const vocabulary = await this.getVocabulary();
    return validateRelationship(input, vocabulary, sourceEntityType, targetEntityType);
  }

  /** Get an entity type definition from the vocabulary */
  async getEntityTypeDef(entityType: string): Promise<EntityTypeDefinition | null> {
    const vocabulary = await this.getVocabulary();
    return getEntityTypeDef(entityType, vocabulary);
  }

  /**
   * Propose a vocabulary change (add, edit, or delete).
   * Runs deduplication for add proposals, then governance rules.
   * For delete proposals, cascades data deletion if approved.
   */
  async proposeChange(
    proposal: VocabularyProposal,
    proposedBy: string,
  ): Promise<VocabularyProposalResult> {
    const vocabulary = await this.getVocabulary();

    // Only run deduplication for add proposals
    const isAddProposal =
      proposal.proposalType === 'entity_type' || proposal.proposalType === 'relationship_type';

    let duplicates: Array<{ type: string; description: string; similarity: number }> | undefined;

    if (isAddProposal) {
      const existingTypes = this.getExistingTypesForProposal(proposal, vocabulary);
      const proposedTypeName = this.getProposedTypeName(proposal);
      const proposedDescription = this.getProposedDescription(proposal);

      const skipDedup =
        this.governanceConfig.mode === 'open' &&
        this.governanceConfig.deduplicationEnabled === false;

      if (!skipDedup) {
        const dedupResult = await this.deduplicator.checkDuplicate(
          proposedTypeName,
          proposedDescription,
          existingTypes,
        );
        if (dedupResult.isDuplicate) {
          duplicates = dedupResult.matches;
        }
      }
    }

    // Validate property schemas in the proposal (e.g. embeddable only allowed on string)
    const propertySchemaErrors = this.validateProposalPropertySchemas(proposal);
    if (propertySchemaErrors) {
      return propertySchemaErrors;
    }

    // Process through governance
    const { result, updatedVocabulary } = processProposal(
      vocabulary,
      proposal,
      this.governanceConfig,
      { duplicates, proposedBy },
    );

    // Persist if approved
    if (result.status === 'approved' && updatedVocabulary) {
      // For delete proposals, cascade-delete data before updating vocabulary
      const isDeleteProposal =
        proposal.proposalType === 'delete_entity_type' ||
        proposal.proposalType === 'delete_relationship_type';

      if (isDeleteProposal) {
        await this.cascadeDeleteData(proposal);
      }

      await this.storage.saveVocabulary(this.repositoryId, updatedVocabulary);
      this.cachedVocabulary = updatedVocabulary;
    }

    return result;
  }

  /** @deprecated Use proposeChange instead */
  async proposeExtension(
    proposal: VocabularyProposal,
    proposedBy: string,
  ): Promise<VocabularyProposalResult> {
    return this.proposeChange(proposal, proposedBy);
  }

  /**
   * Cascade-delete all data for a deleted vocabulary type.
   *
   * `deletedRelationships` may be `undefined` when the underlying provider
   * does not count cascaded edges (see StorageProvider.deleteEntitiesByType).
   * The return value is currently discarded by the only caller; the type is
   * preserved for symmetry with the storage contract.
   */
  private async cascadeDeleteData(
    proposal: VocabularyProposal,
  ): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
    if (proposal.proposalType === 'delete_entity_type' && proposal.deleteEntityType) {
      return this.storage.deleteEntitiesByType(
        this.repositoryId,
        proposal.deleteEntityType.type,
      );
    }

    if (proposal.proposalType === 'delete_relationship_type' && proposal.deleteRelationshipType) {
      const result = await this.storage.deleteRelationshipsByType(
        this.repositoryId,
        proposal.deleteRelationshipType.type,
      );
      return { deletedEntities: 0, deletedRelationships: result.deletedRelationships };
    }

    return { deletedEntities: 0, deletedRelationships: 0 };
  }

  /** Validate all property schemas in a proposal — returns a rejected result on the first invalid schema, or undefined if all pass */
  private validateProposalPropertySchemas(proposal: VocabularyProposal): VocabularyProposalResult | undefined {
    const schemas: PropertySchema[] = [];
    let typeName = '';

    if (proposal.proposalType === 'entity_type' && proposal.entityType) {
      schemas.push(...(proposal.entityType.properties ?? []));
      typeName = proposal.entityType.type;
    } else if (proposal.proposalType === 'relationship_type' && proposal.relationshipType) {
      schemas.push(...(proposal.relationshipType.properties ?? []));
      typeName = proposal.relationshipType.type;
    } else if (proposal.proposalType === 'edit_entity_type' && proposal.editEntityType) {
      schemas.push(...(proposal.editEntityType.addProperties ?? []));
      schemas.push(...(proposal.editEntityType.updateProperties ?? []));
      typeName = proposal.editEntityType.type;
    } else if (proposal.proposalType === 'edit_relationship_type' && proposal.editRelationshipType) {
      schemas.push(...(proposal.editRelationshipType.addProperties ?? []));
      schemas.push(...(proposal.editRelationshipType.updateProperties ?? []));
      typeName = proposal.editRelationshipType.type;
    }

    for (const schema of schemas) {
      const result = validatePropertySchema(schema);
      if (!result.valid) {
        return {
          status: 'rejected',
          type: typeName,
          reason: result.errors.map((e) => e.message).join('; '),
        };
      }
    }

    return undefined;
  }

  private getExistingTypesForProposal(
    proposal: VocabularyProposal,
    vocabulary: MemoryVocabulary,
  ): ExistingType[] {
    if (proposal.proposalType === 'entity_type') {
      return vocabulary.entityTypes.map((et) => ({
        type: et.type,
        description: et.description,
      }));
    }
    return vocabulary.relationshipTypes.map((rt) => ({
      type: rt.type,
      description: rt.description,
    }));
  }

  private getProposedTypeName(proposal: VocabularyProposal): string {
    if (proposal.proposalType === 'entity_type') {
      return proposal.entityType?.type ?? '';
    }
    return proposal.relationshipType?.type ?? '';
  }

  private getProposedDescription(proposal: VocabularyProposal): string {
    if (proposal.proposalType === 'entity_type') {
      return proposal.entityType?.description ?? '';
    }
    return proposal.relationshipType?.description ?? '';
  }
}
