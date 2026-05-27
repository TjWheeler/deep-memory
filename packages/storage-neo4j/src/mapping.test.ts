import { describe, expect, it } from 'vitest';
import { ProviderError } from '@utaba/deep-memory';
import {
  bigintToSafeNumber,
  entityFromProperties,
  entityFromRecord,
  relationshipFromProperties,
  relationshipFromRecord,
  type DriverRecord,
} from './mapping.js';

// ─── Test fixtures ─────────────────────────────────────────────────

const FULL_ENTITY_PROPS: Record<string, unknown> = {
  repositoryId: 'repo-1',
  id: 'ent-1',
  slug: 'Person:alice',
  entityType: 'Person',
  label: 'Alice',
  summary: 'a person',
  properties: JSON.stringify({ role: 'engineer', age: 33 }),
  data: 'some-data',
  dataFormat: 'text/plain',
  embedding: [0.1, 0.2, 0.3],
  createdBy: 'tester',
  createdByType: 'agent',
  createdAt: '2026-05-27T00:00:00.000Z',
  createdInConversation: 'conv-1',
  createdFromMessage: 'msg-1',
  modifiedBy: 'tester',
  modifiedByType: 'agent',
  modifiedAt: '2026-05-27T01:00:00.000Z',
  modifiedInConversation: 'conv-2',
  modifiedFromMessage: 'msg-2',
};

const MIN_ENTITY_PROPS: Record<string, unknown> = {
  repositoryId: 'repo-1',
  id: 'ent-min',
  slug: 'Person:bob',
  entityType: 'Person',
  label: 'Bob',
  properties: '',
  createdBy: 'tester',
  createdByType: 'user',
  createdAt: '2026-05-27T00:00:00.000Z',
  modifiedBy: 'tester',
  modifiedByType: 'user',
  modifiedAt: '2026-05-27T00:00:00.000Z',
};

const FULL_REL_PROPS: Record<string, unknown> = {
  repositoryId: 'repo-1',
  id: 'rel-1',
  relationshipType: 'WORKS_AT',
  sourceEntityId: 'ent-alice',
  targetEntityId: 'ent-acme',
  properties: JSON.stringify({ role: 'senior engineer' }),
  bidirectional: false,
  createdBy: 'tester',
  createdByType: 'agent',
  createdAt: '2026-05-27T00:00:00.000Z',
  modifiedBy: 'tester',
  modifiedByType: 'agent',
  modifiedAt: '2026-05-27T00:00:00.000Z',
};

function recordFromProjection(props: Record<string, unknown>): DriverRecord {
  const keys = Object.keys(props);
  return {
    keys,
    get(key: string): unknown {
      return props[key];
    },
  };
}

function recordFromNode(alias: string, props: Record<string, unknown>): DriverRecord {
  const node = { properties: props, labels: ['_Entity'] };
  return {
    keys: [alias],
    get(key: string): unknown {
      return key === alias ? node : undefined;
    },
  };
}

function recordFromRelationship(alias: string, props: Record<string, unknown>): DriverRecord {
  const rel = { properties: props, type: props['relationshipType'] };
  return {
    keys: [alias],
    get(key: string): unknown {
      return key === alias ? rel : undefined;
    },
  };
}

// ─── bigintToSafeNumber ─────────────────────────────────────────────

describe('bigintToSafeNumber', () => {
  it('passes plain numbers through', () => {
    expect(bigintToSafeNumber(0)).toBe(0);
    expect(bigintToSafeNumber(42)).toBe(42);
    expect(bigintToSafeNumber(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('coerces safe-range bigints to numbers', () => {
    expect(bigintToSafeNumber(0n)).toBe(0);
    expect(bigintToSafeNumber(123n)).toBe(123);
    expect(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(bigintToSafeNumber(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
  });

  it('throws ProviderError when the bigint exceeds MAX_SAFE_INTEGER', () => {
    const over = BigInt(Number.MAX_SAFE_INTEGER) + 1n;
    expect(() => bigintToSafeNumber(over)).toThrowError(ProviderError);
  });

  it('throws ProviderError when the bigint is below MIN_SAFE_INTEGER', () => {
    const under = BigInt(Number.MIN_SAFE_INTEGER) - 1n;
    expect(() => bigintToSafeNumber(under)).toThrowError(ProviderError);
  });

  it('throws ProviderError on unsupported input types', () => {
    expect(() => bigintToSafeNumber('1' as unknown as number)).toThrowError(ProviderError);
    expect(() => bigintToSafeNumber(undefined as unknown as number)).toThrowError(ProviderError);
  });
});

// ─── entityFromProperties ──────────────────────────────────────────

describe('entityFromProperties', () => {
  it('maps a fully-populated property bag to StoredEntity', () => {
    const entity = entityFromProperties(FULL_ENTITY_PROPS);
    expect(entity).toEqual({
      id: 'ent-1',
      slug: 'Person:alice',
      entityType: 'Person',
      label: 'Alice',
      summary: 'a person',
      properties: { role: 'engineer', age: 33 },
      data: 'some-data',
      dataFormat: 'text/plain',
      embedding: [0.1, 0.2, 0.3],
      provenance: {
        createdBy: 'tester',
        createdByType: 'agent',
        createdAt: '2026-05-27T00:00:00.000Z',
        createdInConversation: 'conv-1',
        createdFromMessage: 'msg-1',
        modifiedBy: 'tester',
        modifiedByType: 'agent',
        modifiedAt: '2026-05-27T01:00:00.000Z',
        modifiedInConversation: 'conv-2',
        modifiedFromMessage: 'msg-2',
      },
    });
  });

  it('omits absent optional fields and parses an empty properties blob to {}', () => {
    const entity = entityFromProperties(MIN_ENTITY_PROPS);
    expect(entity).toEqual({
      id: 'ent-min',
      slug: 'Person:bob',
      entityType: 'Person',
      label: 'Bob',
      properties: {},
      provenance: {
        createdBy: 'tester',
        createdByType: 'user',
        createdAt: '2026-05-27T00:00:00.000Z',
        modifiedBy: 'tester',
        modifiedByType: 'user',
        modifiedAt: '2026-05-27T00:00:00.000Z',
      },
    });
    expect('summary' in entity).toBe(false);
    expect('data' in entity).toBe(false);
    expect('dataFormat' in entity).toBe(false);
    expect('embedding' in entity).toBe(false);
  });

  it('prefers the JSON properties blob over per-scalar copies (O1 resolution)', () => {
    // The schema stores indexed scalars separately AND a JSON blob; the JSON
    // blob is the source of truth so user-supplied keys round-trip even if
    // the scalar copies drift.
    const entity = entityFromProperties({
      ...FULL_ENTITY_PROPS,
      // The scalar entityType is "Person" but the JSON properties blob
      // intentionally does not include entityType — the mapper does not
      // confuse them.
      properties: JSON.stringify({ role: 'engineer', ageYears: 33 }),
    });
    expect(entity.properties).toEqual({ role: 'engineer', ageYears: 33 });
    expect(entity.entityType).toBe('Person');
  });

  it('throws ProviderError when a required field is missing', () => {
    const incomplete = { ...FULL_ENTITY_PROPS, id: undefined };
    expect(() => entityFromProperties(incomplete)).toThrowError(ProviderError);
  });

  it('throws ProviderError when createdByType is neither "user" nor "agent"', () => {
    const bad = { ...FULL_ENTITY_PROPS, createdByType: 'system' };
    expect(() => entityFromProperties(bad)).toThrowError(ProviderError);
  });

  it('throws ProviderError when properties is not a JSON string', () => {
    const bad = { ...FULL_ENTITY_PROPS, properties: 42 };
    expect(() => entityFromProperties(bad)).toThrowError(ProviderError);
  });

  it('throws ProviderError when properties JSON decodes to an array', () => {
    const bad = { ...FULL_ENTITY_PROPS, properties: '["not", "an", "object"]' };
    expect(() => entityFromProperties(bad)).toThrowError(ProviderError);
  });

  it('throws ProviderError when embedding contains a non-number', () => {
    const bad = { ...FULL_ENTITY_PROPS, embedding: [0.1, 'oops', 0.3] };
    expect(() => entityFromProperties(bad)).toThrowError(ProviderError);
  });
});

// ─── relationshipFromProperties ────────────────────────────────────

describe('relationshipFromProperties', () => {
  it('maps a fully-populated property bag to StoredRelationship', () => {
    const rel = relationshipFromProperties(FULL_REL_PROPS);
    expect(rel).toEqual({
      id: 'rel-1',
      relationshipType: 'WORKS_AT',
      sourceEntityId: 'ent-alice',
      targetEntityId: 'ent-acme',
      properties: { role: 'senior engineer' },
      bidirectional: false,
      provenance: {
        createdBy: 'tester',
        createdByType: 'agent',
        createdAt: '2026-05-27T00:00:00.000Z',
        modifiedBy: 'tester',
        modifiedByType: 'agent',
        modifiedAt: '2026-05-27T00:00:00.000Z',
      },
    });
  });

  it('throws ProviderError when bidirectional is not a boolean', () => {
    const bad = { ...FULL_REL_PROPS, bidirectional: 'false' };
    expect(() => relationshipFromProperties(bad)).toThrowError(ProviderError);
  });
});

// ─── entityFromRecord / relationshipFromRecord ─────────────────────

describe('entityFromRecord', () => {
  it('reads from a `RETURN n` shape (node alias resolves to a Node-like)', () => {
    const record = recordFromNode('n', FULL_ENTITY_PROPS);
    expect(entityFromRecord(record).id).toBe('ent-1');
  });

  it('reads from an explicit projection (one record key per field)', () => {
    const record = recordFromProjection(FULL_ENTITY_PROPS);
    expect(entityFromRecord(record).id).toBe('ent-1');
  });

  it('reads under a custom alias (e.g. `node` from the fulltext branch)', () => {
    const record = recordFromNode('node', FULL_ENTITY_PROPS);
    expect(entityFromRecord(record, 'node').id).toBe('ent-1');
  });
});

describe('relationshipFromRecord', () => {
  it('reads from a `RETURN r` shape (relationship alias resolves to Relationship-like)', () => {
    const record = recordFromRelationship('r', FULL_REL_PROPS);
    expect(relationshipFromRecord(record).id).toBe('rel-1');
  });

  it('reads from an explicit projection', () => {
    const record = recordFromProjection(FULL_REL_PROPS);
    expect(relationshipFromRecord(record).id).toBe('rel-1');
  });
});
