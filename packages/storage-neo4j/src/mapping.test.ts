import { describe, expect, it } from 'vitest';
import { InvalidInputError, ProviderError, RESERVED_ENTITY_PROPERTY_KEYS } from '@utaba/deep-memory';
import type { StoredEntity, StoredRelationship, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import {
  assertSafeRelationshipType,
  assertSafeUserPropertyKey,
  bigintToSafeNumber,
  buildRelationshipProjection,
  changeRecordFromProperties,
  changeRecordToProperties,
  entityFromProperties,
  entityFromRecord,
  entityToParams,
  entityUpdatePropertyParams,
  entityUserPropertyParams,
  isNativeStorableValue,
  relationshipFromProperties,
  relationshipFromRecord,
  relationshipToParams,
  repositoryFromRecord,
  STORED_ENTITY_FIELDS,
  STORED_RELATIONSHIP_FIELDS,
  WRITE_ATTEMPT_PROPERTY,
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

  it('prefers the JSON properties blob over per-scalar copies', () => {
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

// ─── relationshipToParams ───────────────────────────────────────────

describe('relationshipToParams', () => {
  const fullRel: StoredRelationship = {
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
      createdInConversation: 'conv-1',
      createdFromMessage: 'msg-1',
      modifiedBy: 'tester',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-27T01:00:00.000Z',
      modifiedInConversation: 'conv-2',
      modifiedFromMessage: 'msg-2',
    },
  };

  it('emits a binding per relationship field, JSON-stringifying properties', () => {
    expect(relationshipToParams(fullRel)).toEqual({
      id: 'rel-1',
      relationshipType: 'WORKS_AT',
      sourceEntityId: 'ent-alice',
      targetEntityId: 'ent-acme',
      properties: JSON.stringify({ role: 'senior engineer' }),
      bidirectional: false,
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
    });
  });

  it('binds absent optional provenance fields as null (Neo4j drops null on write)', () => {
    const minimal: StoredRelationship = {
      id: 'rel-min',
      relationshipType: 'CONNECTS',
      sourceEntityId: 'a',
      targetEntityId: 'b',
      properties: {},
      bidirectional: true,
      provenance: {
        createdBy: 't',
        createdByType: 'user',
        createdAt: '2026-05-27T00:00:00.000Z',
        modifiedBy: 't',
        modifiedByType: 'user',
        modifiedAt: '2026-05-27T00:00:00.000Z',
      },
    };
    const params = relationshipToParams(minimal);
    expect(params.createdInConversation).toBeNull();
    expect(params.createdFromMessage).toBeNull();
    expect(params.modifiedInConversation).toBeNull();
    expect(params.modifiedFromMessage).toBeNull();
    expect(params.bidirectional).toBe(true);
    expect(params.properties).toBe('{}');
  });
});

// ─── buildRelationshipProjection ────────────────────────────────────

describe('buildRelationshipProjection', () => {
  it('emits one `r.<field> AS <field>` per stored relationship field', () => {
    const projection = buildRelationshipProjection();
    for (const field of STORED_RELATIONSHIP_FIELDS) {
      expect(projection).toContain(`r.${field} AS ${field}`);
    }
  });

  it('respects a custom alias for UNION branches', () => {
    const projection = buildRelationshipProjection({ alias: 'rel' });
    expect(projection.startsWith('rel.id AS id')).toBe(true);
    expect(projection).not.toContain('r.id');
  });
});

// ─── User-property write split ──────────────────────────────────────

describe('assertSafeUserPropertyKey', () => {
  it('accepts bare Cypher identifiers that do not collide with reserved schema fields', () => {
    expect(assertSafeUserPropertyKey('city')).toBe('city');
    expect(assertSafeUserPropertyKey('age')).toBe('age');
    expect(assertSafeUserPropertyKey('_private')).toBe('_private');
    expect(assertSafeUserPropertyKey('field42')).toBe('field42');
  });

  it('rejects keys that are not bare Cypher identifiers', () => {
    expect(() => assertSafeUserPropertyKey('has-dash')).toThrowError(InvalidInputError);
    expect(() => assertSafeUserPropertyKey('has space')).toThrowError(InvalidInputError);
    expect(() => assertSafeUserPropertyKey('1leading-digit')).toThrowError(InvalidInputError);
    expect(() => assertSafeUserPropertyKey('')).toThrowError(InvalidInputError);
    expect(() => assertSafeUserPropertyKey('a.b')).toThrowError(InvalidInputError);
  });

  it('rejects keys that collide with reserved schema field names', () => {
    for (const reserved of RESERVED_ENTITY_PROPERTY_KEYS) {
      expect(() => assertSafeUserPropertyKey(reserved)).toThrowError(InvalidInputError);
    }
  });

  it('names the refused key as the input field, with code INVALID_INPUT', () => {
    expect(() => assertSafeUserPropertyKey('has-dash')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', field: 'properties.has-dash' }),
    );
    expect(() => assertSafeUserPropertyKey('label')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', field: 'properties.label' }),
    );
  });
});

describe('isNativeStorableValue', () => {
  it('accepts scalars Neo4j can store as native properties', () => {
    expect(isNativeStorableValue('hello')).toBe(true);
    expect(isNativeStorableValue('')).toBe(true);
    expect(isNativeStorableValue(0)).toBe(true);
    expect(isNativeStorableValue(42)).toBe(true);
    expect(isNativeStorableValue(-3.14)).toBe(true);
    expect(isNativeStorableValue(true)).toBe(true);
    expect(isNativeStorableValue(false)).toBe(true);
  });

  it('accepts homogeneous arrays of scalars', () => {
    expect(isNativeStorableValue([])).toBe(true);
    expect(isNativeStorableValue(['a', 'b'])).toBe(true);
    expect(isNativeStorableValue([1, 2, 3])).toBe(true);
    expect(isNativeStorableValue([true, false])).toBe(true);
  });

  it('rejects nulls, NaN/Infinity, nested objects, and heterogeneous arrays', () => {
    expect(isNativeStorableValue(null)).toBe(false);
    expect(isNativeStorableValue(undefined)).toBe(false);
    expect(isNativeStorableValue(NaN)).toBe(false);
    expect(isNativeStorableValue(Infinity)).toBe(false);
    expect(isNativeStorableValue({ foo: 'bar' })).toBe(false);
    expect(isNativeStorableValue([1, 'a'])).toBe(false);
    expect(isNativeStorableValue([{ x: 1 }])).toBe(false);
    expect(isNativeStorableValue([null])).toBe(false);
  });
});

describe('entityUserPropertyParams', () => {
  it('projects native-storable scalar properties verbatim into the userProperties map', () => {
    expect(
      entityUserPropertyParams({
        city: 'Berlin',
        age: 30,
        active: true,
        tags: ['x', 'y'],
      }),
    ).toEqual({
      city: 'Berlin',
      age: 30,
      active: true,
      tags: ['x', 'y'],
    });
  });

  it('drops values Neo4j cannot store as native scalars — those round-trip only via the JSON blob', () => {
    expect(
      entityUserPropertyParams({
        scalar: 'kept',
        nested: { foo: 'bar' },
        empty: null,
        mixed: [1, 'two'],
      }),
    ).toEqual({ scalar: 'kept' });
  });

  it('throws InvalidInputError on a reserved-key collision (no silent overwrite of a schema field)', () => {
    expect(() => entityUserPropertyParams({ entityType: 'forced' })).toThrowError(InvalidInputError);
    expect(() => entityUserPropertyParams({ slug: 'forced' })).toThrowError(InvalidInputError);
    expect(() => entityUserPropertyParams({ createdBy: 'forced' })).toThrowError(InvalidInputError);
  });

  it('throws InvalidInputError on a malformed key (defence in depth at the write seam)', () => {
    expect(() => entityUserPropertyParams({ 'bad-key': 'x' })).toThrowError(InvalidInputError);
  });
});

describe('entityUpdatePropertyParams', () => {
  it('leaves an unchanged stored key the rules refuse out of the native map instead of refusing it', () => {
    const stored = { 'bad-key': { nested: [1] }, slug: 'user value', ok: 1 };

    expect(entityUpdatePropertyParams({ 'bad-key': { nested: [1] }, slug: 'user value', ok: 2 }, stored)).toEqual({
      ok: 2,
    });
  });

  it('refuses a key the rules refuse when it is new or its value changes', () => {
    expect(() => entityUpdatePropertyParams({ 'bad-key': 'x' }, {})).toThrowError(InvalidInputError);
    expect(() => entityUpdatePropertyParams({ slug: 'changed' }, { slug: 'user value' })).toThrowError(
      InvalidInputError,
    );
  });

  it('projects valid keys as entityUserPropertyParams does', () => {
    expect(entityUpdatePropertyParams({ city: 'Berlin', nested: { a: 1 } }, { city: 'Paris' })).toEqual({
      city: 'Berlin',
    });
  });
});

describe('entityToParams', () => {
  const baseEntity: StoredEntity = {
    id: 'ent-1',
    slug: 'person:alice',
    entityType: 'Person',
    label: 'Alice',
    properties: { city: 'Berlin', nested: { foo: 'bar' } },
    provenance: {
      createdBy: 'verify',
      createdByType: 'agent',
      createdAt: '2026-05-27T00:00:00.000Z',
      modifiedBy: 'verify',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-27T00:00:00.000Z',
    },
  };

  it('binds the JSON blob with the full user-properties shape', () => {
    const params = entityToParams(baseEntity);
    expect(params.properties).toBe(
      JSON.stringify({ city: 'Berlin', nested: { foo: 'bar' } }),
    );
  });

  it('does not embed the user-properties map (that is a separate binding via entityUserPropertyParams)', () => {
    const params = entityToParams(baseEntity);
    expect(params).not.toHaveProperty('userProperties');
    // No user keys leak into the schema-field bag either.
    expect(params).not.toHaveProperty('city');
    expect(params).not.toHaveProperty('nested');
  });
});

// ─── assertSafeRelationshipType ─────────────────────────────────────

describe('assertSafeRelationshipType', () => {
  it('accepts vocabulary-shaped UPPER_SNAKE_CASE identifiers', () => {
    expect(assertSafeRelationshipType('WORKS_AT')).toBe('WORKS_AT');
    expect(assertSafeRelationshipType('KNOWS')).toBe('KNOWS');
    expect(assertSafeRelationshipType('_PRIVATE')).toBe('_PRIVATE');
    expect(assertSafeRelationshipType('A123')).toBe('A123');
  });

  it('rejects values containing characters Cypher would interpret as syntax', () => {
    expect(() => assertSafeRelationshipType('WORKS AT')).toThrowError(InvalidInputError);
    expect(() => assertSafeRelationshipType('WORKS-AT')).toThrowError(InvalidInputError);
    expect(() => assertSafeRelationshipType('1KNOWS')).toThrowError(InvalidInputError);
    expect(() => assertSafeRelationshipType('KNOWS`')).toThrowError(InvalidInputError);
    expect(() => assertSafeRelationshipType('a]->(b)')).toThrowError(InvalidInputError);
    expect(() => assertSafeRelationshipType('')).toThrowError(InvalidInputError);
  });

  it('names relationshipType as the input field', () => {
    expect(() => assertSafeRelationshipType('WORKS-AT')).toThrowError(
      expect.objectContaining({ code: 'INVALID_INPUT', field: 'relationshipType' }),
    );
  });
});

// ─── Relationship property keys ─────────────────────────────────────

describe('relationshipToParams property keys', () => {
  const rel = (properties: Record<string, unknown>): StoredRelationship => ({
    ...relationshipFromProperties(FULL_REL_PROPS),
    properties,
  });

  it('accepts identifier keys that are not reserved', () => {
    expect(relationshipToParams(rel({ weight: 1 }))['properties']).toBe('{"weight":1}');
  });

  it('refuses a reserved or non-identifier key as an input error on that key', () => {
    for (const key of ['label', 'sourceEntityId', 'has-dash']) {
      expect(() => relationshipToParams(rel({ [key]: 'x' }))).toThrowError(
        expect.objectContaining({ code: 'INVALID_INPUT', field: `properties.${key}` }),
      );
    }
  });
});

// ─── Reserved names cover the node layout ───────────────────────────

describe('core reserved property names', () => {
  it('include every schema-managed field on an entity node', () => {
    for (const field of [...STORED_ENTITY_FIELDS, 'repositoryId', 'embedding', WRITE_ATTEMPT_PROPERTY]) {
      expect(RESERVED_ENTITY_PROPERTY_KEYS.has(field)).toBe(true);
    }
  });
});

// ─── write token ────────────────────────────────────────────────────

describe('write token property', () => {
  it('is reserved, so it cannot be written or filtered as an entity property', () => {
    expect(WRITE_ATTEMPT_PROPERTY).toBe('_attempt');
    expect(RESERVED_ENTITY_PROPERTY_KEYS.has('_attempt')).toBe(true);
    expect(() => assertSafeUserPropertyKey('_attempt')).toThrowError(InvalidInputError);
    expect(() => entityUserPropertyParams({ _attempt: 'forged' })).toThrowError(InvalidInputError);
  });

  it('is never projected by the entity or relationship read projections', () => {
    expect(STORED_ENTITY_FIELDS).not.toContain('_attempt');
    expect(STORED_RELATIONSHIP_FIELDS).not.toContain('_attempt');
    expect(buildRelationshipProjection()).not.toContain('_attempt');
  });

  it('does not surface on records read back as whole nodes or edges', () => {
    const entity = entityFromRecord(recordFromNode('n', { ...FULL_ENTITY_PROPS, _attempt: 'token' }));
    const relationship = relationshipFromRecord(recordFromRelationship('r', { ...FULL_REL_PROPS, _attempt: 'token' }));
    const repository = repositoryFromRecord(
      recordFromNode('r', {
        repositoryId: 'repo-1',
        label: 'Repo',
        governanceConfig: JSON.stringify({ mode: 'open' }),
        createdAt: '2026-01-01T00:00:00.000Z',
        createdBy: 'tester',
        _attempt: 'token',
      }),
    );

    expect(JSON.stringify(entity)).not.toContain('token');
    expect(JSON.stringify(relationship)).not.toContain('token');
    expect(JSON.stringify(repository)).not.toContain('token');
  });
});

describe('changeRecordToProperties', () => {
  const FULL: VocabularyChangeRecord = {
    changeId: 'c1',
    changeType: 'entity_type_removed',
    typeName: 'person',
    previousVersion: '1.0.0',
    newVersion: '2.0.0',
    proposedBy: 'agent-a',
    proposedAt: '2026-01-01T00:00:00.000Z',
    approvedBy: 'agent-b',
    approvedAt: '2026-01-01T00:00:01.000Z',
    reason: 'no longer used',
  };

  it('stores every field, and reads back as the same record', () => {
    expect(changeRecordFromProperties(changeRecordToProperties(FULL))).toEqual(FULL);
  });

  it('leaves an absent optional field absent rather than null', () => {
    const { previousVersion: _p, approvedBy: _b, approvedAt: _a, ...minimal } = FULL;
    const props = changeRecordToProperties(minimal);
    expect(Object.keys(props).sort()).toEqual(
      ['changeId', 'changeType', 'newVersion', 'proposedAt', 'proposedBy', 'reason', 'typeName'],
    );
    expect(changeRecordFromProperties(props)).toEqual(minimal);
  });

  it('copies only the record fields', () => {
    const extra = { ...FULL, repositoryId: 'r1' } as VocabularyChangeRecord;
    expect(changeRecordToProperties(extra)).not.toHaveProperty('repositoryId');
  });
});
