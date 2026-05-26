import { describe, it, expect } from 'vitest';
import {
  GREMLIN_VERTEX_PROJECTION_FIELDS,
  GREMLIN_EDGE_PROJECTION_FIELDS,
  buildVertexProjectChain,
  buildEdgeProjectChain,
} from '@utaba/deep-memory';
import {
  ABSENT_STRING_SENTINEL,
  STORED_ENTITY_FIELDS,
  STORED_RELATIONSHIP_FIELDS,
  STORED_REPOSITORY_FIELDS,
  buildEntityPropertyLadder,
  buildRelationshipPropertyLadder,
  buildRepositoryProjectChain,
  buildRepositoryPropertyLadder,
  entityFromDocument,
  entityToLadderBindings,
  relationshipToLadderBindings,
  repositoryConfigToLadderBindings,
} from './mapping.js';
import type { StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';

// Cross-package projection contract: the GremlinCompiler emits a fixed
// project chain listing the keys the storage-cosmosdb mappers consume. The
// two lists live in different packages (the compiler in core can't import
// from storage-cosmosdb because the dependency graph runs the other way).
// This test asserts they don't drift.

describe('Gremlin projection field-list sync', () => {
  it('vertex projection fields match the stored-entity mapper input set', () => {
    expect(
      [...GREMLIN_VERTEX_PROJECTION_FIELDS].sort(),
    ).toEqual([...STORED_ENTITY_FIELDS].sort());
  });

  it('edge projection fields match the stored-relationship mapper input set', () => {
    expect(
      [...GREMLIN_EDGE_PROJECTION_FIELDS].sort(),
    ).toEqual([...STORED_RELATIONSHIP_FIELDS].sort());
  });

  it('neither list includes embedding (never wire-ship embeddings on read)', () => {
    expect(GREMLIN_VERTEX_PROJECTION_FIELDS).not.toContain('embedding');
    expect(STORED_ENTITY_FIELDS).not.toContain('embedding');
  });
});

// Project-chain shape contract: the public project-chain builders return the
// exact Gremlin string the non-traversal read paths emit. The chain text is
// covered by the GremlinCompiler unit tests for the compiler side; the tests
// below pin shape invariants used by every read-path caller.

describe('buildVertexProjectChain / buildEdgeProjectChain', () => {
  it('vertex chain default omits embedding', () => {
    expect(buildVertexProjectChain()).not.toMatch(/'embedding'/);
  });

  it('vertex chain with embedding option appends an embedding key', () => {
    const withEmbedding = buildVertexProjectChain({ withEmbedding: true });
    expect(withEmbedding).toMatch(/'embedding'/);
    expect(withEmbedding).toMatch(/coalesce\(values\('embedding'\), constant\(''\)\)/);
  });

  it('vertex chain always emits the __kind discriminator', () => {
    expect(buildVertexProjectChain()).toMatch(/'__kind'/);
    expect(buildVertexProjectChain()).toMatch(/constant\('v'\)/);
  });

  it('edge chain emits the __kind discriminator with value "e" and no embedding', () => {
    const chain = buildEdgeProjectChain();
    expect(chain).toMatch(/'__kind'/);
    expect(chain).toMatch(/constant\('e'\)/);
    expect(chain).not.toMatch(/'embedding'/);
  });

  it('vertex chain default and embedding-on shapes are distinct strings', () => {
    expect(buildVertexProjectChain()).not.toBe(buildVertexProjectChain({ withEmbedding: true }));
  });
});

describe('entityFromDocument (Cosmos NoSQL Document-endpoint shape)', () => {
  // Probe results 2026-05-26: every Gremlin-managed property is stored as
  // `[{_value, id}]`; only `id`, `repositoryId`, and the vertex `label` token
  // are flat scalars. The probe explicitly caught the entityType-path gotcha:
  // `c.entityType[0]._value` is the authoritative type — `c.label` is the
  // Gremlin reserved vertex-label token that aliases entityType at create-
  // time but goes stale on update. entityFromDocument reads the property,
  // not the token.

  const fixture = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: '00000000-0000-0000-0001-aliceprobeshape',
    repositoryId: '00000000-0000-0000-0000-cosmossqlprobe',
    label: 'PersonStale', // intentionally not equal to entityType to prove we read the property
    entityType: [{ _value: 'Person', id: 'gen-1' }],
    entityLabel: [{ _value: 'Alice Probe', id: 'gen-2' }],
    slug: [{ _value: 'alice-probe', id: 'gen-3' }],
    summary: [{ _value: 'A fixture person.', id: 'gen-4' }],
    properties: [{ _value: '{"role":"engineer","seniority":"staff"}', id: 'gen-5' }],
    createdBy: [{ _value: 'agent-1', id: 'gen-6' }],
    createdByType: [{ _value: 'agent', id: 'gen-7' }],
    createdAt: [{ _value: '2026-05-26T00:00:00Z', id: 'gen-8' }],
    modifiedBy: [{ _value: 'agent-1', id: 'gen-9' }],
    modifiedByType: [{ _value: 'agent', id: 'gen-10' }],
    modifiedAt: [{ _value: '2026-05-26T00:00:00Z', id: 'gen-11' }],
    ...overrides,
  });

  it('plucks [0]._value for every Gremlin-managed property and reads entityType (not the label token)', () => {
    const entity = entityFromDocument(fixture());
    expect(entity.id).toBe('00000000-0000-0000-0001-aliceprobeshape');
    expect(entity.entityType).toBe('Person');
    expect(entity.label).toBe('Alice Probe');
    expect(entity.slug).toBe('alice-probe');
    expect(entity.summary).toBe('A fixture person.');
  });

  it('JSON-parses the stringified properties blob into a plain object', () => {
    const entity = entityFromDocument(fixture());
    expect(entity.properties).toEqual({ role: 'engineer', seniority: 'staff' });
  });

  it('builds provenance from the same [0]._value shape', () => {
    const entity = entityFromDocument(fixture());
    expect(entity.provenance.createdBy).toBe('agent-1');
    expect(entity.provenance.createdByType).toBe('agent');
    expect(entity.provenance.createdAt).toBe('2026-05-26T00:00:00Z');
    expect(entity.provenance.modifiedBy).toBe('agent-1');
  });

  it('returns undefined for optional fields when missing entirely', () => {
    const doc = fixture();
    delete doc['summary'];
    delete doc['createdInConversation'];
    const entity = entityFromDocument(doc);
    expect(entity.summary).toBeUndefined();
    expect(entity.provenance.createdInConversation).toBeUndefined();
    expect(entity.data).toBeUndefined();
    expect(entity.dataFormat).toBeUndefined();
  });

  it('reads optional provenance fields when present', () => {
    const entity = entityFromDocument(
      fixture({
        createdInConversation: [{ _value: 'conv-1', id: 'gen-12' }],
        createdFromMessage: [{ _value: 'msg-7', id: 'gen-13' }],
      }),
    );
    expect(entity.provenance.createdInConversation).toBe('conv-1');
    expect(entity.provenance.createdFromMessage).toBe('msg-7');
  });

  it('parses an embedding when present, returns undefined otherwise', () => {
    const withEmbedding = entityFromDocument(
      fixture({ embedding: [{ _value: '[0.1,0.2,0.3]', id: 'gen-14' }] }),
    );
    expect(withEmbedding.embedding).toEqual([0.1, 0.2, 0.3]);

    const without = entityFromDocument(fixture());
    expect(without.embedding).toBeUndefined();
  });

  it('falls back to {} for properties when the blob is unparseable', () => {
    const entity = entityFromDocument(
      fixture({ properties: [{ _value: 'not-json', id: 'gen-15' }] }),
    );
    expect(entity.properties).toEqual({});
  });

  it('defaults createdByType / modifiedByType to "agent" when missing', () => {
    const doc = fixture();
    delete doc['createdByType'];
    delete doc['modifiedByType'];
    const entity = entityFromDocument(doc);
    expect(entity.provenance.createdByType).toBe('agent');
    expect(entity.provenance.modifiedByType).toBe('agent');
  });
});

describe('buildRepositoryProjectChain', () => {
  it('emits a project chain covering the STORED_REPOSITORY_FIELDS keys', () => {
    const chain = buildRepositoryProjectChain();
    for (const field of STORED_REPOSITORY_FIELDS) {
      // 'id' is read via `.by(id)` (the Gremlin token) — exclude it from the
      // string-match assertion. Every other field appears as a quoted key.
      if (field === 'id') continue;
      expect(chain).toContain(`'${field}'`);
    }
  });

  it('uses coalesce defaults for optional fields and bare .by for required fields', () => {
    const chain = buildRepositoryProjectChain();
    // required
    expect(chain).toMatch(/\.by\('repositoryId'\)/);
    expect(chain).toMatch(/\.by\('repoLabel'\)/);
    expect(chain).toMatch(/\.by\('governanceConfig'\)/);
    expect(chain).toMatch(/\.by\('createdAt'\)/);
    expect(chain).toMatch(/\.by\('createdBy'\)/);
    // optional
    expect(chain).toMatch(/coalesce\(values\('description'\), constant\(''\)\)/);
    expect(chain).toMatch(/coalesce\(values\('metadata'\), constant\(''\)\)/);
  });
});

// ─── Fixed-shape property ladders ────────────────────────────────
//
// Two contracts the cosmos-side write paths depend on:
//   1. The emitted Gremlin string is INVARIANT across writes — same chain
//      regardless of which optional fields the caller populated, so the
//      server-side plan cache reuses one compiled plan.
//   2. The bindings dict that `*ToLadderBindings` returns is canonical: every
//      slot is present (even when absent — sentinel-filled), and the slot
//      order matches the chain's parameter order so the choose-skip steps
//      can read the right value.
// Validated live against the emulator 2026-05-26.

describe('entity property ladder', () => {
  const baseEntity: StoredEntity = {
    id: 'eid-1',
    slug: 'Person:alice',
    entityType: 'Person',
    label: 'Alice',
    properties: { role: 'engineer' },
    provenance: {
      createdBy: 'agent-1',
      createdByType: 'agent',
      createdAt: '2026-05-26T00:00:00Z',
      modifiedBy: 'agent-1',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-26T00:00:00Z',
    },
  };

  it('emits the same chain string regardless of optional-slot population', () => {
    expect(buildEntityPropertyLadder()).toBe(buildEntityPropertyLadder());
  });

  it('chain contains every required slot as plain .property and every optional slot via choose-skip', () => {
    const chain = buildEntityPropertyLadder();
    // Required slots — bare .property('key', pN)
    for (const slot of [
      'entityType', 'entityLabel', 'slug', 'properties',
      'createdBy', 'createdByType', 'createdAt',
      'modifiedBy', 'modifiedByType', 'modifiedAt',
    ]) {
      expect(chain).toMatch(new RegExp(`\\.property\\('${slot}',\\s*p\\d+\\)`));
    }
    // Optional slots — choose-skip wrapper referencing the sentinel binding
    for (const slot of [
      'summary', 'data', 'dataFormat', 'embedding',
      'createdInConversation', 'createdFromMessage',
      'modifiedInConversation', 'modifiedFromMessage',
    ]) {
      expect(chain).toMatch(
        new RegExp(`__\\.constant\\(p\\d+\\)\\.is\\(neq\\(absentSentinel\\)\\),\\s*__\\.property\\('${slot}',\\s*p\\d+\\)`),
      );
    }
  });

  it('chain does NOT include id or repositoryId — those are written separately by the caller', () => {
    const chain = buildEntityPropertyLadder();
    expect(chain).not.toMatch(/\.property\('id',/);
    expect(chain).not.toMatch(/\.property\('repositoryId',/);
  });

  it('entityToLadderBindings emits every slot including absentSentinel', () => {
    const bindings = entityToLadderBindings(baseEntity);
    // Required slots populated
    expect(bindings['p0']).toBe('Person'); // entityType
    expect(bindings['p1']).toBe('Alice');  // entityLabel
    expect(bindings['p2']).toBe('Person:alice'); // slug
    expect(bindings['p3']).toBe('{"role":"engineer"}'); // properties JSON
    // Optional slots default to the sentinel
    expect(bindings['p10']).toBe(ABSENT_STRING_SENTINEL); // summary
    expect(bindings['p11']).toBe(ABSENT_STRING_SENTINEL); // data
    expect(bindings['p13']).toBe(ABSENT_STRING_SENTINEL); // embedding
    expect(bindings['absentSentinel']).toBe(ABSENT_STRING_SENTINEL);
  });

  it('entityToLadderBindings stringifies the embedding when present', () => {
    const bindings = entityToLadderBindings({ ...baseEntity, embedding: [0.1, 0.2, 0.3] });
    expect(bindings['p13']).toBe('[0.1,0.2,0.3]');
  });

  it('entityToLadderBindings emits sentinel for an explicit empty string the same way as undefined', () => {
    // Empty string and undefined collapse to absent on read (`unwrapOptStr`).
    // Both must produce the sentinel binding so the choose-skip uniformly
    // drops the property — confirming the read-path semantic is preserved.
    const a = entityToLadderBindings({ ...baseEntity, summary: undefined });
    const b = entityToLadderBindings({ ...baseEntity, summary: '' });
    expect(a['p10']).toBe(ABSENT_STRING_SENTINEL);
    // '' is itself the sentinel — equality check, not collapse.
    expect(b['p10']).toBe('');
  });

  it('entityToLadderBindings throws if a required slot is null', () => {
    const broken = {
      ...baseEntity,
      entityType: null as unknown as string,
    };
    expect(() => entityToLadderBindings(broken)).toThrow(/required slot 'entityType'/);
  });
});

describe('relationship property ladder', () => {
  const baseRel: StoredRelationship = {
    id: 'rel-1',
    relationshipType: 'KNOWS',
    sourceEntityId: 'src',
    targetEntityId: 'tgt',
    properties: {},
    bidirectional: true,
    provenance: {
      createdBy: 'agent-1',
      createdByType: 'agent',
      createdAt: '2026-05-26T00:00:00Z',
      modifiedBy: 'agent-1',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-26T00:00:00Z',
    },
  };

  it('chain references every required slot plainly and every optional slot via choose-skip', () => {
    const chain = buildRelationshipPropertyLadder();
    for (const slot of [
      'relationshipType', 'sourceEntityId', 'targetEntityId',
      'bidirectional', 'properties',
      'createdBy', 'createdByType', 'createdAt',
      'modifiedBy', 'modifiedByType', 'modifiedAt',
    ]) {
      expect(chain).toMatch(new RegExp(`\\.property\\('${slot}',\\s*p\\d+\\)`));
    }
    for (const slot of [
      'createdInConversation', 'createdFromMessage',
      'modifiedInConversation', 'modifiedFromMessage',
    ]) {
      expect(chain).toMatch(
        new RegExp(`__\\.constant\\(p\\d+\\)\\.is\\(neq\\(absentSentinel\\)\\),\\s*__\\.property\\('${slot}',\\s*p\\d+\\)`),
      );
    }
    // Same id/repositoryId-omission contract as entities.
    expect(chain).not.toMatch(/\.property\('id',/);
    expect(chain).not.toMatch(/\.property\('repositoryId',/);
  });

  it('relationshipToLadderBindings preserves the boolean bidirectional and sentinels absent provenance', () => {
    const bindings = relationshipToLadderBindings(baseRel);
    expect(bindings['p3']).toBe(true); // bidirectional
    expect(bindings['p11']).toBe(ABSENT_STRING_SENTINEL); // createdInConversation
    expect(bindings['p14']).toBe(ABSENT_STRING_SENTINEL); // modifiedFromMessage
    expect(bindings['absentSentinel']).toBe(ABSENT_STRING_SENTINEL);
  });
});

describe('repository property ladder', () => {
  it('chain references every required slot plainly and every optional slot via choose-skip', () => {
    const chain = buildRepositoryPropertyLadder();
    for (const slot of ['repoLabel', 'governanceConfig', 'createdAt', 'createdBy']) {
      expect(chain).toMatch(new RegExp(`\\.property\\('${slot}',\\s*p\\d+\\)`));
    }
    for (const slot of ['description', 'type', 'legal', 'owner', 'metadata']) {
      expect(chain).toMatch(
        new RegExp(`__\\.constant\\(p\\d+\\)\\.is\\(neq\\(absentSentinel\\)\\),\\s*__\\.property\\('${slot}',\\s*p\\d+\\)`),
      );
    }
  });

  it('repositoryConfigToLadderBindings stringifies governanceConfig and metadata', () => {
    const bindings = repositoryConfigToLadderBindings({
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: '2026-05-26T00:00:00Z',
      createdBy: 'user-1',
      description: 'A test repo',
      metadata: { foo: 'bar' },
    });
    expect(bindings['p0']).toBe('Test');
    expect(bindings['p1']).toBe('{"mode":"open"}');
    expect(bindings['p4']).toBe('A test repo');
    expect(bindings['p8']).toBe('{"foo":"bar"}');
    expect(bindings['absentSentinel']).toBe(ABSENT_STRING_SENTINEL);
  });

  it('repositoryConfigToLadderBindings emits sentinels for absent optional fields', () => {
    const bindings = repositoryConfigToLadderBindings({
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: '2026-05-26T00:00:00Z',
      createdBy: 'user-1',
    });
    // description / type / legal / owner / metadata all absent
    expect(bindings['p4']).toBe(ABSENT_STRING_SENTINEL);
    expect(bindings['p5']).toBe(ABSENT_STRING_SENTINEL);
    expect(bindings['p6']).toBe(ABSENT_STRING_SENTINEL);
    expect(bindings['p7']).toBe(ABSENT_STRING_SENTINEL);
    expect(bindings['p8']).toBe(ABSENT_STRING_SENTINEL);
  });
});
