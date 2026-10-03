// Guards the traversal compilers apply to caller-derived parts of a spec
// before emitting query text. Values are always bound as parameters; these
// guards cover the positions a query language cannot parameterise
// (identifiers and repeat counts) and the list shapes the compilers iterate.
// The compilers are the last step before a query reaches the database, so
// they enforce these rules themselves whatever entry point built the spec.

import type { PropertyFilter } from '../../types/queries.js';
import type { TraversalStep } from '../../types/traversal.js';
import { TraversalValidationError } from '../../core/errors.js';
import {
  SAFE_IDENTIFIER_PATTERN,
  describeRejectedValue,
  isPositiveSafeInteger,
  isSafeIdentifier,
} from '../../validation/identifier.js';

/**
 * Throw `TraversalValidationError` unless `value` is a safe identifier.
 * `role` names what the value is (e.g. "property filter key") so the caller
 * can tell which input was refused.
 */
export function assertSafeIdentifier(value: string, role: string): void {
  if (!isSafeIdentifier(value)) {
    throw new TraversalValidationError([
      `Unsafe ${role}: ${describeRejectedValue(value)}. Identifiers must match ${SAFE_IDENTIFIER_PATTERN.source}.`,
    ]);
  }
}

/**
 * Throw `TraversalValidationError` unless `value` is a positive safe integer.
 * Repeat counts are emitted as literals (Cypher `*1..N`, Gremlin `times(N)`).
 */
export function assertPositiveSafeInteger(value: number, role: string): void {
  if (!isPositiveSafeInteger(value)) {
    throw new TraversalValidationError([
      `${role} must be a positive integer; got ${describeRejectedValue(value)}`,
    ]);
  }
}

/**
 * Throw `TraversalValidationError` unless `value` is an array. Specs often
 * arrive from untyped JSON; without this a string or object in a list field
 * would surface as a `TypeError` from `.map` / iteration instead of a typed
 * refusal.
 */
export function assertList<T>(value: readonly T[], role: string): void {
  if (!Array.isArray(value)) {
    throw new TraversalValidationError([
      `${role} must be an array; got ${describeRejectedValue(value)}`,
    ]);
  }
}

/**
 * Throw `TraversalValidationError` unless every element of `items` is a
 * non-null object, so its fields can be read without a `TypeError`.
 */
function assertObjectElements<T extends object>(items: readonly T[], role: string, kind: string): void {
  items.forEach((item, i) => {
    if (typeof item !== 'object' || item === null) {
      throw new TraversalValidationError([
        `${role}[${i}] must be a ${kind} object; got ${describeRejectedValue(item)}`,
      ]);
    }
  });
}

/**
 * Throw `TraversalValidationError` unless `filters` is an array of non-null
 * objects, so each filter's `key` / `operator` can be read safely.
 */
export function assertPropertyFilterList(filters: readonly PropertyFilter[], role: string): void {
  assertList(filters, role);
  assertObjectElements(filters, role, 'property filter');
}

/**
 * Throw `TraversalValidationError` unless `steps` is an array of non-null
 * step objects. Both compilers iterate the steps and read their fields before
 * emitting anything, so a malformed list must be refused up front.
 */
export function assertStepList(steps: readonly TraversalStep[], role: string): void {
  assertList(steps, role);
  assertObjectElements(steps, role, 'step');
}

/**
 * Throw `TraversalValidationError` for a value that fell through an
 * exhaustive switch over a closed set (direction, operator). Untyped input
 * can carry a value outside the declared union; emitting nothing for it would
 * produce a malformed query.
 */
export function rejectUnsupported(value: never, role: string): never {
  throw new TraversalValidationError([
    `Unsupported ${role}: ${describeRejectedValue(value)}`,
  ]);
}
