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
import { toScreamingSnakeCase } from '../vocabulary/similarity.js';
import {
  validateEntity,
  validateEntityUpdate,
  validateRelationship,
  validatePropertySchema,
  validateNewTypeName,
  getEntityTypeDef,
  type ValidationResult,
} from '../vocabulary/VocabularyValidator.js';
import type { PropertyOwner } from '../validation/propertyNames.js';
import type { PropertySchema } from '../types/vocabulary.js';
import { VocabularyValidationError, type DeepMemoryErrorCode } from './errors.js';

const VOCABULARY_VERSION_CONFLICT: DeepMemoryErrorCode = 'VOCABULARY_VERSION_CONFLICT';

/**
 * True when `err` is a vocabulary compare-and-set conflict.
 *
 * Matches on the error code rather than `instanceof`: the conflict is thrown
 * by a storage provider, which may resolve its own copy of this package (a
 * duplicated install, or a bundled build), and an error from another copy is
 * not an instance of this copy's class.
 */
function isVocabularyVersionConflict(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === VOCABULARY_VERSION_CONFLICT;
}

/** A type name with case and surrounding whitespace removed from the comparison */
function foldTypeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * True when `vocabulary` declares a type of the kind a delete proposal names
 * that matches `typeName` ignoring case and surrounding whitespace, or, for a
 * relationship type, whose SCREAMING_SNAKE_CASE form is `typeName`.
 *
 * `typeName` is the name governance resolved the proposal to and found
 * undeclared. A store may compare type names more loosely than governance
 * does, so deleting data by such a near miss could delete a declared type's
 * data.
 */
function declaresNearMatch(
  proposal: VocabularyProposal,
  typeName: string,
  vocabulary: MemoryVocabulary,
): boolean {
  const folded = foldTypeName(typeName);
  if (proposal.proposalType === 'delete_entity_type') {
    return vocabulary.entityTypes.some((et) => foldTypeName(et.type) === folded);
  }
  return vocabulary.relationshipTypes.some(
    (rt) => foldTypeName(rt.type) === folded || toScreamingSnakeCase(rt.type) === typeName,
  );
}

/**
 * Maximum read → evaluate → compare-and-set cycles for one proposal.
 *
 * A conflict means another writer changed the vocabulary between this
 * engine's read and its write. Each retry re-runs deduplication, property
 * validation and governance against the vocabulary that actually won, so the
 * outcome is a fresh verdict rather than a blind re-apply. The bound keeps a
 * persistently contended vocabulary from looping forever; after the last
 * attempt the conflict is surfaced to the caller.
 */
const VOCABULARY_WRITE_ATTEMPTS = 3;

export interface VocabularyEngineConfig {
  repositoryId: string;
  storageProvider: StorageProvider;
  governanceConfig: GovernanceConfig;
  embeddingProvider?: EmbeddingProvider;
  /** Similarity threshold for deduplication (default 0.85) */
  deduplicationThreshold?: number;
  /**
   * Read the vocabulary with `{ fresh: true }`, bypassing the storage
   * provider's vocabulary cache, so validation sees another process's
   * vocabulary change as soon as it is stored. Off by default: reads go
   * through the provider cache, which bounds that staleness by its lifetime.
   */
  freshVocabulary?: boolean;
}

export class VocabularyEngine {
  private readonly repositoryId: string;
  private readonly storage: StorageProvider;
  private readonly governanceConfig: GovernanceConfig;
  private readonly deduplicator: SemanticDeduplicator;
  private readonly freshVocabulary: boolean;

  constructor(config: VocabularyEngineConfig) {
    this.repositoryId = config.repositoryId;
    this.storage = config.storageProvider;
    this.governanceConfig = config.governanceConfig;
    this.freshVocabulary = config.freshVocabulary ?? false;
    this.deduplicator = new SemanticDeduplicator({
      similarityThreshold: config.deduplicationThreshold,
      embeddingProvider: config.embeddingProvider,
    });
  }

  /** Get the governance configuration for this repository */
  public getGovernanceConfig(): GovernanceConfig {
    return this.governanceConfig;
  }

  /**
   * Read the vocabulary from storage. Every call reads through the storage
   * provider, so the engine holds no copy of its own that could outlive a
   * change another process (or another handle) made: staleness is bounded by
   * the provider's vocabulary cache, or removed with `freshVocabulary`. A
   * repository deleted since the handle was opened surfaces as the
   * provider's `RepositoryNotFoundError` on any read that goes to the store.
   */
  public async getVocabulary(): Promise<MemoryVocabulary> {
    return this.freshVocabulary
      ? this.storage.getVocabulary(this.repositoryId, { fresh: true })
      : this.storage.getVocabulary(this.repositoryId);
  }

  /** Get the resolved vocabulary with governance info */
  public async getResolvedVocabulary(): Promise<ResolvedVocabulary> {
    const vocabulary = await this.getVocabulary();
    return {
      vocabulary,
      governanceMode: this.governanceConfig.mode,
      governanceConfig: this.governanceConfig,
    };
  }

  /**
   * Validate an entity creation input against the vocabulary. Pass
   * `vocabulary` to validate against one already read (a batch validates all
   * of its members against a single read); otherwise the vocabulary is read.
   */
  public async validateEntity(
    input: CreateEntityInput,
    vocabulary?: MemoryVocabulary,
  ): Promise<ValidationResult> {
    return validateEntity(input, vocabulary ?? (await this.getVocabulary()));
  }

  /** Validate an entity update input against the vocabulary */
  public async validateEntityUpdate(
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

  /**
   * Validate a relationship creation input against the vocabulary. Pass
   * `vocabulary` to validate against one already read (a batch validates all
   * of its members against a single read); otherwise the vocabulary is read.
   */
  public async validateRelationship(
    input: CreateRelationshipInput,
    sourceEntityType: string,
    targetEntityType: string,
    vocabulary?: MemoryVocabulary,
  ): Promise<ValidationResult> {
    return validateRelationship(
      input,
      vocabulary ?? (await this.getVocabulary()),
      sourceEntityType,
      targetEntityType,
    );
  }

  /** Get an entity type definition from the vocabulary */
  public async getEntityTypeDef(entityType: string): Promise<EntityTypeDefinition | null> {
    const vocabulary = await this.getVocabulary();
    return getEntityTypeDef(entityType, vocabulary);
  }

  /**
   * Propose a vocabulary change (add, edit, or delete).
   * Runs deduplication for add proposals, then governance rules.
   * For delete proposals, cascades data deletion if approved. A delete
   * proposal for a type the vocabulary no longer declares re-runs the data
   * deletion, so resending a deletion whose data step failed completes it
   * (see `resumeTypeDeletion`).
   *
   * The write is compare-and-set against the version that was read. When a
   * concurrent writer changed the vocabulary in between, the whole proposal is
   * re-evaluated against the vocabulary that won, up to
   * `VOCABULARY_WRITE_ATTEMPTS` times. If every attempt conflicts, the
   * `VocabularyVersionConflictError` propagates to the caller.
   */
  public async proposeChange(
    proposal: VocabularyProposal,
    proposedBy: string,
  ): Promise<VocabularyProposalResult> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.attemptProposal(proposal, proposedBy);
      } catch (err) {
        if (!isVocabularyVersionConflict(err) || attempt >= VOCABULARY_WRITE_ATTEMPTS) {
          throw err;
        }
      }
    }
  }

  /**
   * One read → evaluate → compare-and-set write cycle for a proposal.
   *
   * Reads the stored vocabulary fresh (bypassing any provider cache) so the version passed to `saveVocabulary` is the one
   * actually stored, not a copy another process may have superseded.
   */
  private async attemptProposal(
    proposal: VocabularyProposal,
    proposedBy: string,
  ): Promise<VocabularyProposalResult> {
    const vocabulary = await this.storage.getVocabulary(this.repositoryId, { fresh: true });

    // Refuse unusable names and invalid property schemas before deduplication,
    // which may call the embedding provider.
    const declarationErrors = this.validateProposalDeclarations(proposal);
    if (declarationErrors) {
      return declarationErrors;
    }

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

    // Process through governance
    const { result, updatedVocabulary, changeRecord, typeAbsent } = processProposal(
      vocabulary,
      proposal,
      this.governanceConfig,
      { duplicates, proposedBy },
    );

    if (typeAbsent) {
      return this.resumeTypeDeletion(proposal, result, vocabulary);
    }

    // Persist if approved
    if (result.status === 'approved' && updatedVocabulary) {
      // Compare-and-set only detects a concurrent writer if every successful
      // write moves the version. Writing the same version would let a second
      // writer that read the old vocabulary still match, and overwrite this one.
      if (updatedVocabulary.version === vocabulary.version) {
        throw new VocabularyValidationError([
          {
            field: 'version',
            message: `Approved vocabulary change did not advance the version (still "${vocabulary.version}")`,
            suggestion: 'Every vocabulary write must produce a new version; this indicates a defect in the governance step.',
          },
        ]);
      }
      await this.storage.saveVocabulary(
        this.repositoryId,
        updatedVocabulary,
        vocabulary.version,
        changeRecord,
      );

      // Delete proposals cascade only after the vocabulary write has landed.
      // The vocabulary is the source of truth: data left behind under a type
      // that no longer exists is detectable and can be deleted again, whereas
      // data deleted for a type whose removal then failed to persist (e.g. a
      // version conflict) is lost while the type remains in the vocabulary.
      const isDeleteProposal =
        proposal.proposalType === 'delete_entity_type' ||
        proposal.proposalType === 'delete_relationship_type';

      if (isDeleteProposal) {
        await this.cascadeDeleteData(proposal, result.type);
      }
    }

    return result;
  }

  /** @deprecated Use proposeChange instead */
  public async proposeExtension(
    proposal: VocabularyProposal,
    proposedBy: string,
  ): Promise<VocabularyProposalResult> {
    return this.proposeChange(proposal, proposedBy);
  }

  /**
   * Finish deleting a type the stored vocabulary no longer declares.
   *
   * A type deletion stores the vocabulary first and deletes the type's data
   * afterwards, so when the data step fails (a server timeout, a lost
   * connection) the type is gone from the vocabulary but its data remains.
   * Resending the proposal lands here: the data step runs again, against the
   * vocabulary as it is. When it removed something, the deletion is complete
   * and the proposal answers `approved` with the vocabulary's version as read
   * after the data step; the vocabulary is not written again, so this call
   * does not move the version and makes no second change-log record (the
   * record was stored with the vocabulary change itself). When nothing was
   * left, the type never existed or its deletion already finished, and
   * governance's "not found" rejection stands.
   *
   * The governance check is exact, but a store may match type names more
   * loosely (SQL Server's default collation ignores case and trailing
   * spaces). A requested name that differs from a still-declared type only
   * by case or surrounding whitespace (or, for a relationship type, by its
   * SCREAMING_SNAKE_CASE form) is answered "not found" without the data
   * step, so a near-miss name can never delete the data of a type the
   * vocabulary still declares.
   *
   * The data step runs against the vocabulary read for this attempt. A
   * concurrent proposal that re-adds the type before the data step runs has
   * its new data deleted with the old: the same window the normal path has
   * between its vocabulary write and its data step.
   */
  private async resumeTypeDeletion(
    proposal: VocabularyProposal,
    notFound: VocabularyProposalResult,
    vocabulary: MemoryVocabulary,
  ): Promise<VocabularyProposalResult> {
    if (declaresNearMatch(proposal, notFound.type, vocabulary)) {
      return notFound;
    }
    const { deletedEntities, deletedRelationships } = await this.cascadeDeleteData(
      proposal,
      notFound.type,
    );
    // An entity type's deletion is measured by its entities: the edges it
    // removes only go with them, and a provider may not count those edges.
    const removed =
      proposal.proposalType === 'delete_entity_type' ? deletedEntities : (deletedRelationships ?? 0);
    if (removed === 0) {
      return notFound;
    }
    const current = await this.storage.getVocabulary(this.repositoryId, { fresh: true });
    return { status: 'approved', type: notFound.type, vocabularyVersion: current.version };
  }

  /**
   * Cascade-delete all data for a deleted vocabulary type.
   *
   * `typeName` is the name governance resolved the proposal to (a
   * relationship type normalised to SCREAMING_SNAKE_CASE), which is the name
   * the data is stored under, rather than the name as proposed.
   *
   * `deletedRelationships` may be `undefined` when the underlying provider
   * does not count cascaded edges (see StorageProvider.deleteEntitiesByType).
   */
  private async cascadeDeleteData(
    proposal: VocabularyProposal,
    typeName: string,
  ): Promise<{ deletedEntities: number; deletedRelationships: number | undefined }> {
    if (proposal.proposalType === 'delete_entity_type') {
      return this.storage.deleteEntitiesByType(this.repositoryId, typeName);
    }

    if (proposal.proposalType === 'delete_relationship_type') {
      const result = await this.storage.deleteRelationshipsByType(this.repositoryId, typeName);
      return { deletedEntities: 0, deletedRelationships: result.deletedRelationships };
    }

    return { deletedEntities: 0, deletedRelationships: 0 };
  }

  /**
   * Validate the names and property schemas a proposal declares: a new
   * type's name, and every declared property's name and flags. Returns a
   * rejected result on the first failure, or undefined if all pass. These
   * rules hold on every storage provider, so a vocabulary can never declare
   * a name that some provider could not write.
   */
  private validateProposalDeclarations(proposal: VocabularyProposal): VocabularyProposalResult | undefined {
    const schemas: PropertySchema[] = [];
    let typeName = '';
    let owner: PropertyOwner = 'entity';
    let newTypeName: ValidationResult | undefined;

    if (proposal.proposalType === 'entity_type' && proposal.entityType) {
      schemas.push(...(proposal.entityType.properties ?? []));
      typeName = proposal.entityType.type;
      newTypeName = validateNewTypeName(typeName, 'entity');
    } else if (proposal.proposalType === 'relationship_type' && proposal.relationshipType) {
      schemas.push(...(proposal.relationshipType.properties ?? []));
      typeName = proposal.relationshipType.type;
      owner = 'relationship';
      newTypeName = validateNewTypeName(typeName, 'relationship');
    } else if (proposal.proposalType === 'edit_entity_type' && proposal.editEntityType) {
      schemas.push(...(proposal.editEntityType.addProperties ?? []));
      schemas.push(...(proposal.editEntityType.updateProperties ?? []));
      typeName = proposal.editEntityType.type;
    } else if (proposal.proposalType === 'edit_relationship_type' && proposal.editRelationshipType) {
      schemas.push(...(proposal.editRelationshipType.addProperties ?? []));
      schemas.push(...(proposal.editRelationshipType.updateProperties ?? []));
      typeName = proposal.editRelationshipType.type;
      owner = 'relationship';
    }

    const results = [
      ...(newTypeName ? [newTypeName] : []),
      ...schemas.map((schema) => validatePropertySchema(schema, owner)),
    ];
    for (const result of results) {
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
