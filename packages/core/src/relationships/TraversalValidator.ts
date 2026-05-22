// TraversalValidator — validates a TraversalSpec against structural
// constraints and the repository vocabulary before execution.

import type { TraversalSpec } from '../types/traversal.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { GraphTraversalCapabilities } from '../providers/GraphTraversalProvider.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const DEFAULT_MAX_STEPS = 6;
const DEFAULT_MAX_LIMIT = 200;
const DEFAULT_FALLBACK_MAX_DEPTH = 10;

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
  const steps = spec.steps ?? [];

  // ─── Structural validation ────────────────────────────────────

  // Start must have at least one of entityId, entityType, or filter
  if (!spec.start) {
    errors.push('start is required');
  } else {
    const hasEntityId = spec.start.entityId !== undefined && spec.start.entityId !== '';
    const hasEntityType = spec.start.entityType !== undefined && spec.start.entityType !== '';
    const hasFilter = spec.start.filter !== undefined && spec.start.filter.length > 0;

    if (!hasEntityId && !hasEntityType && !hasFilter) {
      errors.push('start must have at least one of entityId, entityType, or filter');
    }

    // start.entityType without entityId requires limit on the spec
    if (hasEntityType && !hasEntityId && (spec.limit === undefined || spec.limit === 0)) {
      errors.push('start.entityType without entityId requires limit on the spec to prevent full type scans');
    }
  }

  // Steps are optional (zero steps = vertex query), but validate if present
  const maxSteps = capabilities?.maxTraversalDepth ?? DEFAULT_MAX_STEPS;
  if (steps.length > maxSteps) {
    errors.push(`steps length ${steps.length} exceeds maximum ${maxSteps}`);
  }

  // Validate individual steps
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;

    if (!step.direction || !['out', 'in', 'both'].includes(step.direction)) {
      errors.push(`steps[${i}].direction must be 'out', 'in', or 'both'`);
    }

    if (step.repeat) {
      if (step.repeat.maxDepth === undefined || step.repeat.maxDepth <= 0) {
        errors.push(`steps[${i}].repeat.maxDepth must be a positive number`);
      }
    }
  }

  // Total potential depth check (only when steps present)
  if (steps.length > 0) {
    const maxProviderDepth = capabilities?.maxTraversalDepth ?? DEFAULT_FALLBACK_MAX_DEPTH;
    let totalDepth = 0;
    for (const step of steps) {
      totalDepth += step.repeat ? step.repeat.maxDepth : 1;
    }
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
    }
    if (spec.projection.mode && !['count', 'values'].includes(spec.projection.mode)) {
      errors.push("projection.mode must be 'count' or 'values'");
    }
  }

  // Limit bounds
  if (spec.limit !== undefined) {
    if (spec.limit < 1 || spec.limit > DEFAULT_MAX_LIMIT) {
      errors.push(`limit must be between 1 and ${DEFAULT_MAX_LIMIT}`);
    }
  }

  // Offset bounds
  if (spec.offset !== undefined && spec.offset < 0) {
    errors.push('offset must be >= 0');
  }

  // ─── Vocabulary validation ────────────────────────────────────

  if (vocabulary) {
    const entityTypeSet = new Set(vocabulary.entityTypes.map((et) => et.type));
    const relationshipTypeSet = new Set(vocabulary.relationshipTypes.map((rt) => rt.type));
    const unknownTypes: string[] = [];

    // Validate start.entityType
    if (spec.start?.entityType && !entityTypeSet.has(spec.start.entityType)) {
      unknownTypes.push(`entity type "${spec.start.entityType}"`);
    }

    // Validate types in each step
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;

      if (step.relationshipTypes) {
        for (const rt of step.relationshipTypes) {
          if (!relationshipTypeSet.has(rt)) {
            unknownTypes.push(`relationship type "${rt}" in steps[${i}]`);
          }
        }
      }

      if (step.entityTypes) {
        for (const et of step.entityTypes) {
          if (!entityTypeSet.has(et)) {
            unknownTypes.push(`entity type "${et}" in steps[${i}]`);
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
