import { describe, it, expect } from 'vitest';
import { validateExploreOptions, validatePathOptions, validateTraversalSpec } from './TraversalValidator.js';
import type { TraversalSpec, TraversalStep } from '../types/traversal.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { ExploreOptions, PropertyFilter } from '../types/queries.js';

// Untyped input (e.g. parsed JSON from a tool call) can carry a value of the
// wrong runtime type into a typed field.
const asNumber = (value: number | string | null): number => value as number;

const validSpec: TraversalSpec = {
  start: { entityId: 'abc-123' },
  steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
  returnMode: 'terminal',
};

const mockVocabulary: MemoryVocabulary = {
  version: '1.0.0',
  lastModified: '2026-01-01T00:00:00Z',
  modifiedBy: 'test',
  entityTypes: [
    { type: 'Equipment', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
    { type: 'Component', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
    { type: 'Fluid', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
  ],
  relationshipTypes: [
    { type: 'HAS_COMPONENT', description: '', version: '1.0', allowedSourceTypes: ['Equipment'], allowedTargetTypes: ['Component'], bidirectional: false, createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
    { type: 'REQUIRES_FLUID', description: '', version: '1.0', allowedSourceTypes: ['Component'], allowedTargetTypes: ['Fluid'], bidirectional: false, createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
  ],
};

describe('TraversalValidator', () => {
  describe('structural validation', () => {
    it('accepts a valid spec', () => {
      const result = validateTraversalSpec(validSpec);
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('rejects missing start', () => {
      const result = validateTraversalSpec({ ...validSpec, start: undefined as never });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/start is required/);
    });

    it('rejects empty start (no entityId, entityType, or filter)', () => {
      const result = validateTraversalSpec({ ...validSpec, start: {} });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/at least one of entityId, entityType, or filter/);
    });

    it('rejects entityType start without limit', () => {
      const result = validateTraversalSpec({
        ...validSpec,
        start: { entityType: 'Equipment' },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/requires limit/);
    });

    it('accepts entityType start with limit', () => {
      const result = validateTraversalSpec({
        ...validSpec,
        start: { entityType: 'Equipment' },
        limit: 50,
      });
      expect(result.valid).toBe(true);
    });

    it('accepts zero steps (vertex query)', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'abc-123' },
        returnMode: 'terminal',
      });
      expect(result.valid).toBe(true);
    });

    it('accepts empty steps array (vertex query)', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'abc-123' },
        steps: [],
        returnMode: 'terminal',
      });
      expect(result.valid).toBe(true);
    });

    it('rejects path mode with zero steps', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'abc-123' },
        steps: [],
        returnMode: 'path',
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/path.*requires at least one step/);
    });

    it('validates projection properties', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'abc-123' },
        returnMode: 'terminal',
        projection: { properties: [] },
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/projection.properties must contain/);
    });

    it('accepts valid projection', () => {
      const result = validateTraversalSpec({
        start: { entityType: 'Equipment' },
        returnMode: 'terminal',
        projection: { properties: ['equipmentType'], distinct: true },
        limit: 200,
      });
      expect(result.valid).toBe(true);
    });

    it('rejects invalid direction', () => {
      const result = validateTraversalSpec({
        ...validSpec,
        steps: [{ direction: 'sideways' as 'out' }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/direction must be/);
    });

    it('rejects repeat without maxDepth', () => {
      const result = validateTraversalSpec({
        ...validSpec,
        steps: [{ direction: 'out', repeat: { maxDepth: 0 } }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/maxDepth must be a positive integer/);
    });

    it('rejects limit out of bounds', () => {
      const result = validateTraversalSpec({ ...validSpec, limit: 300 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/limit must be an integer between 1 and 200/);
    });

    it('rejects negative offset', () => {
      const result = validateTraversalSpec({ ...validSpec, offset: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/offset must be an integer between 0 and 1000/);
    });

    it('rejects total depth exceeding provider max', () => {
      const result = validateTraversalSpec(
        {
          ...validSpec,
          steps: [
            { direction: 'out', repeat: { maxDepth: 8 } },
            { direction: 'out', repeat: { maxDepth: 5 } },
          ],
        },
        undefined,
        { maxTraversalDepth: 10 } as never,
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/total potential depth 13 exceeds/);
    });
  });

  describe('vocabulary validation', () => {
    it('accepts valid vocabulary types', () => {
      const result = validateTraversalSpec(
        {
          ...validSpec,
          steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'], entityTypes: ['Component'] }],
        },
        mockVocabulary,
      );
      expect(result.valid).toBe(true);
    });

    it('rejects unknown relationship type', () => {
      const result = validateTraversalSpec(
        {
          ...validSpec,
          steps: [{ direction: 'out', relationshipTypes: ['UNKNOWN_TYPE'] }],
        },
        mockVocabulary,
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Unknown vocabulary types/);
      expect(result.errors[0]).toMatch(/UNKNOWN_TYPE/);
    });

    it('rejects unknown entity type in step', () => {
      const result = validateTraversalSpec(
        {
          ...validSpec,
          steps: [{ direction: 'out', entityTypes: ['UnknownEntity'] }],
        },
        mockVocabulary,
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/UnknownEntity/);
    });

    it('rejects unknown start entityType', () => {
      const result = validateTraversalSpec(
        {
          ...validSpec,
          start: { entityType: 'Unknown' },
          limit: 10,
        },
        mockVocabulary,
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/Unknown/);
    });

    it('collects multiple vocabulary errors', () => {
      const result = validateTraversalSpec(
        {
          ...validSpec,
          steps: [
            { direction: 'out', relationshipTypes: ['BAD_REL'], entityTypes: ['BadEntity'] },
          ],
        },
        mockVocabulary,
      );
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/BAD_REL/);
      expect(result.errors[0]).toMatch(/BadEntity/);
    });
  });

  describe('structure, bounds and identifiers', () => {
    // The identifier rule applies on every provider, including those that
    // bind or match names directly, so a spec behaves the same everywhere.
    it('rejects non-identifier names in every identifier position', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'a', filter: [{ key: 'start-date', operator: 'isNotNull' }] },
        steps: [
          {
            direction: 'out',
            relationshipTypes: ['2ND_DEGREE'],
            entityTypes: ['any-entity-type'],
            entityFilter: [{ key: 'größe', operator: 'gt', value: 1 }],
            relationshipFilter: [{ key: 'bad key', operator: 'eq', value: 'x' }],
            repeat: { maxDepth: 2, until: [{ key: 'start-date', operator: 'isNull' }] },
          },
        ],
        returnMode: 'terminal',
        projection: { properties: ['start-date'] },
      });
      // entityTypes are bound as parameter values everywhere, so they are not
      // held to the identifier rule.
      expect(result.errors).toEqual([
        expect.stringMatching(/^start\.filter\[0\]\.key "start-date" is not a safe identifier/),
        expect.stringMatching(/^steps\[0\]\.relationshipTypes\[0\] "2ND_DEGREE" is not a safe identifier/),
        expect.stringMatching(/^steps\[0\]\.entityFilter\[0\]\.key "größe" is not a safe identifier/),
        expect.stringMatching(/^steps\[0\]\.relationshipFilter\[0\]\.key "bad key" is not a safe identifier/),
        expect.stringMatching(/^steps\[0\]\.repeat\.until\[0\]\.key "start-date" is not a safe identifier/),
        expect.stringMatching(/^projection\.properties\[0\] "start-date" is not a safe identifier/),
      ]);
    });

    it.each([
      ['a relationship type', { relationshipTypes: ['KNOWS]-() WITH 1 AS x MATCH (m:_Entity) RETURN m //'] }],
      ['a filter key', { relationshipFilter: [{ key: 'id IS NOT NULL OR true OR n0.id', operator: 'eq' as const, value: 1 }] }],
    ])('rejects an injection string as %s', (_label, stepFields) => {
      const result = validateTraversalSpec({ ...validSpec, steps: [{ direction: 'out', ...stepFields }] });
      expect(result.errors).toEqual([expect.stringMatching(/is not a safe identifier/)]);
    });

    it('accepts safe identifiers in every identifier position', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'a', filter: [{ key: '_status', operator: 'eq', value: 'x' }] },
        steps: [
          {
            direction: 'out',
            relationshipTypes: ['HAS_COMPONENT'],
            entityFilter: [{ key: 'startDate', operator: 'isNotNull' }],
            relationshipFilter: [{ key: 'weight2', operator: 'gt', value: 1 }],
            repeat: { maxDepth: 2, until: [{ key: 'done', operator: 'eq', value: true }] },
          },
        ],
        returnMode: 'terminal',
        projection: { properties: ['startDate'] },
      });
      expect(result).toEqual({ valid: true, errors: [] });
    });

    it.each([
      ['a fractional depth', 1.5],
      ['a numeric string', asNumber('3')],
      ['NaN', Number.NaN],
      ['a negative depth', -1],
    ])('rejects repeat.maxDepth of %s', (_label, maxDepth) => {
      const result = validateTraversalSpec({
        ...validSpec,
        steps: [{ direction: 'out', repeat: { maxDepth } }],
      });
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.stringMatching(/^steps\[0\]\.repeat\.maxDepth must be a positive integer/),
      );
    });

    it('does not fold an invalid repeat depth into the total-depth sum', () => {
      const result = validateTraversalSpec({
        ...validSpec,
        steps: [
          { direction: 'out' },
          { direction: 'out', repeat: { maxDepth: asNumber('3') } },
        ],
      });
      // "1" + "3" would concatenate to 13 and trip the total-depth check.
      expect(result.errors.some((e) => e.includes('total potential depth'))).toBe(false);
      expect(result.errors).toHaveLength(1);
    });

    it.each([
      ['0', 0],
      ['1.5', 1.5],
      ['NaN', Number.NaN],
    ])('rejects spec.limit of %s', (_label, limit) => {
      const result = validateTraversalSpec({ ...validSpec, limit });
      expect(result.errors).toContainEqual(expect.stringMatching(/^limit must be an integer between 1 and 200/));
    });

    it.each([
      ['fractional', 0.5],
      ['above the cap', 1001],
    ])('rejects a %s spec.offset', (_label, offset) => {
      const result = validateTraversalSpec({ ...validSpec, offset });
      expect(result.errors).toContainEqual(expect.stringMatching(/^offset must be an integer between 0 and 1000/));
    });

    it('accepts spec.offset at the cap', () => {
      expect(validateTraversalSpec({ ...validSpec, offset: 1000 })).toEqual({ valid: true, errors: [] });
    });

    it('rejects a non-array steps and reports it once', () => {
      const result = validateTraversalSpec({ ...validSpec, steps: asSteps({ direction: 'out' }) });
      expect(result.errors).toEqual([expect.stringMatching(/^steps must be an array; got a value of type object/)]);
    });

    it('treats steps: null as no steps', () => {
      expect(validateTraversalSpec({ ...validSpec, steps: asSteps(null) })).toEqual({ valid: true, errors: [] });
    });

    it('rejects a null step element and keeps validating the others', () => {
      const result = validateTraversalSpec({
        ...validSpec,
        steps: [{ direction: 'out' }, asStep(null), { direction: 'out', repeat: { maxDepth: 1.5 } }],
      });
      expect(result.errors).toEqual([
        expect.stringMatching(/^steps\[1\] must be a step object; got null/),
        expect.stringMatching(/^steps\[2\]\.repeat\.maxDepth must be a positive integer/),
      ]);
    });

    it('does not trip over a null step element when a vocabulary is supplied', () => {
      const result = validateTraversalSpec({ ...validSpec, steps: [asStep(null)] }, mockVocabulary);
      expect(result.errors).toEqual([expect.stringMatching(/^steps\[0\] must be a step object/)]);
    });

    it('treats start.filter: null as absent', () => {
      expect(
        validateTraversalSpec({ ...validSpec, start: { entityId: 'a', filter: asFilters(null) } }),
      ).toEqual({ valid: true, errors: [] });
      const noStart = validateTraversalSpec({ ...validSpec, start: { filter: asFilters(null) } });
      expect(noStart.errors).toEqual(['start must have at least one of entityId, entityType, or filter']);
    });

    it('rejects malformed lists and filters', () => {
      const result = validateTraversalSpec({
        start: { entityId: 'a', filter: [asFilter(null)] },
        steps: [
          {
            direction: 'out',
            relationshipTypes: asStringList('KNOWS'),
            entityFilter: [{ key: 'name', operator: asOperator('like') }],
          },
        ],
        returnMode: 'terminal',
      });
      expect(result.errors).toEqual([
        expect.stringMatching(/^start\.filter\[0\] must be a property filter object; got null/),
        expect.stringMatching(/^steps\[0\]\.relationshipTypes must be an array of strings; got "KNOWS"/),
        expect.stringMatching(/^steps\[0\]\.entityFilter\[0\]\.operator must be one of/),
      ]);
    });
  });

  describe('validateExploreOptions', () => {
    it('accepts absent, null-defaulted and in-range options', () => {
      expect(validateExploreOptions().valid).toBe(true);
      expect(validateExploreOptions({ depth: asDepth(null) }).valid).toBe(true);
      expect(
        validateExploreOptions({
          depth: 3,
          relationshipTypes: ['KNOWS', 'works_at'],
          entityTypes: ['any-entity-type'],
          relationshipPropertyFilters: [{ key: 'startDate', operator: 'gte', value: 2020 }],
        }).valid,
      ).toBe(true);
    });

    it('rejects non-identifier relationship types and filter keys', () => {
      const result = validateExploreOptions({
        relationshipTypes: ['KNOWS', '2ND_DEGREE'],
        relationshipPropertyFilters: [{ key: 'start-date', operator: 'gte', value: 2020 }],
      });
      expect(result.errors).toEqual([
        expect.stringMatching(/^relationshipTypes\[1\] "2ND_DEGREE" is not a safe identifier/),
        expect.stringMatching(/^relationshipPropertyFilters\[0\]\.key "start-date" is not a safe identifier/),
      ]);
    });

    it.each([
      ['0', 0],
      ['4', 4],
      ['1.5', 1.5],
    ])('rejects depth %s', (_label, depth) => {
      const result = validateExploreOptions({ depth: asDepth(depth) });
      expect(result.errors).toEqual([expect.stringMatching(/^depth must be an integer between 1 and 3/)]);
    });

    it('rejects a non-array or non-string entityTypes', () => {
      expect(validateExploreOptions({ entityTypes: asStringList('person') }).errors).toEqual([
        expect.stringMatching(/^entityTypes must be an array of strings; got "person"/),
      ]);
      expect(validateExploreOptions({ entityTypes: [asString(1)] }).errors).toEqual([
        expect.stringMatching(/^entityTypes\[0\] must be a string; got 1/),
      ]);
      expect(validateExploreOptions({ entityTypes: ['person'] }).valid).toBe(true);
    });

    it('rejects a non-array relationshipTypes and a null filter element', () => {
      const result = validateExploreOptions({
        relationshipTypes: asStringList('KNOWS'),
        relationshipPropertyFilters: [asFilter(null)],
      });
      expect(result.errors).toEqual([
        expect.stringMatching(/^relationshipTypes must be an array of strings/),
        expect.stringMatching(/^relationshipPropertyFilters\[0\] must be a property filter object; got null/),
      ]);
    });
  });

  describe('validatePathOptions', () => {
    it('accepts absent, null-defaulted and in-range options', () => {
      expect(validatePathOptions().valid).toBe(true);
      expect(
        validatePathOptions({ maxDepth: asNumber(null), limit: asNumber(null), offset: asNumber(null) }).valid,
      ).toBe(true);
      expect(
        validatePathOptions({
          maxDepth: 5,
          limit: 200,
          offset: 1000,
          relationshipTypes: ['SECOND_DEGREE'],
          relationshipPropertyFilters: [{ key: 'since', operator: 'isNotNull' }],
        }).valid,
      ).toBe(true);
    });

    it('rejects non-identifier relationship types and filter keys', () => {
      const result = validatePathOptions({
        relationshipTypes: ['2ND_DEGREE'],
        relationshipPropertyFilters: [{ key: 'bad key', operator: 'isNotNull' }],
      });
      expect(result.errors).toEqual([
        expect.stringMatching(/^relationshipTypes\[0\] "2ND_DEGREE" is not a safe identifier/),
        expect.stringMatching(/^relationshipPropertyFilters\[0\]\.key "bad key" is not a safe identifier/),
      ]);
    });

    it.each([
      ['a fractional depth', 1.5],
      ['a numeric string', asNumber('3')],
      ['NaN', Number.NaN],
      ['zero', 0],
      ['6', 6],
    ])('rejects maxDepth of %s', (_label, maxDepth) => {
      const result = validatePathOptions({ maxDepth });
      expect(result.errors).toEqual([expect.stringMatching(/^maxDepth must be an integer between 1 and 5/)]);
    });

    it.each([
      ['0', 0],
      ['201', 201],
      ['1.5', 1.5],
    ])('rejects limit %s', (_label, limit) => {
      const result = validatePathOptions({ limit });
      expect(result.errors).toEqual([expect.stringMatching(/^limit must be an integer between 1 and 200/)]);
    });

    it.each([
      ['-1', -1],
      ['0.5', 0.5],
      ['1001', 1001],
    ])('rejects offset %s', (_label, offset) => {
      const result = validatePathOptions({ offset });
      expect(result.errors).toEqual([expect.stringMatching(/^offset must be an integer between 0 and 1000/)]);
    });

    it('rejects a non-array entityTypes', () => {
      expect(validatePathOptions({ entityTypes: asStringList('person') }).errors).toEqual([
        expect.stringMatching(/^entityTypes must be an array of strings/),
      ]);
      expect(validatePathOptions({ entityTypes: ['person'] }).valid).toBe(true);
    });

    it('rejects a non-string relationship type and a filter without a string key', () => {
      const result = validatePathOptions({
        relationshipTypes: [asString(42)],
        relationshipPropertyFilters: [{ key: asString(undefined), operator: 'isNull' }],
      });
      expect(result.errors).toEqual([
        expect.stringMatching(/^relationshipTypes\[0\] must be a string; got 42/),
        expect.stringMatching(/^relationshipPropertyFilters\[0\]\.key must be a string; got undefined/),
      ]);
    });
  });
});

// Untyped input (e.g. parsed JSON from a tool call) can carry values of the
// wrong runtime type into typed fields; these helpers model that.
function asString(value: string | number | undefined): string {
  return value as string;
}
function asStringList(value: string[] | string): string[] {
  return value as string[];
}
function asFilter(value: PropertyFilter | null): PropertyFilter {
  return value as PropertyFilter;
}
function asOperator(value: PropertyFilter['operator'] | string): PropertyFilter['operator'] {
  return value as PropertyFilter['operator'];
}
function asDepth(value: number | null): ExploreOptions['depth'] {
  return value as ExploreOptions['depth'];
}
function asFilters(value: PropertyFilter[] | null): PropertyFilter[] {
  return value as PropertyFilter[];
}
function asStep(value: TraversalStep | null): TraversalStep {
  return value as TraversalStep;
}
function asSteps(value: TraversalStep[] | TraversalStep | null): TraversalStep[] {
  return value as TraversalStep[];
}
