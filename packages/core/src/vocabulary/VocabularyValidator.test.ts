import { describe, it, expect } from 'vitest';
import {
  validateEntity,
  validateEntityUpdate,
  validateRelationship,
  validatePropertyValue,
  validatePropertySchema,
  getEntityTypeDef,
  getRelationshipTypeDef,
} from './VocabularyValidator.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import { buildVocabulary } from './VocabularySchema.js';

function createTestVocabulary(): MemoryVocabulary {
  return buildVocabulary(
    {
      entityTypes: [
        {
          type: 'person',
          description: 'A person',
          properties: [
            { name: 'role', type: 'string', required: true },
            { name: 'age', type: 'number', required: false },
            { name: 'active', type: 'boolean', required: false },
            { name: 'startDate', type: 'date', required: false },
            {
              name: 'priority',
              type: 'enum',
              required: false,
              enumValues: ['low', 'medium', 'high'],
            },
          ],
        },
        {
          type: 'project',
          description: 'A project',
          properties: [{ name: 'name', type: 'string', required: true }],
        },
      ],
      relationshipTypes: [
        {
          type: 'works_on',
          description: 'Person works on a project',
          allowedSourceTypes: ['person'],
          allowedTargetTypes: ['project'],
        },
        {
          type: 'colleague',
          description: 'Colleague relationship',
          allowedSourceTypes: ['person'],
          allowedTargetTypes: ['person'],
          bidirectional: true,
        },
      ],
    },
    'test',
  );
}

describe('validatePropertyValue', () => {
  it('passes valid string', () => {
    const result = validatePropertyValue('name', 'Tim', {
      name: 'name',
      type: 'string',
      required: true,
    });
    expect(result.valid).toBe(true);
  });

  it('fails invalid string', () => {
    const result = validatePropertyValue('name', 42, {
      name: 'name',
      type: 'string',
      required: true,
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('properties.name');
  });

  it('passes valid number', () => {
    const result = validatePropertyValue('age', 30, {
      name: 'age',
      type: 'number',
      required: false,
    });
    expect(result.valid).toBe(true);
  });

  it('fails NaN as number', () => {
    const result = validatePropertyValue('age', NaN, {
      name: 'age',
      type: 'number',
      required: false,
    });
    expect(result.valid).toBe(false);
  });

  it('passes valid boolean', () => {
    const result = validatePropertyValue('active', true, {
      name: 'active',
      type: 'boolean',
      required: false,
    });
    expect(result.valid).toBe(true);
  });

  it('fails string as boolean', () => {
    const result = validatePropertyValue('active', 'yes', {
      name: 'active',
      type: 'boolean',
      required: false,
    });
    expect(result.valid).toBe(false);
  });

  it('passes valid date', () => {
    const result = validatePropertyValue('startDate', '2026-03-28T00:00:00Z', {
      name: 'startDate',
      type: 'date',
      required: false,
    });
    expect(result.valid).toBe(true);
  });

  it('fails invalid date', () => {
    const result = validatePropertyValue('startDate', 'not-a-date', {
      name: 'startDate',
      type: 'date',
      required: false,
    });
    expect(result.valid).toBe(false);
  });

  it('passes valid enum value', () => {
    const result = validatePropertyValue('priority', 'high', {
      name: 'priority',
      type: 'enum',
      required: false,
      enumValues: ['low', 'medium', 'high'],
    });
    expect(result.valid).toBe(true);
  });

  it('fails invalid enum value with suggestion', () => {
    const result = validatePropertyValue('priority', 'critical', {
      name: 'priority',
      type: 'enum',
      required: false,
      enumValues: ['low', 'medium', 'high'],
    });
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.suggestion).toContain('low');
  });

  it('fails missing required property', () => {
    const result = validatePropertyValue('name', undefined, {
      name: 'name',
      type: 'string',
      required: true,
    });
    expect(result.valid).toBe(false);
  });

  it('passes missing optional property', () => {
    const result = validatePropertyValue('age', undefined, {
      name: 'age',
      type: 'number',
      required: false,
    });
    expect(result.valid).toBe(true);
  });
});

describe('validateEntity', () => {
  const vocab = createTestVocabulary();

  it('passes valid entity', () => {
    const result = validateEntity(
      { entityType: 'person', label: 'Tim', properties: { role: 'engineer' } },
      vocab,
    );
    expect(result.valid).toBe(true);
  });

  it('fails unknown entity type', () => {
    const result = validateEntity(
      { entityType: 'vehicle', label: 'Car' },
      vocab,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('entityType');
    expect(result.errors[0]!.message).toContain('vehicle');
  });

  it('provides suggestion for unknown type', () => {
    const result = validateEntity(
      { entityType: 'proj', label: 'Test' },
      vocab,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.suggestion).toBeTruthy();
  });

  it('fails missing required properties', () => {
    const result = validateEntity(
      { entityType: 'person', label: 'Tim', properties: {} },
      vocab,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('role'))).toBe(true);
  });

  it('fails empty label', () => {
    const result = validateEntity(
      { entityType: 'person', label: '  ', properties: { role: 'engineer' } },
      vocab,
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('label');
  });

  it('fails unknown properties', () => {
    const result = validateEntity(
      {
        entityType: 'person',
        label: 'Tim',
        properties: { role: 'engineer', unknown_prop: 'value' },
      },
      vocab,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('unknown_prop'))).toBe(true);
  });

  it('fails wrong property type', () => {
    const result = validateEntity(
      { entityType: 'person', label: 'Tim', properties: { role: 42 } },
      vocab,
    );
    expect(result.valid).toBe(false);
  });
});

describe('validateEntityUpdate', () => {
  const vocab = createTestVocabulary();
  const personType = vocab.entityTypes.find((et) => et.type === 'person')!;

  it('passes valid update', () => {
    const result = validateEntityUpdate({ label: 'New Name' }, personType, vocab);
    expect(result.valid).toBe(true);
  });

  it('passes valid property update', () => {
    const result = validateEntityUpdate({ properties: { role: 'manager' } }, personType, vocab);
    expect(result.valid).toBe(true);
  });

  it('fails empty label', () => {
    const result = validateEntityUpdate({ label: '' }, personType, vocab);
    expect(result.valid).toBe(false);
  });

  it('fails unknown property in update', () => {
    const result = validateEntityUpdate({ properties: { nonexistent: 'val' } }, personType, vocab);
    expect(result.valid).toBe(false);
  });

  it('fails wrong type in property update', () => {
    const result = validateEntityUpdate({ properties: { age: 'not-a-number' } }, personType, vocab);
    expect(result.valid).toBe(false);
  });

  it('passes a valid entityType change', () => {
    const result = validateEntityUpdate({ entityType: 'project' }, personType, vocab);
    expect(result.valid).toBe(true);
  });

  it('fails when new entityType does not exist in vocabulary', () => {
    const result = validateEntityUpdate({ entityType: 'not-a-type' }, personType, vocab);
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.field).toBe('entityType');
  });

  it('validates properties against the new type when entityType changes', () => {
    // `role` is valid on `person` but not on `project` (per the test vocabulary).
    const result = validateEntityUpdate(
      { entityType: 'project', properties: { role: 'manager' } },
      personType,
      vocab,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'properties.role')).toBe(true);
  });
});

describe('validateRelationship', () => {
  const vocab = createTestVocabulary();

  it('passes valid relationship', () => {
    const result = validateRelationship(
      { relationshipType: 'works_on', sourceEntityId: 'p1', targetEntityId: 'p2' },
      vocab,
      'person',
      'project',
    );
    expect(result.valid).toBe(true);
  });

  it('fails unknown relationship type', () => {
    const result = validateRelationship(
      { relationshipType: 'unknown_rel', sourceEntityId: 'p1', targetEntityId: 'p2' },
      vocab,
      'person',
      'project',
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.field).toBe('relationshipType');
  });

  it('fails invalid source entity type', () => {
    const result = validateRelationship(
      { relationshipType: 'works_on', sourceEntityId: 'p1', targetEntityId: 'p2' },
      vocab,
      'project', // project cannot be source of works_on
      'project',
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.suggestion).toContain('person');
  });

  it('fails invalid target entity type', () => {
    const result = validateRelationship(
      { relationshipType: 'works_on', sourceEntityId: 'p1', targetEntityId: 'p2' },
      vocab,
      'person',
      'person', // person cannot be target of works_on
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]!.suggestion).toContain('project');
  });
});

describe('getEntityTypeDef / getRelationshipTypeDef', () => {
  const vocab = createTestVocabulary();

  it('finds existing entity type', () => {
    expect(getEntityTypeDef('person', vocab)).not.toBeNull();
  });

  it('returns null for missing entity type', () => {
    expect(getEntityTypeDef('vehicle', vocab)).toBeNull();
  });

  it('finds existing relationship type', () => {
    expect(getRelationshipTypeDef('works_on', vocab)).not.toBeNull();
  });

  it('returns null for missing relationship type', () => {
    expect(getRelationshipTypeDef('drives', vocab)).toBeNull();
  });
});

describe('validatePropertySchema', () => {
  it('passes a string property without embeddable', () => {
    const result = validatePropertySchema({ name: 'title', type: 'string', required: false });
    expect(result.valid).toBe(true);
  });

  it('passes a string property with embeddable: true', () => {
    const result = validatePropertySchema({ name: 'content', type: 'string', required: false, embeddable: true });
    expect(result.valid).toBe(true);
  });

  it('rejects embeddable on a number property', () => {
    const result = validatePropertySchema({ name: 'count', type: 'number', required: false, embeddable: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/cannot be embeddable/);
    expect(result.errors[0]?.message).toMatch(/"count"/);
  });

  it('rejects embeddable on a boolean property', () => {
    const result = validatePropertySchema({ name: 'active', type: 'boolean', required: false, embeddable: true });
    expect(result.valid).toBe(false);
    expect(result.errors[0]?.message).toMatch(/cannot be embeddable/);
  });

  it('rejects embeddable on a date property', () => {
    const result = validatePropertySchema({ name: 'startDate', type: 'date', required: false, embeddable: true });
    expect(result.valid).toBe(false);
  });

  it('rejects embeddable on an enum property', () => {
    const result = validatePropertySchema({ name: 'status', type: 'enum', required: false, enumValues: ['a', 'b'], embeddable: true });
    expect(result.valid).toBe(false);
  });
});
