import { describe, it, expect } from 'vitest';
import { validateProperties, applyPropertyDefaults } from './validation.js';
import type { PropertySchema } from '../types/vocabulary.js';

const schemas: PropertySchema[] = [
  { name: 'name', type: 'string', required: true },
  { name: 'age', type: 'number', required: false, defaultValue: 0 },
  { name: 'active', type: 'boolean', required: false, defaultValue: true },
];

describe('validateProperties', () => {
  it('passes valid properties', () => {
    const result = validateProperties({ name: 'Tim', age: 30 }, schemas);
    expect(result.valid).toBe(true);
  });

  it('fails missing required property', () => {
    const result = validateProperties({ age: 30 }, schemas);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('name'))).toBe(true);
  });

  it('fails wrong type', () => {
    const result = validateProperties({ name: 42 }, schemas);
    expect(result.valid).toBe(false);
  });
});

describe('applyPropertyDefaults', () => {
  it('fills in missing properties with defaults', () => {
    const result = applyPropertyDefaults({ name: 'Tim' }, schemas);
    expect(result.name).toBe('Tim');
    expect(result.age).toBe(0);
    expect(result.active).toBe(true);
  });

  it('does not overwrite existing values', () => {
    const result = applyPropertyDefaults({ name: 'Tim', age: 30 }, schemas);
    expect(result.age).toBe(30);
  });

  it('returns a new object (does not mutate input)', () => {
    const input = { name: 'Tim' };
    const result = applyPropertyDefaults(input, schemas);
    expect(input).not.toHaveProperty('age');
    expect(result).toHaveProperty('age');
  });
});
