import { describe, it, expect } from 'vitest';
import { TraversalValidationError } from '../../core/errors.js';
import type { PropertyFilter } from '../../types/queries.js';
import type { TraversalStep } from '../../types/traversal.js';
import {
  assertList,
  assertPositiveSafeInteger,
  assertPropertyFilterList,
  assertSafeIdentifier,
  assertStepList,
  rejectUnsupported,
} from './compilerGuards.js';

// Untyped input (e.g. parsed JSON from a tool call) can carry values of the
// wrong runtime type into typed parameters; these helpers model that.
const asNumber = (value: number | string): number => value as number;
const asStringList = (value: string[] | string): string[] => value as string[];
const asFilters = (value: PropertyFilter[] | null[]): PropertyFilter[] => value as PropertyFilter[];
const asNever = (value: string): never => value as never;
const asStep = (value: TraversalStep | null): TraversalStep => value as TraversalStep;
const asSteps = (value: TraversalStep[] | TraversalStep): TraversalStep[] => value as TraversalStep[];

describe('compilerGuards', () => {
  it('assertSafeIdentifier accepts identifiers and refuses anything else with a typed error', () => {
    expect(() => assertSafeIdentifier('HAS_COMPONENT', 'relationship type')).not.toThrow();
    expect(() => assertSafeIdentifier('start-date', 'property filter key')).toThrow(TraversalValidationError);
    expect(() => assertSafeIdentifier('start-date', 'property filter key')).toThrow(
      /Unsafe property filter key: "start-date"/,
    );
  });

  it('assertSafeIdentifier truncates a long refused value in the message', () => {
    const long = 'x'.repeat(500) + ' OR true';
    try {
      assertSafeIdentifier(long, 'property filter key');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TraversalValidationError);
      const message = (err as TraversalValidationError).message;
      expect(message).toContain('(508 characters)');
      expect(message).not.toContain('OR true');
    }
  });

  it.each([1, 3, Number.MAX_SAFE_INTEGER])('assertPositiveSafeInteger accepts %s', (value) => {
    expect(() => assertPositiveSafeInteger(value, 'repeat.maxDepth')).not.toThrow();
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, asNumber('3')])(
    'assertPositiveSafeInteger refuses %s',
    (value) => {
      expect(() => assertPositiveSafeInteger(value, 'repeat.maxDepth')).toThrow(TraversalValidationError);
    },
  );

  it('assertList refuses a non-array', () => {
    expect(() => assertList(['a'], 'relationshipTypes')).not.toThrow();
    expect(() => assertList(asStringList('a'), 'relationshipTypes')).toThrow(
      /relationshipTypes must be an array; got "a"/,
    );
  });

  it('assertPropertyFilterList refuses a null element', () => {
    expect(() => assertPropertyFilterList([{ key: 'k', operator: 'isNull' }], 'start.filter')).not.toThrow();
    expect(() => assertPropertyFilterList(asFilters([null]), 'start.filter')).toThrow(
      /start\.filter\[0\] must be a property filter object; got null/,
    );
  });

  it('assertStepList refuses a non-array and a null element', () => {
    expect(() => assertStepList([{ direction: 'out' }], 'steps')).not.toThrow();
    expect(() => assertStepList(asSteps({ direction: 'out' }), 'steps')).toThrow(/steps must be an array/);
    expect(() => assertStepList([{ direction: 'out' }, asStep(null)], 'steps')).toThrow(
      /steps\[1\] must be a step object; got null/,
    );
  });

  it('rejectUnsupported always throws a typed error', () => {
    expect(() => rejectUnsupported(asNever('sideways'), 'direction')).toThrow(TraversalValidationError);
    expect(() => rejectUnsupported(asNever('sideways'), 'direction')).toThrow(/Unsupported direction: "sideways"/);
  });
});
