import { describe, it, expect } from 'vitest';
import { Validator } from './Validator.js';
import type { ValidationRules } from '../types/validation.js';
import type { ExtractionOutput } from '../types/extraction.js';

const MINING_VOCABULARY = `
# Mining Equipment Knowledge Graph Vocabulary

## Entity Types

### Equipment
Mining equipment models

### Manufacturer
Equipment manufacturers

### Component
Systems and sub-components

### Fluid
Oils, coolants, lubricants

## Relationship Types

### MANUFACTURED_BY
Links Equipment to Manufacturer

### HAS_COMPONENT
Links Equipment to Component

### COMPATIBLE_WITH
Links Equipment to Equipment (truck-shovel matching)

### REQUIRES_FLUID
Links Equipment/Component to Fluid
`;

const MINING_RULES: ValidationRules = {
  version: '1.0.0',
  domain: 'mining-equipment',
  propertyRanges: {
    Equipment: {
      operatingWeight: { type: 'number', unit: 'MT', min: 0.1, max: 1000 },
      enginePower: { type: 'number', unit: 'kW', min: 10, max: 5000 },
      bucketCapacity: { type: 'number', unit: 'm³', min: 0.1, max: 100 },
    },
    Component: {
      pressure: { type: 'number', unit: 'bar', min: 1, max: 1000 },
      quantity: { type: 'integer', min: 1, max: 100 },
    },
  },
  relationshipRanges: {
    COMPATIBLE_WITH: {
      passCount: { type: 'integer', min: 2, max: 8 },
      bucketFillFactor: { type: 'percentage', min: 50, max: 120 },
    },
  },
  structuralRules: {
    requiredRelationships: {
      Equipment: ['MANUFACTURED_BY'],
    },
    noOrphans: true,
    maxEntitiesPerExtraction: 200,
    maxRelationshipsPerExtraction: 500,
  },
};

function makeExtraction(overrides?: Partial<ExtractionOutput>): ExtractionOutput {
  return {
    source: 'test-doc.md',
    sourcePath: '/tmp/test-doc.md',
    extractedAt: '2026-04-03T00:00:00Z',
    extractedBy: 'test-worker',
    entities: [
      {
        entityType: 'Equipment',
        label: 'Komatsu PC4000-11',
        summary: 'Hydraulic mining shovel',
        properties: { operatingWeight: 398 },
        aliases: [],
        sourceRefs: [{ description: 'Spec section', lineStart: 1, lineEnd: 50 }],
      },
      {
        entityType: 'Manufacturer',
        label: 'Komatsu',
        summary: 'Japanese manufacturer',
        properties: {},
        aliases: [],
        sourceRefs: [{ description: 'Header', lineStart: 1, lineEnd: 5 }],
      },
    ],
    relationships: [
      {
        type: 'MANUFACTURED_BY',
        sourceLabel: 'Komatsu PC4000-11',
        targetLabel: 'Komatsu',
        properties: {},
        sourceRefs: [{ description: 'Manufacturer ref', lineStart: 1, lineEnd: 3 }],
      },
    ],
    ...overrides,
  };
}

describe('Validator', () => {
  describe('valid extraction passes all checks', () => {
    it('returns pass verdict with no errors or warnings', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const result = validator.validate(makeExtraction());

      expect(result.overallVerdict).toBe('pass');
      expect(result.errors).toHaveLength(0);
      expect(result.tier1.passed).toBe(true);
      expect(result.tier1.schemaErrors).toBe(0);
      expect(result.tier1.rangeViolations).toBe(0);
    });
  });

  describe('schema validation', () => {
    it('flags unknown entity types', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Vehicle',
            label: 'Unknown Thing',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 2 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.overallVerdict).toBe('fail');
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          tier: 1,
          severity: 'error',
          message: expect.stringContaining('Unknown entity type "Vehicle"'),
        }),
      );
    });

    it('flags unknown relationship types', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction();
      extraction.relationships.push({
        type: 'INVENTED_BY',
        sourceLabel: 'Komatsu PC4000-11',
        targetLabel: 'Komatsu',
        properties: {},
        sourceRefs: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Unknown relationship type "INVENTED_BY"'),
        }),
      );
    });

    it('flags empty entity label', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: '',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 2 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining('empty label') }),
      );
    });

    it('flags relationship referencing non-existent entity', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction();
      extraction.relationships.push({
        type: 'MANUFACTURED_BY',
        sourceLabel: 'Non-existent Machine',
        targetLabel: 'Komatsu',
        properties: {},
        sourceRefs: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('source "Non-existent Machine" not found'),
        }),
      );
    });
  });

  describe('range validation', () => {
    it('catches passCount: 300 (the motivating bug)', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Komatsu PC4000-11',
            properties: { operatingWeight: 398 },
            aliases: [],
            sourceRefs: [{ description: 'Spec', lineStart: 1, lineEnd: 50 }],
          },
          {
            entityType: 'Equipment',
            label: 'HD1500',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'Truck spec', lineStart: 51, lineEnd: 100 }],
          },
          {
            entityType: 'Manufacturer',
            label: 'Komatsu',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'Header', lineStart: 1, lineEnd: 5 }],
          },
        ],
        relationships: [
          {
            type: 'COMPATIBLE_WITH',
            sourceLabel: 'Komatsu PC4000-11',
            targetLabel: 'HD1500',
            properties: { passCount: 300, bucketFillFactor: '90%' },
            sourceRefs: [{ description: 'Matching chart', lineStart: 200, lineEnd: 240 }],
          },
          {
            type: 'MANUFACTURED_BY',
            sourceLabel: 'Komatsu PC4000-11',
            targetLabel: 'Komatsu',
            properties: {},
            sourceRefs: [],
          },
          {
            type: 'MANUFACTURED_BY',
            sourceLabel: 'HD1500',
            targetLabel: 'Komatsu',
            properties: {},
            sourceRefs: [],
          },
        ],
      });

      const result = validator.validate(extraction);

      // passCount: 300 should be caught as exceeding max of 8
      const passCountError = result.errors.find(
        e => e.property === 'passCount' && e.message.includes('exceeds maximum'),
      );
      expect(passCountError).toBeDefined();
      expect(passCountError!.extractedValue).toBe(300);
      expect(passCountError!.expectedRange).toContain('[2–8]');
    });

    it('accepts values within range', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'PC4000-11',
            properties: { operatingWeight: 398, enginePower: 1400 },
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
          {
            entityType: 'Manufacturer',
            label: 'Komatsu',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 5 }],
          },
        ],
        relationships: [
          {
            type: 'MANUFACTURED_BY',
            sourceLabel: 'PC4000-11',
            targetLabel: 'Komatsu',
            properties: {},
            sourceRefs: [],
          },
        ],
      });

      const result = validator.validate(extraction);
      const rangeErrors = result.errors.filter(e => e.message.includes('[range]'));
      expect(rangeErrors).toHaveLength(0);
    });

    it('catches values below minimum', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Tiny Shovel',
            properties: { operatingWeight: 0.01 },
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          property: 'operatingWeight',
          message: expect.stringContaining('below minimum'),
        }),
      );
    });

    it('validates integer type', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Component',
            label: 'Hydraulic Pump',
            properties: { quantity: 2.5 },
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          property: 'quantity',
          message: expect.stringContaining('should be an integer'),
        }),
      );
    });

    it('parses numeric values from strings with units', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Big Shovel',
            properties: { operatingWeight: '398 MT' },
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      // 398 is within range, so no range errors
      const rangeErrors = result.errors.filter(e => e.property === 'operatingWeight');
      expect(rangeErrors).toHaveLength(0);
    });

    it('parses percentage strings', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Shovel A',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
          {
            entityType: 'Equipment',
            label: 'Truck A',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 11, lineEnd: 20 }],
          },
        ],
        relationships: [
          {
            type: 'COMPATIBLE_WITH',
            sourceLabel: 'Shovel A',
            targetLabel: 'Truck A',
            properties: { bucketFillFactor: '90%', passCount: 5 },
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 20 }],
          },
        ],
      });

      const result = validator.validate(extraction);
      // 90% is within 50-120 range, passCount 5 is within 2-8 range
      const rangeErrors = result.errors.filter(e => e.message.includes('[range]'));
      expect(rangeErrors).toHaveLength(0);
    });
  });

  describe('structural validation', () => {
    it('flags entities without sourceRefs', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Mystery Machine',
            properties: {},
            aliases: [],
            sourceRefs: [],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('no sourceRefs'),
        }),
      );
    });

    it('flags invalid sourceRef line ranges', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Bad Refs',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'backwards', lineStart: 50, lineEnd: 10 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('lineStart (50) > lineEnd (10)'),
        }),
      );
    });

    it('flags orphan entities when noOrphans is true', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Lonely Machine',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Orphan entity'),
        }),
      );
    });

    it('flags missing required relationships', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Unlinked Shovel',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
          {
            entityType: 'Component',
            label: 'Engine',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 11, lineEnd: 20 }],
          },
        ],
        relationships: [
          {
            type: 'HAS_COMPONENT',
            sourceLabel: 'Unlinked Shovel',
            targetLabel: 'Engine',
            properties: {},
            sourceRefs: [],
          },
        ],
      });

      const result = validator.validate(extraction);
      // Equipment "Unlinked Shovel" should be missing MANUFACTURED_BY
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('missing required relationship MANUFACTURED_BY'),
        }),
      );
    });

    it('warns on duplicate entities', () => {
      const validator = new Validator(MINING_RULES, MINING_VOCABULARY);
      const extraction = makeExtraction({
        entities: [
          {
            entityType: 'Equipment',
            label: 'Duplicate',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 1, lineEnd: 10 }],
          },
          {
            entityType: 'Equipment',
            label: 'Duplicate',
            properties: {},
            aliases: [],
            sourceRefs: [{ description: 'test', lineStart: 11, lineEnd: 20 }],
          },
        ],
        relationships: [],
      });

      const result = validator.validate(extraction);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          message: expect.stringContaining('Duplicate entity'),
        }),
      );
    });
  });
});
