// TraversalValidator — validates a TraversalSpec against structural
// constraints and the repository vocabulary before execution.

import type { TraversalSpec, TraversalStep } from '../types/traversal.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { ExploreOptions, PathOptions, PropertyFilter } from '../types/queries.js';
import type { GraphTraversalCapabilities } from '../providers/GraphTraversalProvider.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  describeRejectedValue,
  isPositiveSafeInteger,
  isSafeIdentifier,
} from '../validation/identifier.js';
import { isReservedPropertyName } from '../validation/propertyNames.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_LIMIT = 200;
const DEFAULT_FALLBACK_MAX_DEPTH = 10;
const MAX_EXPLORE_DEPTH = 3;
const MAX_PATH_DEPTH = 5;
const MAX_OFFSET = 1000;

// ─── Structure, bounds and identifiers ──────────────────────────
//
// These checks enforce the documented option shapes, numeric bounds and the
// safe-identifier rule the same way on every provider, before any storage
// work starts. Relationship type names, property filter keys and projection
// names must be safe identifiers even on providers that bind or match names
// directly, so that a request which works on one backend works on all of
// them. The graph compilers apply the same rule again where they write names
// into query text, as the last line of defence for specs that did not come
// through these validators. Entity type names are not checked here: every
// provider binds them as parameter values.
//
// Optional numbers are checked with `!= null` because callers default them
// with `??`, which treats an explicit `null` as "use the default".

/** Every operator a `PropertyFilter` may carry. Typed as a record so a new operator must be added here. */
const PROPERTY_FILTER_OPERATORS: Readonly<Record<PropertyFilter['operator'], true>> = {
  eq: true,
  neq: true,
  isNull: true,
  isNotNull: true,
  gt: true,
  lt: true,
  gte: true,
  lte: true,
  contains: true,
};

function isPropertyFilterOperator(value: string): boolean {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROPERTY_FILTER_OPERATORS, value);
}

/** Record an error unless `value` is a safe integer in `[min, max]`. */
function checkIntegerInRange(
  value: number,
  location: string,
  errors: string[],
  min: number,
  max: number,
): void {
  const inRange =
    typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
  if (!inRange) {
    errors.push(
      `${location} must be an integer between ${min} and ${max}; got ${describeRejectedValue(value)}`,
    );
  }
}

/** Record an error unless `value` is a safe identifier. Call only with a string. */
function checkIdentifier(value: string, location: string, errors: string[]): void {
  if (!isSafeIdentifier(value)) {
    errors.push(
      `${location} ${describeRejectedValue(value)} is not a safe identifier; identifiers must match ${SAFE_IDENTIFIER_PATTERN.source}`,
    );
  }
}

/**
 * Record an error unless `value` is an array of strings. With
 * `requireIdentifiers`, every string must also be a safe identifier.
 */
function checkStringList(
  value: readonly string[] | null | undefined,
  location: string,
  errors: string[],
  requireIdentifiers: boolean,
): void {
  if (value == null) return;
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array of strings; got ${describeRejectedValue(value)}`);
    return;
  }
  value.forEach((item, i) => {
    if (typeof item !== 'string') {
      errors.push(`${location}[${i}] must be a string; got ${describeRejectedValue(item)}`);
    } else if (requireIdentifiers) {
      checkIdentifier(item, `${location}[${i}]`, errors);
    }
  });
}

/**
 * Record an error for each projected name that is reserved for an entity
 * system field. Projection reads user properties; a graph store keeps system
 * fields (provenance, slug, embedding, write tokens) on the same node, so a
 * reserved name would read the system field there while reading nothing on a
 * provider that projects from the user properties alone. No user property
 * can carry a reserved name, so refusing one loses nothing. Non-string and
 * malformed entries were already reported by `checkStringList`.
 */
function checkProjectableNames(value: readonly string[], errors: string[]): void {
  if (!Array.isArray(value)) return;
  value.forEach((item, i) => {
    if (typeof item === 'string' && isSafeIdentifier(item) && isReservedPropertyName(item, 'entity')) {
      errors.push(
        `projection.properties[${i}] "${item}" is reserved for an entity system field and cannot be projected; projection reads user properties only`,
      );
    }
  });
}

/**
 * Record an error unless `value` is an array of filter objects, each with a
 * safe-identifier key and a known operator.
 */
function checkPropertyFilters(
  value: readonly PropertyFilter[] | null | undefined,
  location: string,
  errors: string[],
): void {
  if (value == null) return;
  if (!Array.isArray(value)) {
    errors.push(`${location} must be an array of property filters; got ${describeRejectedValue(value)}`);
    return;
  }
  value.forEach((filter, i) => {
    if (typeof filter !== 'object' || filter === null) {
      errors.push(`${location}[${i}] must be a property filter object; got ${describeRejectedValue(filter)}`);
      return;
    }
    if (typeof filter.key !== 'string') {
      errors.push(`${location}[${i}].key must be a string; got ${describeRejectedValue(filter.key)}`);
    } else {
      checkIdentifier(filter.key, `${location}[${i}].key`, errors);
    }
    if (!isPropertyFilterOperator(filter.operator)) {
      errors.push(
        `${location}[${i}].operator must be one of ${Object.keys(PROPERTY_FILTER_OPERATORS).join(', ')}; got ${describeRejectedValue(filter.operator)}`,
      );
    }
  });
}

/**
 * Validates neighbourhood-exploration options: `depth` is an integer from 1
 * to 3, `relationshipTypes` is an array of safe identifiers, `entityTypes`
 * an array of strings, and `relationshipPropertyFilters` an array of
 * well-formed filters with safe-identifier keys.
 */
export function validateExploreOptions(options?: ExploreOptions): ValidationResult {
  const errors: string[] = [];
  if (options) {
    if (options.depth != null) {
      checkIntegerInRange(options.depth, 'depth', errors, 1, MAX_EXPLORE_DEPTH);
    }
    checkStringList(options.relationshipTypes, 'relationshipTypes', errors, true);
    // Providers filter result entities with `entityTypes.includes(...)`; a
    // string there would silently become substring matching.
    checkStringList(options.entityTypes, 'entityTypes', errors, false);
    checkPropertyFilters(options.relationshipPropertyFilters, 'relationshipPropertyFilters', errors);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates path-finding options: `maxDepth` is an integer from 1 to 5,
 * `limit` an integer from 1 to 200, `offset` an integer from 0 to 1000,
 * `relationshipTypes` an array of safe identifiers, `entityTypes` an array of
 * strings, and `relationshipPropertyFilters` an array of well-formed filters
 * with safe-identifier keys.
 */
export function validatePathOptions(options?: PathOptions): ValidationResult {
  const errors: string[] = [];
  if (options) {
    if (options.maxDepth != null) {
      checkIntegerInRange(options.maxDepth, 'maxDepth', errors, 1, MAX_PATH_DEPTH);
    }
    if (options.limit != null) {
      checkIntegerInRange(options.limit, 'limit', errors, 1, DEFAULT_MAX_LIMIT);
    }
    if (options.offset != null) {
      checkIntegerInRange(options.offset, 'offset', errors, 0, MAX_OFFSET);
    }
    checkStringList(options.relationshipTypes, 'relationshipTypes', errors, true);
    // Providers filter result entities with `entityTypes.includes(...)`; a
    // string there would silently become substring matching.
    checkStringList(options.entityTypes, 'entityTypes', errors, false);
    checkPropertyFilters(options.relationshipPropertyFilters, 'relationshipPropertyFilters', errors);
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a TraversalSpec against structural rules and vocabulary.
 * Returns all validation failures rather than stopping at the first.
 */
export function validateTraversalSpec(
  spec: TraversalSpec,
  vocabulary?: MemoryVocabulary,
  capabilities?: GraphTraversalCapabilities,
): ValidationResult {
  const errors: string[] = [];

  // ─── Structural validation ────────────────────────────────────

  // A non-array `steps` is reported once and then treated as no steps, so the
  // remaining checks can still run without tripping over it.
  let steps: readonly TraversalStep[] = [];
  if (spec.steps != null) {
    if (Array.isArray(spec.steps)) {
      steps = spec.steps;
    } else {
      errors.push(`steps must be an array; got ${describeRejectedValue(spec.steps)}`);
    }
  }

  // Start must have at least one of entityId, entityType, or filter
  if (!spec.start) {
    errors.push('start is required');
  } else {
    const hasEntityId = spec.start.entityId !== undefined && spec.start.entityId !== '';
    const hasEntityType = spec.start.entityType !== undefined && spec.start.entityType !== '';
    const hasFilter = Array.isArray(spec.start.filter) && spec.start.filter.length > 0;

    if (!hasEntityId && !hasEntityType && !hasFilter) {
      errors.push('start must have at least one of entityId, entityType, or filter');
    }

    // start.entityType without entityId requires limit on the spec
    if (hasEntityType && !hasEntityId && (spec.limit == null || spec.limit === 0)) {
      errors.push('start.entityType without entityId requires limit on the spec to prevent full type scans');
    }

    checkPropertyFilters(spec.start.filter, 'start.filter', errors);
  }

  // Steps are optional (zero steps = vertex query), but validate if present
  const maxSteps = capabilities?.maxTraversalDepth ?? DEFAULT_MAX_STEPS;
  if (steps.length > maxSteps) {
    errors.push(`steps length ${steps.length} exceeds maximum ${maxSteps}`);
  }

  // Validate individual steps, summing the potential depth of the walk. A
  // repeat step's depth is only added once it has passed the integer check;
  // adding an unchecked value could concatenate a string or yield NaN.
  let totalDepth = 0;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    if (typeof step !== 'object' || step === null) {
      errors.push(`steps[${i}] must be a step object; got ${describeRejectedValue(step)}`);
      continue;
    }

    if (!step.direction || !['out', 'in', 'both'].includes(step.direction)) {
      errors.push(`steps[${i}].direction must be 'out', 'in', or 'both'`);
    }

    checkStringList(step.relationshipTypes, `steps[${i}].relationshipTypes`, errors, true);
    checkStringList(step.entityTypes, `steps[${i}].entityTypes`, errors, false);
    checkPropertyFilters(step.entityFilter, `steps[${i}].entityFilter`, errors);
    checkPropertyFilters(step.relationshipFilter, `steps[${i}].relationshipFilter`, errors);

    if (step.repeat) {
      if (isPositiveSafeInteger(step.repeat.maxDepth)) {
        totalDepth += step.repeat.maxDepth;
      } else {
        errors.push(
          `steps[${i}].repeat.maxDepth must be a positive integer; got ${describeRejectedValue(step.repeat.maxDepth)}`,
        );
      }
      checkPropertyFilters(step.repeat.until, `steps[${i}].repeat.until`, errors);
    } else {
      totalDepth += 1;
    }
  }

  // Total potential depth check (only when steps present)
  if (steps.length > 0) {
    const maxProviderDepth = capabilities?.maxTraversalDepth ?? DEFAULT_FALLBACK_MAX_DEPTH;
    if (totalDepth > maxProviderDepth) {
      errors.push(`total potential depth ${totalDepth} exceeds provider maximum ${maxProviderDepth}`);
    }
  }

  // Path mode requires at least one step
  if (spec.returnMode === 'path' && steps.length === 0) {
    errors.push("returnMode 'path' requires at least one step");
  }

  // Return mode
  if (spec.returnMode && !['terminal', 'path', 'all'].includes(spec.returnMode)) {
    errors.push(`returnMode must be 'terminal', 'path', or 'all'`);
  }

  // Projection validation
  if (spec.projection) {
    if (!spec.projection.properties || spec.projection.properties.length === 0) {
      errors.push('projection.properties must contain at least one property name');
    } else {
      checkStringList(spec.projection.properties, 'projection.properties', errors, true);
      checkProjectableNames(spec.projection.properties, errors);
    }
    if (spec.projection.mode && !['count', 'values'].includes(spec.projection.mode)) {
      errors.push("projection.mode must be 'count' or 'values'");
    }
  }

  // Pagination bounds
  if (spec.limit != null) {
    checkIntegerInRange(spec.limit, 'limit', errors, 1, DEFAULT_MAX_LIMIT);
  }
  if (spec.offset != null) {
    checkIntegerInRange(spec.offset, 'offset', errors, 0, MAX_OFFSET);
  }

  // ─── Vocabulary validation ────────────────────────────────────

  if (vocabulary) {
    const entityTypeSet = new Set(vocabulary.entityTypes.map((et) => et.type));
    const relationshipTypeSet = new Set(vocabulary.relationshipTypes.map((rt) => rt.type));
    const unknownTypes: string[] = [];

    // Validate start.entityType
    if (spec.start?.entityType && !entityTypeSet.has(spec.start.entityType)) {
      unknownTypes.push(`entity type ${describeRejectedValue(spec.start.entityType)}`);
    }

    // Validate types in each step. Non-object steps and non-array lists were
    // already reported as structural errors above.
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      if (typeof step !== 'object' || step === null) continue;

      if (Array.isArray(step.relationshipTypes)) {
        for (const rt of step.relationshipTypes) {
          if (!relationshipTypeSet.has(rt)) {
            unknownTypes.push(`relationship type ${describeRejectedValue(rt)} in steps[${i}]`);
          }
        }
      }

      if (Array.isArray(step.entityTypes)) {
        for (const et of step.entityTypes) {
          if (!entityTypeSet.has(et)) {
            unknownTypes.push(`entity type ${describeRejectedValue(et)} in steps[${i}]`);
          }
        }
      }
    }

    if (unknownTypes.length > 0) {
      errors.push(`Unknown vocabulary types: ${unknownTypes.join(', ')}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
