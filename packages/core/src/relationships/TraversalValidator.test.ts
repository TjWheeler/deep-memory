import { describe, it, expect } from 'vitest';
import { validateTraversalSpec } from './TraversalValidator.js';
import type { TraversalSpec } from '../types/traversal.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';

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
      expect(result.errors[0]).toMatch(/maxDepth must be a positive number/);
    });

    it('rejects limit out of bounds', () => {
      const result = validateTraversalSpec({ ...validSpec, limit: 300 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/limit must be between 1 and 200/);
    });

    it('rejects negative offset', () => {
      const result = validateTraversalSpec({ ...validSpec, offset: -1 });
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toMatch(/offset must be >= 0/);
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
});
