// MigrationEngine — handles vocabulary differences between source and target repositories

import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { ImportWarning } from '../types/portability.js';
import {
  diffVocabularies,
  type VocabularyChange,
} from '../vocabulary/VocabularyDiff.js';
import {
  createEntityTypeDefinition,
  createRelationshipTypeDefinition,
  incrementVersion,
} from '../vocabulary/VocabularySchema.js';

/** How to handle vocabulary conflicts */
export type VocabularyConflictMode = 'reject' | 'extend' | 'prompt';

export interface MigrationResult {
  /** Whether migration succeeded */
  success: boolean;
  /** The merged vocabulary (only if success) */
  mergedVocabulary?: MemoryVocabulary;
  /** Warnings generated during migration */
  warnings: ImportWarning[];
  /** Rejection reason (only if success === false) */
  reason?: string;
}

export class MigrationEngine {
  /**
   * Analyze and migrate vocabulary differences between source and target.
   *
   * @param sourceVocabulary - vocabulary from the export archive
   * @param targetVocabulary - vocabulary in the target repository
   * @param conflictMode - how to handle differences
   * @param migratedBy - actor performing the migration
   */
  migrate(
    sourceVocabulary: MemoryVocabulary,
    targetVocabulary: MemoryVocabulary,
    conflictMode: VocabularyConflictMode,
    migratedBy: string,
  ): MigrationResult {
    const diff = diffVocabularies(targetVocabulary, sourceVocabulary);

    // No changes needed
    if (!diff.hasChanges) {
      return { success: true, mergedVocabulary: targetVocabulary, warnings: [] };
    }

    const warnings: ImportWarning[] = [];

    switch (conflictMode) {
      case 'reject':
        return {
          success: false,
          warnings: [],
          reason: `Vocabulary mismatch: ${diff.changes.length} difference(s) found. ` +
            `Changes: ${diff.changes.map(describeChange).join('; ')}`,
        };

      case 'prompt':
        return {
          success: false,
          warnings: diff.changes.map((c) => ({
            code: 'vocabulary_mismatch',
            message: describeChange(c),
          })),
          reason: 'Vocabulary differences require manual resolution',
        };

      case 'extend': {
        // Merge: add new types from source, warn about conflicts
        const merged = this.extendVocabulary(
          sourceVocabulary,
          targetVocabulary,
          diff.changes,
          migratedBy,
          warnings,
        );
        return { success: true, mergedVocabulary: merged, warnings };
      }
    }
  }

  /** Extend the target vocabulary with types from the source */
  private extendVocabulary(
    source: MemoryVocabulary,
    target: MemoryVocabulary,
    changes: VocabularyChange[],
    migratedBy: string,
    warnings: ImportWarning[],
  ): MemoryVocabulary {
    // Start with a copy of the target
    const merged: MemoryVocabulary = {
      ...target,
      entityTypes: [...target.entityTypes],
      relationshipTypes: [...target.relationshipTypes],
    };

    for (const change of changes) {
      if (change.changeType === 'added') {
        // Type exists in source but not target — add it
        if (change.category === 'entity_type') {
          const sourceType = source.entityTypes.find((t) => t.type === change.typeName);
          if (sourceType) {
            merged.entityTypes.push(
              createEntityTypeDefinition(
                { type: sourceType.type, description: sourceType.description, properties: sourceType.properties },
                migratedBy,
              ),
            );
            warnings.push({
              code: 'entity_type_added',
              message: `Entity type "${change.typeName}" added from source vocabulary`,
            });
          }
        } else {
          const sourceType = source.relationshipTypes.find((t) => t.type === change.typeName);
          if (sourceType) {
            merged.relationshipTypes.push(
              createRelationshipTypeDefinition(
                {
                  type: sourceType.type,
                  description: sourceType.description,
                  allowedSourceTypes: sourceType.allowedSourceTypes,
                  allowedTargetTypes: sourceType.allowedTargetTypes,
                  bidirectional: sourceType.bidirectional,
                  properties: sourceType.properties,
                },
                migratedBy,
              ),
            );
            warnings.push({
              code: 'relationship_type_added',
              message: `Relationship type "${change.typeName}" added from source vocabulary`,
            });
          }
        }
      } else if (change.changeType === 'modified') {
        // Type exists in both but differs — keep target version, warn
        warnings.push({
          code: 'vocabulary_conflict',
          message: `Type "${change.typeName}" differs between source and target: ${change.details ?? 'unknown'}. Target version kept.`,
        });
      } else if (change.changeType === 'removed') {
        // Type exists in target but not source — keep it, no action needed
        warnings.push({
          code: 'vocabulary_extra',
          message: `Type "${change.typeName}" exists in target but not in source — kept as-is`,
        });
      }
    }

    // Use the higher of the source version or the incremented target version,
    // so importing into an empty repo preserves the source version.
    const bumped = incrementVersion(merged.version, 'minor');
    merged.version = compareVersions(source.version, bumped) > 0 ? source.version : bumped;
    merged.lastModified = new Date().toISOString();
    merged.modifiedBy = migratedBy;

    return merged;
  }
}

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function describeChange(change: VocabularyChange): string {
  const label = change.category === 'entity_type' ? 'entity type' : 'relationship type';
  switch (change.changeType) {
    case 'added':
      return `${label} "${change.typeName}" exists in source but not target`;
    case 'removed':
      return `${label} "${change.typeName}" exists in target but not source`;
    case 'modified':
      return `${label} "${change.typeName}" differs: ${change.details ?? 'unknown'}`;
  }
}
