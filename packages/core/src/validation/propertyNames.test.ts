import { describe, it, expect } from 'vitest';
import {
  RESERVED_ENTITY_PROPERTY_KEYS,
  RESERVED_RELATIONSHIP_PROPERTY_KEYS,
  assertWritablePropertyKeys,
  isReservedPropertyName,
  propertyNameRefusal,
} from './propertyNames.js';
import { InvalidInputError } from '../core/errors.js';

describe('reserved property names', () => {
  it.each(['id', 'repositoryId', 'label', 'properties', 'createdBy', 'createdInConversation', 'modifiedFromMessage', '_attempt'])(
    'reserves %s on entities and relationships',
    (name) => {
      expect(isReservedPropertyName(name, 'entity')).toBe(true);
      expect(isReservedPropertyName(name, 'relationship')).toBe(true);
    },
  );

  it.each(['entityType', 'entityLabel', 'slug', 'summary', 'data', 'dataFormat', 'embedding'])(
    'reserves %s on entities only',
    (name) => {
      expect(isReservedPropertyName(name, 'entity')).toBe(true);
      expect(isReservedPropertyName(name, 'relationship')).toBe(false);
    },
  );

  it.each(['relationshipType', 'sourceEntityId', 'targetEntityId', 'bidirectional'])(
    'reserves %s on relationships only',
    (name) => {
      expect(isReservedPropertyName(name, 'relationship')).toBe(true);
      expect(isReservedPropertyName(name, 'entity')).toBe(false);
    },
  );

  it('exports the same sets the guards apply', () => {
    for (const name of RESERVED_ENTITY_PROPERTY_KEYS) {
      expect(isReservedPropertyName(name, 'entity')).toBe(true);
    }
    for (const name of RESERVED_RELATIONSHIP_PROPERTY_KEYS) {
      expect(isReservedPropertyName(name, 'relationship')).toBe(true);
    }
  });

  it('is not weakened by mutating the exported sets', () => {
    const exported = RESERVED_ENTITY_PROPERTY_KEYS as Set<string>;
    exported.delete('label');
    try {
      expect(isReservedPropertyName('label', 'entity')).toBe(true);
    } finally {
      exported.add('label');
    }
  });
});

describe('propertyNameRefusal', () => {
  it('accepts identifier-shaped names that are not reserved', () => {
    expect(propertyNameRefusal('startDate', 'entity')).toBeUndefined();
    expect(propertyNameRefusal('_internalNote', 'relationship')).toBeUndefined();
  });

  it.each(['start-date', '2fast', 'first name', 'a.b', ''])('refuses non-identifier %j', (name) => {
    expect(propertyNameRefusal(name, 'entity')).toMatch(/not a valid identifier/);
  });

  it('refuses a reserved name, naming the owner', () => {
    expect(propertyNameRefusal('label', 'entity')).toMatch(/reserved for a system field on every entity/);
    expect(propertyNameRefusal('label', 'relationship')).toMatch(/reserved for a system field on every relationship/);
  });
});

describe('assertWritablePropertyKeys', () => {
  it('accepts absent or empty properties', () => {
    expect(() => assertWritablePropertyKeys(undefined, 'entity')).not.toThrow();
    expect(() => assertWritablePropertyKeys(null, 'entity')).not.toThrow();
    expect(() => assertWritablePropertyKeys({}, 'relationship')).not.toThrow();
  });

  it('accepts valid keys', () => {
    expect(() => assertWritablePropertyKeys({ startDate: '2026-10-02', count: 3 }, 'entity')).not.toThrow();
  });

  it('throws InvalidInputError naming the refused key', () => {
    let caught: InvalidInputError | undefined;
    try {
      assertWritablePropertyKeys({ ok: 1, 'start-date': '2026-10-02' }, 'entity');
    } catch (err) {
      if (err instanceof InvalidInputError) caught = err;
    }
    expect(caught).toBeInstanceOf(InvalidInputError);
    expect(caught?.code).toBe('INVALID_INPUT');
    expect(caught?.field).toBe('properties.start-date');
  });

  it('refuses a reserved key even when its value is null', () => {
    expect(() => assertWritablePropertyKeys({ slug: null }, 'entity')).toThrow(InvalidInputError);
  });

  it('applies the owner-specific reserved set', () => {
    expect(() => assertWritablePropertyKeys({ summary: 'x' }, 'relationship')).not.toThrow();
    expect(() => assertWritablePropertyKeys({ summary: 'x' }, 'entity')).toThrow(InvalidInputError);
  });
});
