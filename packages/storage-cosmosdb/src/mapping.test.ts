import { describe, it, expect } from 'vitest';
import {
  GREMLIN_VERTEX_PROJECTION_FIELDS,
  GREMLIN_EDGE_PROJECTION_FIELDS,
  buildVertexProjectChain,
  buildEdgeProjectChain,
} from '@utaba/deep-memory';
import {
  STORED_ENTITY_FIELDS,
  STORED_RELATIONSHIP_FIELDS,
  STORED_REPOSITORY_FIELDS,
  buildRepositoryProjectChain,
  entityFromDocument,
} from './mapping.js';

// Phase 1 perf-fixes contract: the GremlinCompiler emits a fixed project chain
// listing the keys the storage-cosmosdb mappers consume. The two lists live
// in different packages (the compiler in core can't import from
// storage-cosmosdb because the dependency graph runs the other way). This
// test asserts they don't drift.

describe('Gremlin projection field-list sync (Phase 1 contract)', () => {
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

  it('neither list includes embedding (Phase 1 contract: never wire-ship embeddings on read)', () => {
    expect(GREMLIN_VERTEX_PROJECTION_FIELDS).not.toContain('embedding');
    expect(STORED_ENTITY_FIELDS).not.toContain('embedding');
  });
});

// Phase 2 perf-fixes contract: the public project-chain builders return the
// exact Gremlin string the non-traversal read paths emit. The chain text is
// covered by the GremlinCompiler unit tests for the compiler side; the tests
// below pin shape invariants used by every read-path caller.

describe('buildVertexProjectChain / buildEdgeProjectChain (Phase 2 contract)', () => {
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

describe('buildRepositoryProjectChain (Phase 2)', () => {
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
