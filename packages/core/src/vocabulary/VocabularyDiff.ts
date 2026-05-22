// VocabularyDiff — computes diffs between two vocabulary versions

import type {
  EntityTypeDefinition,
  MemoryVocabulary,
  PropertySchema,
  RelationshipTypeDefinition,
} from '../types/vocabulary.js';

/** A single change in a vocabulary diff */
export interface VocabularyChange {
  changeType: 'added' | 'removed' | 'modified';
  category: 'entity_type' | 'relationship_type';
  typeName: string;
  details?: string;
}

/** Complete diff between two vocabulary versions */
export interface VocabularyDiffResult {
  fromVersion: string;
  toVersion: string;
  changes: VocabularyChange[];
  hasChanges: boolean;
}

/** Compute the diff between two vocabulary versions */
export function diffVocabularies(
  from: MemoryVocabulary,
  to: MemoryVocabulary,
): VocabularyDiffResult {
  const changes: VocabularyChange[] = [];

  // Entity type diffs
  diffTypes(
    from.entityTypes,
    to.entityTypes,
    'entity_type',
    diffEntityType,
    changes,
  );

  // Relationship type diffs
  diffTypes(
    from.relationshipTypes,
    to.relationshipTypes,
    'relationship_type',
    diffRelationshipType,
    changes,
  );

  return {
    fromVersion: from.version,
    toVersion: to.version,
    changes,
    hasChanges: changes.length > 0,
  };
}

function diffTypes<T extends { type: string }>(
  fromTypes: T[],
  toTypes: T[],
  category: 'entity_type' | 'relationship_type',
  detailDiff: (from: T, to: T) => string | null,
  changes: VocabularyChange[],
): void {
  const fromMap = new Map(fromTypes.map((t) => [t.type, t]));
  const toMap = new Map(toTypes.map((t) => [t.type, t]));

  // Added types
  for (const [typeName] of toMap) {
    if (!fromMap.has(typeName)) {
      changes.push({ changeType: 'added', category, typeName });
    }
  }

  // Removed types
  for (const [typeName] of fromMap) {
    if (!toMap.has(typeName)) {
      changes.push({ changeType: 'removed', category, typeName });
    }
  }

  // Modified types
  for (const [typeName, fromType] of fromMap) {
    const toType = toMap.get(typeName);
    if (!toType) continue;

    const details = detailDiff(fromType, toType);
    if (details) {
      changes.push({ changeType: 'modified', category, typeName, details });
    }
  }
}

function diffEntityType(
  from: EntityTypeDefinition,
  to: EntityTypeDefinition,
): string | null {
  const diffs: string[] = [];

  if (from.description !== to.description) {
    diffs.push('description changed');
  }

  const propDiff = diffPropertySchemas(from.properties, to.properties);
  if (propDiff) {
    diffs.push(propDiff);
  }

  return diffs.length > 0 ? diffs.join('; ') : null;
}

function diffRelationshipType(
  from: RelationshipTypeDefinition,
  to: RelationshipTypeDefinition,
): string | null {
  const diffs: string[] = [];

  if (from.description !== to.description) {
    diffs.push('description changed');
  }

  if (from.bidirectional !== to.bidirectional) {
    diffs.push(`bidirectional: ${from.bidirectional} → ${to.bidirectional}`);
  }

  const srcDiff = diffArrays(from.allowedSourceTypes, to.allowedSourceTypes);
  if (srcDiff) diffs.push(`allowedSourceTypes: ${srcDiff}`);

  const tgtDiff = diffArrays(from.allowedTargetTypes, to.allowedTargetTypes);
  if (tgtDiff) diffs.push(`allowedTargetTypes: ${tgtDiff}`);

  const propDiff = diffPropertySchemas(from.properties ?? [], to.properties ?? []);
  if (propDiff) diffs.push(propDiff);

  return diffs.length > 0 ? diffs.join('; ') : null;
}

function diffPropertySchemas(from: PropertySchema[], to: PropertySchema[]): string | null {
  const fromMap = new Map(from.map((p) => [p.name, p]));
  const toMap = new Map(to.map((p) => [p.name, p]));
  const parts: string[] = [];

  for (const [name] of toMap) {
    if (!fromMap.has(name)) parts.push(`property "${name}" added`);
  }

  for (const [name] of fromMap) {
    if (!toMap.has(name)) parts.push(`property "${name}" removed`);
  }

  for (const [name, fromProp] of fromMap) {
    const toProp = toMap.get(name);
    if (!toProp) continue;

    if (fromProp.type !== toProp.type) {
      parts.push(`property "${name}" type: ${fromProp.type} → ${toProp.type}`);
    }
    if (fromProp.required !== toProp.required) {
      parts.push(`property "${name}" required: ${fromProp.required} → ${toProp.required}`);
    }
  }

  return parts.length > 0 ? parts.join(', ') : null;
}

function diffArrays(from: string[], to: string[]): string | null {
  const fromSet = new Set(from);
  const toSet = new Set(to);
  const added = to.filter((t) => !fromSet.has(t));
  const removed = from.filter((f) => !toSet.has(f));

  const parts: string[] = [];
  if (added.length > 0) parts.push(`+[${added.join(', ')}]`);
  if (removed.length > 0) parts.push(`-[${removed.join(', ')}]`);

  return parts.length > 0 ? parts.join(' ') : null;
}
