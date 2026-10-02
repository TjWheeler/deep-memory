// VocabularySchema — factory functions for creating well-formed vocabulary definitions

import type {
  EntityTypeDefinition,
  EntityTypeInput,
  MemoryVocabulary,
  PropertySchema,
  RelationshipTypeDefinition,
  RelationshipTypeInput,
  VocabularyInput,
  VocabularyProposal,
} from '../types/vocabulary.js';
import { toScreamingSnakeCase } from './similarity.js';
import { InvalidInputError } from '../core/errors.js';

/** A well-formed vocabulary version: three dot-separated non-negative integers. */
const VOCABULARY_VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * True when `version` is a well-formed `major.minor.patch` vocabulary version.
 * Used to reject externally supplied versions (e.g. from an import archive)
 * before they are stored, since compare-and-set writes and version bumps both
 * depend on the version being parseable.
 */
export function isValidVocabularyVersion(version: string): boolean {
  return typeof version === 'string' && VOCABULARY_VERSION_PATTERN.test(version);
}

/** Create an empty vocabulary with version "0.0.0" */
export function createEmptyVocabulary(modifiedBy: string): MemoryVocabulary {
  const now = new Date().toISOString();
  return {
    version: '0.0.0',
    lastModified: now,
    modifiedBy,
    entityTypes: [],
    relationshipTypes: [],
  };
}

/** Create an EntityTypeDefinition from an input, filling in system-managed fields */
export function createEntityTypeDefinition(
  input: EntityTypeInput,
  createdBy: string,
): EntityTypeDefinition {
  const now = new Date().toISOString();
  return {
    type: input.type,
    description: input.description,
    version: '1.0.0',
    properties: input.properties ?? [],
    createdAt: now,
    createdBy,
    modifiedAt: now,
    modifiedBy: createdBy,
  };
}

/** Create a RelationshipTypeDefinition from an input, filling in system-managed fields */
export function createRelationshipTypeDefinition(
  input: RelationshipTypeInput,
  createdBy: string,
): RelationshipTypeDefinition {
  const now = new Date().toISOString();
  return {
    type: toScreamingSnakeCase(input.type),
    description: input.description,
    version: '1.0.0',
    allowedSourceTypes: input.allowedSourceTypes,
    allowedTargetTypes: input.allowedTargetTypes,
    bidirectional: input.bidirectional ?? false,
    properties: input.properties,
    createdAt: now,
    createdBy,
    modifiedAt: now,
    modifiedBy: createdBy,
  };
}

/** Build a full MemoryVocabulary from a VocabularyInput */
export function buildVocabulary(input: VocabularyInput, createdBy: string): MemoryVocabulary {
  const now = new Date().toISOString();
  return {
    version: '1.0.0',
    lastModified: now,
    modifiedBy: createdBy,
    entityTypes: (input.entityTypes ?? []).map((et) => createEntityTypeDefinition(et, createdBy)),
    relationshipTypes: (input.relationshipTypes ?? []).map((rt) =>
      createRelationshipTypeDefinition(rt, createdBy),
    ),
  };
}

/**
 * Parse the numeric components of a version string. Missing trailing
 * components default to 0. A component that is present but is not a
 * non-negative safe integer throws: silently turning it into NaN would make
 * every subsequent bump produce the same string, and a version that never
 * changes defeats compare-and-set on the vocabulary.
 */
function parseVersionComponents(version: string): [number, number, number] {
  const raw = version.split('.');
  const parsed = raw.map((part) => {
    const value = Number(part);
    if (!/^\d+$/.test(part) || !Number.isSafeInteger(value)) {
      throw new InvalidInputError(
        'version',
        `Vocabulary version "${version}" is not a valid version: component "${part}" is not a non-negative integer`,
        'Vocabulary versions must be in "major.minor.patch" form, e.g. "1.2.0".',
      );
    }
    return value;
  });
  return [parsed[0] ?? 0, parsed[1] ?? 0, parsed[2] ?? 0];
}

/** Increment a semantic version string (patch by default) */
export function incrementVersion(
  version: string,
  level: 'major' | 'minor' | 'patch' = 'patch',
): string {
  const [major, minor, patch] = parseVersionComponents(version);

  switch (level) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
  }
}

/** Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Merge property edits into an existing properties array */
function mergeProperties(
  existing: PropertySchema[],
  addProperties?: PropertySchema[],
  removeProperties?: string[],
  updateProperties?: PropertySchema[],
): PropertySchema[] {
  // Start from existing
  let result = [...existing];

  // Remove
  if (removeProperties && removeProperties.length > 0) {
    const removeSet = new Set(removeProperties);
    result = result.filter((p) => !removeSet.has(p.name));
  }

  // Update (replace by name)
  if (updateProperties && updateProperties.length > 0) {
    const updateMap = new Map(updateProperties.map((p) => [p.name, p]));
    result = result.map((p) => updateMap.get(p.name) ?? p);
  }

  // Add
  if (addProperties && addProperties.length > 0) {
    const existingNames = new Set(result.map((p) => p.name));
    for (const prop of addProperties) {
      if (!existingNames.has(prop.name)) {
        result.push(prop);
      }
    }
  }

  return result;
}

/** Apply an edit to an existing EntityTypeDefinition */
export function mergeEntityTypeEdit(
  existing: EntityTypeDefinition,
  edit: NonNullable<VocabularyProposal['editEntityType']>,
  modifiedBy: string,
): EntityTypeDefinition {
  const now = new Date().toISOString();
  return {
    ...existing,
    description: edit.description ?? existing.description,
    version: incrementVersion(existing.version, 'minor'),
    properties: mergeProperties(
      existing.properties,
      edit.addProperties,
      edit.removeProperties,
      edit.updateProperties,
    ),
    modifiedAt: now,
    modifiedBy,
  };
}

/** Apply an edit to an existing RelationshipTypeDefinition */
export function mergeRelationshipTypeEdit(
  existing: RelationshipTypeDefinition,
  edit: NonNullable<VocabularyProposal['editRelationshipType']>,
  modifiedBy: string,
): RelationshipTypeDefinition {
  const now = new Date().toISOString();
  return {
    ...existing,
    description: edit.description ?? existing.description,
    allowedSourceTypes: edit.allowedSourceTypes ?? existing.allowedSourceTypes,
    allowedTargetTypes: edit.allowedTargetTypes ?? existing.allowedTargetTypes,
    bidirectional: edit.bidirectional ?? existing.bidirectional,
    version: incrementVersion(existing.version, 'minor'),
    properties: mergeProperties(
      existing.properties ?? [],
      edit.addProperties,
      edit.removeProperties,
      edit.updateProperties,
    ),
    modifiedAt: now,
    modifiedBy,
  };
}
