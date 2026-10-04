// VocabularyValidator — validates entities and relationships against vocabulary definitions

import type { CreateEntityInput, UpdateEntityInput } from '../types/entities.js';
import type { CreateRelationshipInput } from '../types/relationships.js';
import type {
  EntityTypeDefinition,
  MemoryVocabulary,
  PropertySchema,
  RelationshipTypeDefinition,
} from '../types/vocabulary.js';
import { toScreamingSnakeCase } from './similarity.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  describeRejectedValue,
  isSafeIdentifier,
} from '../validation/identifier.js';
import { propertyNameRefusal, type PropertyOwner } from '../validation/propertyNames.js';

/** A single validation error with optional suggestion */
export interface ValidationError {
  field: string;
  message: string;
  suggestion?: string;
}

/** Result of a validation check */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

function ok(): ValidationResult {
  return { valid: true, errors: [] };
}

function fail(...errors: ValidationError[]): ValidationResult {
  return { valid: false, errors };
}

function merge(...results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap((r) => r.errors);
  return { valid: errors.length === 0, errors };
}

/** Find the closest matching type name for suggestions */
function findClosestType(typeName: string, types: Array<{ type: string }>): string | undefined {
  if (types.length === 0) return undefined;
  // Simple prefix/substring match for suggestions
  const lower = typeName.toLowerCase();
  const match = types.find(
    (t) => t.type.toLowerCase().includes(lower) || lower.includes(t.type.toLowerCase()),
  );
  return match?.type;
}

/**
 * Validate a PropertySchema definition declared on a type of `owner`'s kind.
 * Refuses a name that could not be written on every storage provider (not a
 * safe identifier, or reserved for a system field), and an embeddable flag on
 * a non-string property.
 */
export function validatePropertySchema(schema: PropertySchema, owner: PropertyOwner): ValidationResult {
  const nameRefusal = propertyNameRefusal(schema.name, owner);
  if (nameRefusal !== undefined) {
    return fail({
      field: `properties.${schema.name}`,
      message: nameRefusal,
      suggestion: `Use a name matching ${SAFE_IDENTIFIER_PATTERN.source} that is not a reserved system field.`,
    });
  }
  if (schema.embeddable === true && schema.type !== 'string') {
    return fail({
      field: `properties.${schema.name}`,
      message: `Property "${schema.name}" cannot be embeddable — only string properties support embedding (type is "${schema.type}")`,
    });
  }
  return ok();
}

/**
 * Validate the name of a type an add proposal introduces. A relationship
 * type is checked in the SCREAMING_SNAKE_CASE form it is stored and queried
 * under, so `2nd degree` is refused as `2ND_DEGREE`. Graph stores write
 * relationship type names into query text, and every type name must be
 * usable on every provider, so both kinds must be safe identifiers.
 */
export function validateNewTypeName(name: string, kind: 'entity' | 'relationship'): ValidationResult {
  const stored = kind === 'relationship' && typeof name === 'string' ? toScreamingSnakeCase(name) : name;
  if (isSafeIdentifier(stored)) {
    return ok();
  }
  const described = describeRejectedValue(name);
  const asStored = stored === name ? '' : ` (stored as ${describeRejectedValue(stored)})`;
  return fail({
    field: 'type',
    message: `${kind === 'entity' ? 'Entity' : 'Relationship'} type name ${described}${asStored} is not a valid identifier; type names must match ${SAFE_IDENTIFIER_PATTERN.source}`,
    suggestion: 'Start the name with a letter and use only letters, digits and underscores.',
  });
}

/** Validate a property value against its schema */
export function validatePropertyValue(
  name: string,
  value: unknown,
  schema: PropertySchema,
): ValidationResult {
  if (value === undefined || value === null) {
    if (schema.required) {
      return fail({
        field: `properties.${name}`,
        message: `Required property "${name}" is missing`,
      });
    }
    return ok();
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string') {
        return fail({
          field: `properties.${name}`,
          message: `Property "${name}" must be a string, got ${typeof value}`,
        });
      }
      break;

    case 'number':
      if (typeof value !== 'number' || Number.isNaN(value)) {
        return fail({
          field: `properties.${name}`,
          message: `Property "${name}" must be a number, got ${typeof value}`,
        });
      }
      break;

    case 'boolean':
      if (typeof value !== 'boolean') {
        return fail({
          field: `properties.${name}`,
          message: `Property "${name}" must be a boolean, got ${typeof value}`,
        });
      }
      break;

    case 'date':
      if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
        return fail({
          field: `properties.${name}`,
          message: `Property "${name}" must be a valid ISO date string`,
        });
      }
      break;

    case 'enum':
      if (typeof value !== 'string') {
        return fail({
          field: `properties.${name}`,
          message: `Property "${name}" must be a string (enum value), got ${typeof value}`,
        });
      }
      if (schema.enumValues && !schema.enumValues.includes(value)) {
        return fail({
          field: `properties.${name}`,
          message: `Property "${name}" must be one of: ${schema.enumValues.join(', ')}`,
          suggestion: `Valid values: ${schema.enumValues.join(', ')}`,
        });
      }
      break;
  }

  return ok();
}

/** Validate properties against the type's property schemas */
function validateProperties(
  properties: Record<string, unknown> | undefined,
  schemas: PropertySchema[],
): ValidationResult {
  const results: ValidationResult[] = [];
  const providedProperties = properties ?? {};

  for (const schema of schemas) {
    const value = providedProperties[schema.name];
    results.push(validatePropertyValue(schema.name, value, schema));
  }

  // Only reject unknown properties when the vocab explicitly defines at least one
  // property for the type. A type with no properties defined is open to anything.
  if (schemas.length > 0) {
    const knownNames = new Set(schemas.map((s) => s.name));
    for (const key of Object.keys(providedProperties)) {
      if (!knownNames.has(key)) {
        results.push(fail({
          field: `properties.${key}`,
          message: `Unknown property "${key}"`,
          suggestion: `Known properties: ${schemas.map((s) => s.name).join(', ')}`,
        }));
      }
    }
  }

  return merge(...results);
}

/** Validate a CreateEntityInput against the vocabulary */
export function validateEntity(
  input: CreateEntityInput,
  vocabulary: MemoryVocabulary,
): ValidationResult {
  const entityTypeDef = vocabulary.entityTypes.find((et) => et.type === input.entityType);

  if (!entityTypeDef) {
    const closest = findClosestType(input.entityType, vocabulary.entityTypes);
    return fail({
      field: 'entityType',
      message: `Entity type "${input.entityType}" does not exist in the vocabulary`,
      suggestion: closest
        ? `Did you mean "${closest}"?`
        : `Available types: ${vocabulary.entityTypes.map((et) => et.type).join(', ') || 'none'}`,
    });
  }

  if (!input.label || input.label.trim().length === 0) {
    return fail({
      field: 'label',
      message: 'Entity label is required and cannot be empty',
    });
  }

  return validateProperties(input.properties, entityTypeDef.properties);
}

/**
 * Validate an UpdateEntityInput against the vocabulary.
 *
 * When `input.entityType` is set and differs from `currentEntityTypeDef.type`,
 * the target type must exist in the vocabulary, and any provided properties
 * are validated against the new type's schema (not the current type's).
 */
export function validateEntityUpdate(
  input: UpdateEntityInput,
  currentEntityTypeDef: EntityTypeDefinition,
  vocabulary: MemoryVocabulary,
): ValidationResult {
  if (input.label !== undefined && input.label.trim().length === 0) {
    return fail({
      field: 'label',
      message: 'Entity label cannot be empty',
    });
  }

  // Resolve the target type definition — either the new type (if changing) or the current one.
  let targetTypeDef: EntityTypeDefinition = currentEntityTypeDef;
  if (input.entityType !== undefined && input.entityType !== currentEntityTypeDef.type) {
    const newTypeDef = vocabulary.entityTypes.find((et) => et.type === input.entityType);
    if (!newTypeDef) {
      const closest = findClosestType(input.entityType, vocabulary.entityTypes);
      return fail({
        field: 'entityType',
        message: `Entity type "${input.entityType}" does not exist in the vocabulary`,
        suggestion: closest
          ? `Did you mean "${closest}"?`
          : `Available types: ${vocabulary.entityTypes.map((et) => et.type).join(', ') || 'none'}`,
      });
    }
    targetTypeDef = newTypeDef;
  }

  // Only validate provided properties — updates are partial.
  // Validated against the target type (new if changing, else current).
  if (input.properties) {
    const results: ValidationResult[] = [];
    const hasDefinedProps = targetTypeDef.properties.length > 0;
    for (const [key, value] of Object.entries(input.properties)) {
      // RFC 7396 JSON Merge Patch: null signals deletion of the key, so skip
      // schema validation for it — an unknown or ill-typed property being
      // removed should never block the update.
      if (value === null) continue;
      const schema = targetTypeDef.properties.find((p) => p.name === key);
      if (!schema) {
        if (hasDefinedProps) {
          results.push(fail({
            field: `properties.${key}`,
            message: `Unknown property "${key}"`,
            suggestion: `Known properties: ${targetTypeDef.properties.map((p) => p.name).join(', ')}`,
          }));
        }
      } else {
        results.push(validatePropertyValue(key, value, schema));
      }
    }
    return merge(...results);
  }

  return ok();
}

/** Validate a CreateRelationshipInput against the vocabulary */
export function validateRelationship(
  input: CreateRelationshipInput,
  vocabulary: MemoryVocabulary,
  sourceEntityType: string,
  targetEntityType: string,
): ValidationResult {
  const normalizedType = toScreamingSnakeCase(input.relationshipType);
  const relTypeDef = vocabulary.relationshipTypes.find(
    (rt) => rt.type === normalizedType,
  );

  if (!relTypeDef) {
    const closest = findClosestType(input.relationshipType, vocabulary.relationshipTypes);
    return fail({
      field: 'relationshipType',
      message: `Relationship type "${input.relationshipType}" does not exist in the vocabulary`,
      suggestion: closest
        ? `Did you mean "${closest}"?`
        : `Available types: ${vocabulary.relationshipTypes.map((rt) => rt.type).join(', ') || 'none'}`,
    });
  }

  const results: ValidationResult[] = [];

  // Validate source entity type constraint
  if (
    relTypeDef.allowedSourceTypes.length > 0 &&
    !relTypeDef.allowedSourceTypes.includes(sourceEntityType)
  ) {
    results.push(
      fail({
        field: 'sourceEntityId',
        message: `Entity type "${sourceEntityType}" is not allowed as source for relationship type "${input.relationshipType}"`,
        suggestion: `Allowed source types: ${relTypeDef.allowedSourceTypes.join(', ')}`,
      }),
    );
  }

  // Validate target entity type constraint
  if (
    relTypeDef.allowedTargetTypes.length > 0 &&
    !relTypeDef.allowedTargetTypes.includes(targetEntityType)
  ) {
    results.push(
      fail({
        field: 'targetEntityId',
        message: `Entity type "${targetEntityType}" is not allowed as target for relationship type "${input.relationshipType}"`,
        suggestion: `Allowed target types: ${relTypeDef.allowedTargetTypes.join(', ')}`,
      }),
    );
  }

  // Validate relationship properties
  if (relTypeDef.properties) {
    results.push(
      validateProperties(input.properties, relTypeDef.properties),
    );
  }

  return merge(...results);
}

/** Get an entity type definition from the vocabulary, or null if not found */
export function getEntityTypeDef(
  entityType: string,
  vocabulary: MemoryVocabulary,
): EntityTypeDefinition | null {
  return vocabulary.entityTypes.find((et) => et.type === entityType) ?? null;
}

/** Get a relationship type definition from the vocabulary, or null if not found */
export function getRelationshipTypeDef(
  relationshipType: string,
  vocabulary: MemoryVocabulary,
): RelationshipTypeDefinition | null {
  const normalized = toScreamingSnakeCase(relationshipType);
  return vocabulary.relationshipTypes.find((rt) => rt.type === normalized) ?? null;
}
