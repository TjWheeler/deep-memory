// RepositoryValidator — audits entities and relationships in a repository
// against the current vocabulary. Exposes two paged methods so MCP clients
// with limited context can drill in one window at a time.
//
// Paging is applied over *issues*. `offset` skips that many issues, `take`
// caps how many issues this page returns. The export stream is scanned from
// the start every call — callers typically loop at offset=0 after fixing,
// and `nextOffset` is only useful when inspecting a later slice without
// mutating. `scanned` reports items inspected, for diagnostics.

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { VocabularyEngine } from '../core/VocabularyEngine.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import type {
  EntityValidationPage,
  RelationshipValidationPage,
  EntityValidationIssue,
  RelationshipValidationIssue,
  ValidateEntitiesOptions,
  ValidateRelationshipsOptions,
} from '../types/results.js';
import {
  validateEntity,
  validateRelationship,
  type ValidationError,
} from '../vocabulary/VocabularyValidator.js';

interface EntityMapEntry {
  entityType: string;
  label: string;
  slug: string;
}

const DEFAULT_TAKE = 200;

export class RepositoryValidator {
  constructor(
    private readonly repositoryId: string,
    private readonly storage: StorageProvider,
    private readonly vocabularyEngine: VocabularyEngine,
  ) {}

  async validateEntities(options?: ValidateEntitiesOptions): Promise<EntityValidationPage> {
    const offset = options?.offset ?? 0;
    const take = options?.take ?? DEFAULT_TAKE;
    const delayMs = options?.delayBetweenChunksMs ?? 0;

    const vocabulary = await this.vocabularyEngine.getVocabulary();

    const issues: EntityValidationIssue[] = [];
    let scanned = 0;
    let skipped = 0;
    let stoppedEarly = false;

    for await (const chunk of this.storage.exportAll(this.repositoryId)) {
      if (chunk.type !== 'entities') {
        // Relationships phase — no further entities to scan.
        break;
      }

      const data = chunk.data as StoredEntity[];
      for (const entity of data) {
        scanned++;

        const result = validateEntity(
          {
            entityType: entity.entityType,
            label: entity.label,
            properties: entity.properties,
          },
          vocabulary,
        );
        if (!result.valid) {
          if (skipped < offset) {
            skipped++;
            continue;
          }
          issues.push({
            entityId: entity.id,
            slug: entity.slug,
            entityType: entity.entityType,
            label: entity.label,
            errors: result.errors,
          });
          if (issues.length >= take) {
            stoppedEarly = true;
            break;
          }
        }
      }

      if (stoppedEarly) break;

      if (delayMs > 0 && !chunk.isLast) {
        await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
      }
    }

    return {
      issues,
      scanned,
      nextOffset: offset + issues.length,
      done: !stoppedEarly,
    };
  }

  async validateRelationships(options?: ValidateRelationshipsOptions): Promise<RelationshipValidationPage> {
    const offset = options?.offset ?? 0;
    const take = options?.take ?? DEFAULT_TAKE;
    const delayMs = options?.delayBetweenChunksMs ?? 0;

    const vocabulary = await this.vocabularyEngine.getVocabulary();

    // Orphan checks and type-mismatch checks need every entity resolvable,
    // so the entity-map pass can't be paged.
    const entityMap = new Map<string, EntityMapEntry>();
    const issues: RelationshipValidationIssue[] = [];
    let scanned = 0;
    let skipped = 0;
    let stoppedEarly = false;

    for await (const chunk of this.storage.exportAll(this.repositoryId)) {
      if (chunk.type === 'entities') {
        for (const entity of chunk.data as StoredEntity[]) {
          entityMap.set(entity.id, {
            entityType: entity.entityType,
            label: entity.label,
            slug: entity.slug,
          });
        }

        if (delayMs > 0 && !chunk.isLast) {
          await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
        }
        continue;
      }

      const data = chunk.data as StoredRelationship[];
      for (const rel of data) {
        scanned++;

        const src = entityMap.get(rel.sourceEntityId);
        const tgt = entityMap.get(rel.targetEntityId);

        const errors: ValidationError[] = [];

        if (!src) {
          errors.push({
            field: 'sourceEntityId',
            message: `Source entity "${rel.sourceEntityId}" does not exist in this repository`,
          });
        }
        if (!tgt) {
          errors.push({
            field: 'targetEntityId',
            message: `Target entity "${rel.targetEntityId}" does not exist in this repository`,
          });
        }

        if (rel.sourceEntityId === rel.targetEntityId) {
          errors.push({
            field: 'targetEntityId',
            message: `Self-referential relationship: source and target are the same entity "${rel.sourceEntityId}"`,
            suggestion: 'Remove the relationship, or repoint it to a different entity.',
          });
        }

        // Only run full vocabulary validation when both endpoints exist —
        // otherwise type-based checks would pile noise on top of the orphan error.
        if (src && tgt) {
          const result = validateRelationship(
            {
              relationshipType: rel.relationshipType,
              sourceEntityId: rel.sourceEntityId,
              targetEntityId: rel.targetEntityId,
              properties: rel.properties,
            },
            vocabulary,
            src.entityType,
            tgt.entityType,
          );
          errors.push(...result.errors);
        }

        if (errors.length > 0) {
          if (skipped < offset) {
            skipped++;
            continue;
          }
          issues.push({
            relationshipId: rel.id,
            relationshipType: rel.relationshipType,
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            sourceLabel: src?.label,
            targetLabel: tgt?.label,
            sourceEntityType: src?.entityType,
            targetEntityType: tgt?.entityType,
            errors,
          });
          if (issues.length >= take) {
            stoppedEarly = true;
            break;
          }
        }
      }

      if (stoppedEarly) break;

      if (delayMs > 0 && !chunk.isLast) {
        await new Promise<void>((resolve) => { setTimeout(resolve, delayMs); });
      }
    }

    return {
      issues,
      scanned,
      nextOffset: offset + issues.length,
      done: !stoppedEarly,
      entitiesInMap: entityMap.size,
    };
  }
}
