// RelationshipManager — CRUD orchestration for relationships with validation, provenance, and events

import type { StorageProvider } from '../providers/StorageProvider.js';
import type {
  CreateRelationshipInput,
  Relationship,
  RelationshipQueryOptions,
  RemoveRelationshipsResult,
  StoredRelationship,
} from '../types/relationships.js';
import type { PaginatedResult } from '../types/results.js';
import type { VocabularyEngine } from '../core/VocabularyEngine.js';
import type { ProvenanceTracker } from '../core/ProvenanceTracker.js';
import type { EventBus } from '../core/EventBus.js';
import { generateRelationshipId } from '../entities/IdGenerator.js';
import { toScreamingSnakeCase } from '../vocabulary/similarity.js';
import {
  EntityNotFoundError,
  VocabularyValidationError,
  OperationCancelledError,
  SelfReferentialRelationshipError,
  RepositoryNotFoundError,
} from '../core/errors.js';

export class RelationshipManager {
  constructor(
    private readonly repositoryId: string,
    private readonly vocabularyEngine: VocabularyEngine,
    private readonly provenanceTracker: ProvenanceTracker,
    private readonly eventBus: EventBus,
    private readonly storage: StorageProvider,
  ) {}

  /**
   * Create one or more relationships with vocabulary validation, provenance,
   * and events. A missing endpoint checks the repository first: a deleted
   * repository answers `RepositoryNotFoundError`, not a missing entity.
   */
  public async create(inputs: CreateRelationshipInput[]): Promise<Relationship[]> {
    const results: Relationship[] = [];

    for (const input of inputs) {
      if (input.sourceEntityId === input.targetEntityId) {
        throw new SelfReferentialRelationshipError(input.sourceEntityId, input.relationshipType);
      }

      // Resolve source and target entity types for constraint validation
      const sourceEntity = await this.storage.getEntity(this.repositoryId, input.sourceEntityId);
      if (!sourceEntity) {
        throw await this.endpointMissError(input.sourceEntityId);
      }

      const targetEntity = await this.storage.getEntity(this.repositoryId, input.targetEntityId);
      if (!targetEntity) {
        throw await this.endpointMissError(input.targetEntityId);
      }

      // Validate against vocabulary
      const validation = await this.vocabularyEngine.validateRelationship(
        input,
        sourceEntity.entityType,
        targetEntity.entityType,
      );
      if (!validation.valid) {
        await this.eventBus.emit('validation:failed', {
          operation: 'createRelationship',
          error: validation.errors.map((e) => e.message).join('; '),
          suggestions: validation.errors.filter((e) => e.suggestion).map((e) => e.suggestion!),
        });
        throw new VocabularyValidationError(validation.errors);
      }

      // Pre-mutation hook
      const hookResult = await this.eventBus.emitHook('relationship:creating', { input });
      if (hookResult.cancelled) {
        throw new OperationCancelledError(
          'Relationship creation', hookResult.reason ?? 'cancelled by hook',
        );
      }

      // Normalize relationship type to SCREAMING_SNAKE_CASE
      const normalizedType = toScreamingSnakeCase(input.relationshipType);

      // Get relationship type definition for bidirectional flag
      const vocabulary = await this.vocabularyEngine.getVocabulary();
      const relType = vocabulary.relationshipTypes.find((rt) => rt.type === normalizedType);
      const bidirectional = relType?.bidirectional ?? false;

      // Generate GUID (or use provided). The id and its origin come from one
      // branch: `idMinted` lets the provider skip checking the repository for
      // the id, so it is set only when this call generated the id. A missing
      // id (`undefined`, or `null` from an untyped caller) is minted; any
      // string the caller supplied, empty included, is checked.
      let id: string;
      let idMinted: boolean;
      if (typeof input.id === 'string') {
        id = input.id;
        idMinted = false;
      } else {
        id = generateRelationshipId();
        idMinted = true;
      }

      // Stamp provenance
      const provenance = this.provenanceTracker.stampCreate();

      // Build stored relationship
      const storedRelationship: StoredRelationship = {
        id,
        relationshipType: normalizedType,
        sourceEntityId: input.sourceEntityId,
        targetEntityId: input.targetEntityId,
        properties: input.properties ?? {},
        bidirectional,
        provenance,
      };

      // Persist
      const created = await this.storage.createRelationship(this.repositoryId, storedRelationship, { idMinted });

      // Map to public type
      const relationship = storedToRelationship(created);

      // Emit created event
      await this.eventBus.emit('relationship:created', { relationship });

      results.push(relationship);
    }

    return results;
  }

  /**
   * The error for an endpoint entity that was not found. Database-backed
   * stores answer an entity read on a deleted repository with no row, so the
   * miss reads the repository before blaming the entity.
   */
  private async endpointMissError(entityId: string): Promise<RepositoryNotFoundError | EntityNotFoundError> {
    if ((await this.storage.getRepository(this.repositoryId)) === null) {
      return new RepositoryNotFoundError(this.repositoryId);
    }
    return new EntityNotFoundError(entityId);
  }

  /** Remove one or more relationships in a single batch storage operation */
  async removeMany(ids: string[]): Promise<RemoveRelationshipsResult> {
    const hookResult = await this.eventBus.emitHook('relationship:removing', { ids });
    if (hookResult.cancelled) {
      throw new OperationCancelledError('Relationship removal', hookResult.reason ?? 'cancelled by hook');
    }

    const { deleted, notFound } = await this.storage.deleteRelationships(this.repositoryId, ids);

    if (deleted.length > 0) {
      await this.eventBus.emit('relationship:removed', { ids: deleted });
    }

    return {
      removed: deleted,
      failed: notFound.map((id) => ({ id, error: `Relationship '${id}' not found` })),
    };
  }

  /** Get relationships for an entity with filtering */
  async getForEntity(
    entityId: string,
    options?: RelationshipQueryOptions,
  ): Promise<PaginatedResult<Relationship>> {
    const result = await this.storage.getEntityRelationships(
      this.repositoryId,
      entityId,
      options,
    );

    return {
      items: result.items.map(storedToRelationship),
      total: result.total,
      hasMore: result.hasMore,
      limit: result.limit,
      offset: result.offset,
    };
  }
}

// ─── Mapping helpers ────────────────────────────────────────────────

function storedToRelationship(stored: StoredRelationship): Relationship {
  return {
    id: stored.id,
    relationshipType: stored.relationshipType,
    sourceEntityId: stored.sourceEntityId,
    targetEntityId: stored.targetEntityId,
    properties: stored.properties,
    bidirectional: stored.bidirectional,
    provenance: stored.provenance,
  };
}
