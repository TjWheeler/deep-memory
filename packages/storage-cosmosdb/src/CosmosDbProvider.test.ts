// Focused unit tests for CosmosDbProvider behaviors that do not need a live
// emulator. Covers the vocabulary cache (shape of the query/binding emitted
// by traversal compilation, cache hit/miss counts, invalidation on
// saveVocabulary) and the single-round-trip create / update / delete paths.
//
// We bracket-access the private `conn` property to inject a stub. The
// production constructor does not call any methods on the connection until a
// public method runs, so swap-after-construct is safe.

import { describe, it, expect, vi } from 'vitest';
import { CosmosDbProvider } from './CosmosDbProvider.js';
import type { GremlinResult } from './CosmosDbConnection.js';
import type {
  StoredEntity,
  StoredEntityUpdate,
  StoredRelationship,
  TraversalSpec,
} from '@utaba/deep-memory/types';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  EntityNotFoundError,
  ProviderError,
} from '@utaba/deep-memory';
import { ENTITY_CREATE_QUERY } from './queries/entity.js';
import { RELATIONSHIP_CREATE_QUERY } from './queries/relationship.js';
import type { CosmosQueryParameter, CosmosQueryResult } from './CosmosDocumentClient.js';

const TEST_REPO = '40000000-0000-4000-a000-000000000099';

interface SubmitCall {
  query: string;
  params?: Record<string, unknown>;
}

interface SubmitStub {
  submit: (query: string, params?: Record<string, unknown>) => Promise<GremlinResult>;
  calls: SubmitCall[];
  isVocabRead(call: SubmitCall): boolean;
}

function makeProvider(): { provider: CosmosDbProvider; stub: SubmitStub } {
  const calls: SubmitCall[] = [];

  const stub: SubmitStub = {
    calls,
    isVocabRead: (call) =>
      call.query.includes("hasLabel('_vocabulary')") && call.query.includes("values('vocabulary')"),
    submit: async (query, params) => {
      calls.push({ query, params });
      // Default: empty result. Tests override per-call by inspecting the
      // query string and returning shaped data.
      if (query.includes("hasLabel('_vocabulary')")) {
        // The vocabulary read uses `.values('vocabulary').limit(1)` — return
        // a JSON-stringified vocabulary so the parse path succeeds.
        return {
          items: [
            JSON.stringify({
              version: '1.0.0',
              lastModified: '2026-05-25T00:00:00.000Z',
              modifiedBy: 'test',
              entityTypes: [{ name: 'Person', properties: [] }],
              relationshipTypes: [],
            }),
          ],
        };
      }
      if (query.startsWith('g.V().has(\'repositoryId\', pRid)')) {
        // Traversal query — return an empty union/path result. The provider
        // unpacks items into entities/relationships/paths.
        return { items: [] };
      }
      return { items: [] };
    },
  };

  const provider = new CosmosDbProvider({
    endpoint: 'ws://unit-test/',
    key: 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
    database: 'd',
    container: 'c',
  });
  // Bracket-access to swap the real Gremlin connection (which would attempt a
  // real WebSocket open on .submit()) with the stub.
  (provider as unknown as { conn: SubmitStub }).conn = stub;

  return { provider, stub };
}

const SIMPLE_TRAVERSAL: TraversalSpec = {
  start: { entityId: '40000000-0000-4000-a000-deadbeef0001' },
  steps: [{ direction: 'both' }],
  returnMode: 'all',
};

describe('vocabulary cache', () => {
  it('two consecutive traverse calls only fetch the vocabulary once', async () => {
    const { provider, stub } = makeProvider();

    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);

    const vocabReads = stub.calls.filter((c) => stub.isVocabRead(c));
    expect(vocabReads).toHaveLength(1);
  });

  it('saveVocabulary invalidates the cache so the next traverse re-fetches', async () => {
    const { provider, stub } = makeProvider();

    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    await provider.saveVocabulary(TEST_REPO, {
      version: '1.0.1',
      lastModified: '2026-05-25T00:00:01.000Z',
      modifiedBy: 'test',
      entityTypes: [],
      relationshipTypes: [],
    });
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);

    const vocabReads = stub.calls.filter((c) => stub.isVocabRead(c));
    expect(vocabReads).toHaveLength(2);
  });

  it('expired entry lazily refetches without an explicit clear', async () => {
    const { provider, stub } = makeProvider();
    // Force the system clock forward past the 60 s TTL between calls.
    const realNow = Date.now;
    let nowOffset = 0;
    Date.now = () => realNow() + nowOffset;
    try {
      await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
      nowOffset = 60_001; // one ms past the TTL
      await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    } finally {
      Date.now = realNow;
    }

    const vocabReads = stub.calls.filter((c) => stub.isVocabRead(c));
    expect(vocabReads).toHaveLength(2);
  });

  it('separate provider instances do not share the cache', async () => {
    const a = makeProvider();
    const b = makeProvider();

    await a.provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    await b.provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);

    expect(a.stub.calls.filter((c) => a.stub.isVocabRead(c))).toHaveLength(1);
    expect(b.stub.calls.filter((c) => b.stub.isVocabRead(c))).toHaveLength(1);
  });
});

describe('non-traversal read paths emit projection chains, not valueMap(true)', () => {
  it('getEntity emits the vertex project chain by default (no embedding key)', async () => {
    const { provider, stub } = makeProvider();
    await provider.getEntity(TEST_REPO, '40000000-0000-4000-a000-deadbeef0001');

    const last = stub.calls[stub.calls.length - 1];
    expect(last).toBeDefined();
    expect(last!.query).toContain('project(');
    expect(last!.query).not.toContain('valueMap(true)');
    expect(last!.query).not.toContain("'embedding'");
    expect(last!.query).toContain("constant('v')");
  });

  it('getEntity with loadEmbeddings: true appends the embedding key', async () => {
    const { provider, stub } = makeProvider();
    await provider.getEntity(TEST_REPO, '40000000-0000-4000-a000-deadbeef0001', { loadEmbeddings: true });

    const last = stub.calls[stub.calls.length - 1];
    expect(last!.query).toContain("'embedding'");
    expect(last!.query).toContain("coalesce(values('embedding'), constant(''))");
  });

  it('getRelationship emits the edge project chain (never includes embedding)', async () => {
    const { provider, stub } = makeProvider();
    await provider.getRelationship(TEST_REPO, '40000000-0000-4000-a000-deadbeef0002');

    const last = stub.calls[stub.calls.length - 1];
    expect(last!.query).toContain('project(');
    expect(last!.query).not.toContain('valueMap(true)');
    expect(last!.query).not.toContain("'embedding'");
    expect(last!.query).toContain("constant('e')");
  });

  it('getVocabulary issues a focused .values(\'vocabulary\') read rather than valueMap(true)', async () => {
    const { provider, stub } = makeProvider();
    await provider.getVocabulary(TEST_REPO);

    const last = stub.calls[stub.calls.length - 1];
    expect(last!.query).toContain("values('vocabulary')");
    expect(last!.query).toContain('.limit(1)');
    expect(last!.query).not.toContain('valueMap(true)');
  });

  it('getRepository emits the repository project chain rather than valueMap(true)', async () => {
    const { provider, stub } = makeProvider();
    // Stub returns empty for repository lookups; we only assert the query shape.
    stub.submit = vi.fn(async (query) => {
      stub.calls.push({ query });
      return { items: [] };
    });

    await provider.getRepository(TEST_REPO);

    const lastQuery = stub.calls[stub.calls.length - 1]!.query;
    expect(lastQuery).toContain('project(');
    expect(lastQuery).not.toContain('valueMap(true)');
    expect(lastQuery).toContain("'repositoryId'");
    expect(lastQuery).toContain("'repoLabel'");
  });
});

// ─── Single round-trip create / update ───────────────────────────────
//
// The fold().coalesce(unfold().constant('__duplicate'), addV/addE) pattern
// removes the existence-check round-trip. updateEntity appends the read
// projection so it no longer does update + getEntity. These tests assert
// exactly one storage call on the happy path and the duplicate path, and
// surface the right typed errors.

function makeEntity(id: string): StoredEntity {
  return {
    id,
    slug: `slug-${id}`,
    entityType: 'Person',
    label: 'Single-Round-Trip Probe',
    properties: { age: 30 },
    provenance: {
      createdBy: 'test',
      createdByType: 'agent',
      createdAt: '2026-05-25T00:00:00.000Z',
      modifiedBy: 'test',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-25T00:00:00.000Z',
    },
  };
}

function makeRelationship(id: string, src: string, tgt: string): StoredRelationship {
  return {
    id,
    relationshipType: 'KNOWS',
    sourceEntityId: src,
    targetEntityId: tgt,
    properties: {},
    bidirectional: false,
    provenance: {
      createdBy: 'test',
      createdByType: 'agent',
      createdAt: '2026-05-25T00:00:00.000Z',
      modifiedBy: 'test',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-25T00:00:00.000Z',
    },
  };
}

describe('single-round-trip create / update', () => {
  it('createEntity issues exactly one storage call on success', async () => {
    const { provider, stub } = makeProvider();
    // Default stub returns { items: [] } — simulate the addV branch firing by
    // returning a vertex-shaped result for the create query.
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce(')) {
        return { items: [{ id: 'created-vertex' }] };
      }
      return { items: [] };
    };

    const entity = makeEntity('40000000-0000-4000-a000-000000006001');
    const before = stub.calls.length;
    await provider.createEntity(TEST_REPO, entity);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    const created = stub.calls[stub.calls.length - 1]!;
    expect(created.query).toContain('fold().coalesce(');
    expect(created.query).toContain("unfold().constant('__duplicate')");
    expect(created.query).toContain('addV(vertexLabel)');
    expect(created.query).not.toContain('.count()');
  });

  it('createEntity issues exactly one storage call on duplicate and throws DuplicateEntityError', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce(')) {
        return { items: ['__duplicate'] };
      }
      return { items: [] };
    };

    const entity = makeEntity('40000000-0000-4000-a000-000000006002');
    const before = stub.calls.length;
    await expect(provider.createEntity(TEST_REPO, entity)).rejects.toBeInstanceOf(DuplicateEntityError);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
  });

  it('createRelationship issues exactly one storage call on success', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce(')) {
        return { items: [{ id: 'created-edge' }] };
      }
      return { items: [] };
    };

    const rel = makeRelationship(
      '40000000-0000-4000-a000-000000006003',
      '40000000-0000-4000-a000-deadbeef0001',
      '40000000-0000-4000-a000-deadbeef0002',
    );
    const before = stub.calls.length;
    await provider.createRelationship(TEST_REPO, rel);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    const created = stub.calls[stub.calls.length - 1]!;
    expect(created.query).toContain('fold().coalesce(');
    expect(created.query).toContain('addE(edgeLabel)');
    expect(created.query).not.toContain('.count()');
  });

  it('createRelationship issues exactly one storage call on duplicate and throws DuplicateRelationshipError', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce(')) {
        return { items: ['__duplicate'] };
      }
      return { items: [] };
    };

    const rel = makeRelationship(
      '40000000-0000-4000-a000-000000006004',
      '40000000-0000-4000-a000-deadbeef0001',
      '40000000-0000-4000-a000-deadbeef0002',
    );
    const before = stub.calls.length;
    await expect(provider.createRelationship(TEST_REPO, rel)).rejects.toBeInstanceOf(DuplicateRelationshipError);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
  });

  it('updateEntity issues exactly one storage call and parses the projected result', async () => {
    const { provider, stub } = makeProvider();
    // The update query embeds the projection chain. We simulate the projected
    // shape that entityFromGremlin expects.
    const projectedVertex = {
      id: '40000000-0000-4000-a000-000000006005',
      entityType: 'Person',
      entityLabel: 'Updated Label',
      slug: 'updated-slug',
      summary: '',
      properties: '{}',
      data: '',
      dataFormat: '',
      createdBy: 'test',
      createdByType: 'agent',
      createdAt: '2026-05-25T00:00:00.000Z',
      createdInConversation: '',
      createdFromMessage: '',
      modifiedBy: 'test',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-25T00:00:01.000Z',
      modifiedInConversation: '',
      modifiedFromMessage: '',
    };

    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.V().has(\'repositoryId\', rid).hasId(eid).has(\'entityType\')') && query.includes('.project(')) {
        return { items: [projectedVertex] };
      }
      return { items: [] };
    };

    const updates: StoredEntityUpdate = {
      label: 'Updated Label',
      provenance: {
        createdBy: 'test',
        createdByType: 'agent',
        createdAt: '2026-05-25T00:00:00.000Z',
        modifiedBy: 'test',
        modifiedByType: 'agent',
        modifiedAt: '2026-05-25T00:00:01.000Z',
      },
    };

    const before = stub.calls.length;
    const result = await provider.updateEntity(TEST_REPO, projectedVertex.id, updates);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.label).toBe('Updated Label');
    expect(stub.calls[stub.calls.length - 1]!.query).toContain('.project(');
  });

  it('updateEntity throws EntityNotFoundError when no vertex matches', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      return { items: [] };
    };

    const updates: StoredEntityUpdate = {
      label: 'never-applies',
      provenance: {
        createdBy: 'test',
        createdByType: 'agent',
        createdAt: '2026-05-25T00:00:00.000Z',
        modifiedBy: 'test',
        modifiedByType: 'agent',
        modifiedAt: '2026-05-25T00:00:01.000Z',
      },
    };

    await expect(
      provider.updateEntity(TEST_REPO, '40000000-0000-4000-a000-000000006006', updates),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
  });
});

// ─── createEntity user-property scalars (dual-write) ─────────────────
//
// Native-storable user-property values dual-write as per-key vertex properties
// alongside the canonical JSON blob, so server-side predicates (values('orgType'))
// and aggregations can reach them. The blob remains authoritative for round-
// trip. Contract pins:
//   1. Empty user-properties → the emitted Gremlin string is byte-identical
//      to the canonical ENTITY_CREATE_QUERY (zero plan-cache regression for
//      the dominant shape).
//   2. Native-storable values → one `.property('<key>', p_user_<i>)` per key,
//      emitted in insertion order, with values bound through the p_user_*
//      slots (only keys are inline).
//   3. Unsafe identifiers and reserved-set collisions → ProviderError thrown
//      synchronously, no round-trip.
//   4. Non-storable values → silently dropped from the suffix; the canonical
//      blob still carries them via the ladder `properties` slot.
//   5. The duplicate-detection sentinel path is unaffected — the suffix sits
//      inside the addV branch of the coalesce.

function captureCreateQuery(): {
  provider: CosmosDbProvider;
  stub: SubmitStub;
  getCreateCall: () => SubmitCall;
} {
  const { provider, stub } = makeProvider();
  stub.submit = async (query, params) => {
    stub.calls.push({ query, params });
    if (query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce(')) {
      return { items: [{ id: 'created-vertex' }] };
    }
    return { items: [] };
  };
  return {
    provider,
    stub,
    getCreateCall: () => {
      const call = stub.calls.find((c) =>
        c.query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce('),
      );
      if (!call) throw new Error('no create call captured');
      return call;
    },
  };
}

describe('createEntity user-property scalars', () => {
  it('empty user-properties emits the canonical ENTITY_CREATE_QUERY string byte-for-byte', async () => {
    const { provider, getCreateCall } = captureCreateQuery();
    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008001'),
      properties: {},
    };

    await provider.createEntity(TEST_REPO, entity);

    expect(getCreateCall().query).toBe(ENTITY_CREATE_QUERY);
  });

  it('all-non-storable user-properties collapse to the canonical query — blob still carries them', async () => {
    const { provider, getCreateCall } = captureCreateQuery();
    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008002'),
      properties: { nested: { a: 1 }, mixed: ['a', 1] },
    };

    await provider.createEntity(TEST_REPO, entity);

    const call = getCreateCall();
    expect(call.query).toBe(ENTITY_CREATE_QUERY);
    // The canonical `properties` ladder binding (p3 in the entity ladder) still
    // serialises the full input blob — non-storable values round-trip via JSON.
    const propertiesBlob = (call.params as Record<string, unknown>)['p3'];
    expect(propertiesBlob).toBe(JSON.stringify({ nested: { a: 1 }, mixed: ['a', 1] }));
  });

  it('appends one .property suffix per native-storable user key in insertion order', async () => {
    const { provider, getCreateCall } = captureCreateQuery();
    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008003'),
      properties: { orgType: 'company', tier: 'premium', headcount: 42 },
    };

    await provider.createEntity(TEST_REPO, entity);

    const call = getCreateCall();
    expect(call.query).toContain(".property('orgType', p_user_0)");
    expect(call.query).toContain(".property('tier', p_user_1)");
    expect(call.query).toContain(".property('headcount', p_user_2)");
    // Order is part of the cache key — verify literal substring order.
    const orgIdx = call.query.indexOf(".property('orgType', p_user_0)");
    const tierIdx = call.query.indexOf(".property('tier', p_user_1)");
    const hcIdx = call.query.indexOf(".property('headcount', p_user_2)");
    expect(orgIdx).toBeGreaterThan(-1);
    expect(tierIdx).toBeGreaterThan(orgIdx);
    expect(hcIdx).toBeGreaterThan(tierIdx);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
    expect(params['p_user_2']).toBe(42);
  });

  it('drops non-storable values from the suffix; storable siblings still appear', async () => {
    const { provider, getCreateCall } = captureCreateQuery();
    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008004'),
      properties: {
        orgType: 'company',
        nested: { a: 1 },
        mixed: ['a', 1],
        tier: 'premium',
      },
    };

    await provider.createEntity(TEST_REPO, entity);

    const call = getCreateCall();
    expect(call.query).toContain(".property('orgType', p_user_0)");
    expect(call.query).toContain(".property('tier', p_user_1)");
    expect(call.query).not.toContain(".property('nested'");
    expect(call.query).not.toContain(".property('mixed'");
    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
    expect(params['p_user_2']).toBeUndefined();
  });

  it('throws ProviderError on a reserved-key collision before any round-trip', async () => {
    const { provider, stub } = captureCreateQuery();
    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008005'),
      properties: { entityLabel: 'X' },
    };

    const before = stub.calls.length;
    await expect(provider.createEntity(TEST_REPO, entity)).rejects.toBeInstanceOf(ProviderError);
    const after = stub.calls.length;

    // Validation runs synchronously — no submit issued. Vocabulary read is
    // also skipped because createEntity hits validation first (the public
    // CosmosDbProvider.createEntity calls vocabulary first; assert no CREATE
    // query was issued specifically).
    const createCalls = stub.calls
      .slice(before, after)
      .filter((c) =>
        c.query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce('),
      );
    expect(createCalls).toHaveLength(0);
  });

  it('throws ProviderError on an unsafe identifier (rejects before round-trip)', async () => {
    const { provider, stub } = captureCreateQuery();
    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008006'),
      properties: { 'has-dash': 'X' },
    };

    const before = stub.calls.length;
    await expect(provider.createEntity(TEST_REPO, entity)).rejects.toThrow(
      /not a valid Gremlin identifier/,
    );
    const after = stub.calls.length;
    const createCalls = stub.calls
      .slice(before, after)
      .filter((c) =>
        c.query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce('),
      );
    expect(createCalls).toHaveLength(0);
  });

  it('duplicate-detection sentinel path still fires when scalars are present', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.V().has(\'repositoryId\', rid).hasId(vid).fold().coalesce(')) {
        return { items: ['__duplicate'] };
      }
      return { items: [] };
    };

    const entity: StoredEntity = {
      ...makeEntity('40000000-0000-4000-a000-000000008007'),
      properties: { orgType: 'company' },
    };

    await expect(provider.createEntity(TEST_REPO, entity)).rejects.toBeInstanceOf(
      DuplicateEntityError,
    );
    const lastCall = stub.calls[stub.calls.length - 1]!;
    // Suffix is present in the duplicate-path query too — the addV branch
    // carries the scalars whether or not it fires at runtime.
    expect(lastCall.query).toContain(".property('orgType', p_user_0)");
  });
});

// ─── updateEntity user-property scalars (dual-write) ─────────────────
//
// When the caller replaces `updates.properties`, the update path runs two
// round-trips: one pre-read of the existing blob (so the drop set for
// scalars that left the new shape can be computed client-side) and one
// write. Cosmos Gremlin cannot enumerate user-property keys in-step, so the
// drop set has to be derived externally. The contract pinned by these
// tests:
//   1. updates.properties === undefined → NO pre-read, NO user-property
//      steps in the emitted query (preserves the historical 1-round-trip
//      shape for the dominant partial-update case).
//   2. updates.properties defined → pre-read fires, drop steps emit for
//      scalars present in the old blob and absent in the new payload,
//      and .property steps emit for every native-storable key in the new
//      payload (including keys whose value did not change — re-emit keeps
//      the per-shape plan-cache entry stable).
//   3. Reserved-name collision or unsafe identifier in the new payload
//      throws ProviderError synchronously, BEFORE the pre-read.
//   4. Pre-read miss (entity not found) short-circuits to
//      EntityNotFoundError without burning the write round-trip.

function projectedVertexFixture(
  id: string,
  propertiesBlob: string,
): Record<string, unknown> {
  // Shape that entityFromGremlin consumes — every projected field as a
  // bare scalar (no [{ _value }] wrapper; that wrapper is the Document-
  // endpoint shape, not the Gremlin projection shape).
  return {
    id,
    entityType: 'Person',
    entityLabel: 'Updated Label',
    slug: 'updated-slug',
    summary: '',
    properties: propertiesBlob,
    data: '',
    dataFormat: '',
    createdBy: 'test',
    createdByType: 'agent',
    createdAt: '2026-05-25T00:00:00.000Z',
    createdInConversation: '',
    createdFromMessage: '',
    modifiedBy: 'test',
    modifiedByType: 'agent',
    modifiedAt: '2026-05-25T00:00:01.000Z',
    modifiedInConversation: '',
    modifiedFromMessage: '',
  };
}

interface UpdateStubOptions {
  vertexId: string;
  preReadBlob: Record<string, unknown> | 'missing';
  writeResultBlob: Record<string, unknown>;
}

function setupUpdateStub(stub: SubmitStub, options: UpdateStubOptions): void {
  stub.submit = async (query, params) => {
    stub.calls.push({ query, params });
    if (query.includes(".values('properties').limit(1)")) {
      if (options.preReadBlob === 'missing') return { items: [] };
      return { items: [JSON.stringify(options.preReadBlob)] };
    }
    if (query.includes('.project(')) {
      return {
        items: [projectedVertexFixture(options.vertexId, JSON.stringify(options.writeResultBlob))],
      };
    }
    return { items: [] };
  };
}

function basicProvenanceUpdate() {
  return {
    createdBy: 'test',
    createdByType: 'agent' as const,
    createdAt: '2026-05-25T00:00:00.000Z',
    modifiedBy: 'test',
    modifiedByType: 'agent' as const,
    modifiedAt: '2026-05-25T00:00:01.000Z',
  };
}

describe('updateEntity user-property scalars', () => {
  const VERTEX = '40000000-0000-4000-a000-000000009001';

  function findCalls(stub: SubmitStub) {
    const preRead = stub.calls.filter((c) =>
      c.query.includes(".values('properties').limit(1)"),
    );
    const write = stub.calls.filter((c) => c.query.includes('.project('));
    return { preRead, write };
  }

  it('updates.properties === undefined → no pre-read, no user-property steps', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: { irrelevant: 'never-read' },
      writeResultBlob: {},
    });

    const before = stub.calls.length;
    await provider.updateEntity(TEST_REPO, VERTEX, {
      label: 'Updated Label',
      provenance: basicProvenanceUpdate(),
    });

    const { preRead, write } = findCalls(stub);
    expect(preRead).toHaveLength(0);
    expect(write).toHaveLength(1);
    expect(stub.calls.length - before).toBe(1);

    const writeQuery = write[0]!.query;
    expect(writeQuery).not.toContain('p_user_');
    expect(writeQuery).not.toMatch(/\.sideEffect\(properties\('[^']+'\)\.drop\(\)\)/);
    // The schema-managed `properties` ladder slot is also untouched.
    expect(writeQuery).not.toContain(".property('properties',");
  });

  it('add-only: existing has no scalars, new payload sets two scalars', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: {},
      writeResultBlob: { orgType: 'company', tier: 'premium' },
    });

    await provider.updateEntity(TEST_REPO, VERTEX, {
      properties: { orgType: 'company', tier: 'premium' },
      provenance: basicProvenanceUpdate(),
    });

    const { preRead, write } = findCalls(stub);
    expect(preRead).toHaveLength(1);
    expect(write).toHaveLength(1);

    const q = write[0]!.query;
    expect(q).toContain(".property('orgType', p_user_0)");
    expect(q).toContain(".property('tier', p_user_1)");
    expect(q).not.toMatch(/\.sideEffect\(properties\('[^']+'\)\.drop\(\)\)/);
    const params = write[0]!.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
  });

  it('drop-only: existing has two scalars, new payload is {} → drops both, no sets', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: { orgType: 'company', tier: 'premium' },
      writeResultBlob: {},
    });

    await provider.updateEntity(TEST_REPO, VERTEX, {
      properties: {},
      provenance: basicProvenanceUpdate(),
    });

    const { write } = findCalls(stub);
    const q = write[0]!.query;
    expect(q).toContain(".sideEffect(properties('orgType').drop())");
    expect(q).toContain(".sideEffect(properties('tier').drop())");
    expect(q).not.toContain('p_user_');
    const params = write[0]!.params as Record<string, unknown>;
    expect(params['p_user_0']).toBeUndefined();
  });

  it('mixed: keeps shared keys, drops removed keys, sets added keys', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: { orgType: 'company', tier: 'premium' },
      writeResultBlob: { orgType: 'company', region: 'EMEA' },
    });

    await provider.updateEntity(TEST_REPO, VERTEX, {
      properties: { orgType: 'company', region: 'EMEA' },
      provenance: basicProvenanceUpdate(),
    });

    const { write } = findCalls(stub);
    const q = write[0]!.query;
    // tier is dropped (was a scalar, no longer in the new payload).
    expect(q).toContain(".sideEffect(properties('tier').drop())");
    // orgType is re-emitted even though the value did not change — keeps
    // the per-shape plan-cache entry stable.
    expect(q).toContain(".property('orgType', p_user_0)");
    expect(q).toContain(".property('region', p_user_1)");
    // No drop emitted for orgType (still in the new payload).
    expect(q).not.toContain(".sideEffect(properties('orgType').drop())");
    const params = write[0]!.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('EMEA');
  });

  it('non-storable values in the new payload are dropped from scalars but still round-trip via the blob', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: {},
      writeResultBlob: { orgType: 'company', nested: { a: 1 } },
    });

    await provider.updateEntity(TEST_REPO, VERTEX, {
      properties: { orgType: 'company', nested: { a: 1 } },
      provenance: basicProvenanceUpdate(),
    });

    const { write } = findCalls(stub);
    const q = write[0]!.query;
    expect(q).toContain(".property('orgType', p_user_0)");
    expect(q).not.toContain(".property('nested'");
    // The schema-managed properties ladder slot still carries the full
    // input blob — the non-storable nested value round-trips through JSON.
    const params = write[0]!.params as Record<string, unknown>;
    const propsBindingEntry = Object.entries(params).find(
      ([, v]) => typeof v === 'string' && v === JSON.stringify({ orgType: 'company', nested: { a: 1 } }),
    );
    expect(propsBindingEntry).toBeDefined();
  });

  it('no-op: two updates with the same properties emit byte-identical query strings', async () => {
    const { provider: providerA, stub: stubA } = makeProvider();
    setupUpdateStub(stubA, {
      vertexId: VERTEX,
      preReadBlob: { orgType: 'company', tier: 'premium' },
      writeResultBlob: { orgType: 'company', tier: 'premium' },
    });
    await providerA.updateEntity(TEST_REPO, VERTEX, {
      properties: { orgType: 'company', tier: 'premium' },
      provenance: basicProvenanceUpdate(),
    });

    const { provider: providerB, stub: stubB } = makeProvider();
    setupUpdateStub(stubB, {
      vertexId: VERTEX,
      preReadBlob: { orgType: 'company', tier: 'premium' },
      writeResultBlob: { orgType: 'company', tier: 'premium' },
    });
    await providerB.updateEntity(TEST_REPO, VERTEX, {
      properties: { orgType: 'company', tier: 'premium' },
      provenance: basicProvenanceUpdate(),
    });

    const writeA = stubA.calls.find((c) => c.query.includes('.project('))!;
    const writeB = stubB.calls.find((c) => c.query.includes('.project('))!;
    expect(writeA.query).toBe(writeB.query);
  });

  it('reserved-key collision throws ProviderError synchronously — no pre-read, no write', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: {},
      writeResultBlob: {},
    });

    const before = stub.calls.length;
    await expect(
      provider.updateEntity(TEST_REPO, VERTEX, {
        properties: { entityLabel: 'X' },
        provenance: basicProvenanceUpdate(),
      }),
    ).rejects.toBeInstanceOf(ProviderError);
    const after = stub.calls.length;

    // Validation runs before either round-trip — no calls issued at all.
    expect(after - before).toBe(0);
  });

  it('pre-read miss short-circuits to EntityNotFoundError without burning the write', async () => {
    const { provider, stub } = makeProvider();
    setupUpdateStub(stub, {
      vertexId: VERTEX,
      preReadBlob: 'missing',
      writeResultBlob: {},
    });

    const before = stub.calls.length;
    await expect(
      provider.updateEntity(TEST_REPO, VERTEX, {
        properties: { orgType: 'company' },
        provenance: basicProvenanceUpdate(),
      }),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    const after = stub.calls.length;

    // One round-trip — the pre-read — and no write.
    expect(after - before).toBe(1);
    const { write } = findCalls(stub);
    expect(write).toHaveLength(0);
  });
});

// ─── createRelationship user-property scalars (dual-write) ───────────
//
// Edges follow the same dual-write contract as vertices: native-storable
// user-property values project to per-key edge properties alongside the
// canonical JSON blob, so server-side predicates and aggregations can reach
// them. The contract pins mirror createEntity, with one addition — the
// Gremlin `'label'` token is in the relationship reserved set (it is the
// edge-label slot, set at `addE(edgeLabel)`, and a user property of the same
// name would collide at write time).

function captureRelationshipCreateQuery(): {
  provider: CosmosDbProvider;
  stub: SubmitStub;
  getCreateCall: () => SubmitCall;
} {
  const { provider, stub } = makeProvider();
  stub.submit = async (query, params) => {
    stub.calls.push({ query, params });
    if (query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce(')) {
      return { items: [{ id: 'created-edge' }] };
    }
    return { items: [] };
  };
  return {
    provider,
    stub,
    getCreateCall: () => {
      const call = stub.calls.find((c) =>
        c.query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce('),
      );
      if (!call) throw new Error('no create call captured');
      return call;
    },
  };
}

describe('createRelationship user-property scalars', () => {
  const SRC = '40000000-0000-4000-a000-deadbeef0001';
  const TGT = '40000000-0000-4000-a000-deadbeef0002';

  it('empty user-properties emits the canonical RELATIONSHIP_CREATE_QUERY string byte-for-byte', async () => {
    const { provider, getCreateCall } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a001', SRC, TGT),
      properties: {},
    };

    await provider.createRelationship(TEST_REPO, rel);

    expect(getCreateCall().query).toBe(RELATIONSHIP_CREATE_QUERY);
  });

  it('all-non-storable user-properties collapse to the canonical query — blob still carries them', async () => {
    const { provider, getCreateCall } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a002', SRC, TGT),
      properties: { nested: { a: 1 }, mixed: ['a', 1] },
    };

    await provider.createRelationship(TEST_REPO, rel);

    const call = getCreateCall();
    expect(call.query).toBe(RELATIONSHIP_CREATE_QUERY);
    // The canonical `properties` ladder binding (p4 in the relationship ladder
    // — relationshipType/sourceEntityId/targetEntityId/bidirectional precede
    // it) still serialises the full input blob — non-storable values round-
    // trip via JSON.
    const propertiesBlob = (call.params as Record<string, unknown>)['p4'];
    expect(propertiesBlob).toBe(JSON.stringify({ nested: { a: 1 }, mixed: ['a', 1] }));
  });

  it('appends one .property suffix per native-storable user key in insertion order', async () => {
    const { provider, getCreateCall } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a003', SRC, TGT),
      properties: { weight: 0.8, since: '2026-01-01', active: true },
    };

    await provider.createRelationship(TEST_REPO, rel);

    const call = getCreateCall();
    expect(call.query).toContain(".property('weight', p_user_0)");
    expect(call.query).toContain(".property('since', p_user_1)");
    expect(call.query).toContain(".property('active', p_user_2)");
    // Order is part of the cache key — verify literal substring order.
    const weightIdx = call.query.indexOf(".property('weight', p_user_0)");
    const sinceIdx = call.query.indexOf(".property('since', p_user_1)");
    const activeIdx = call.query.indexOf(".property('active', p_user_2)");
    expect(weightIdx).toBeGreaterThan(-1);
    expect(sinceIdx).toBeGreaterThan(weightIdx);
    expect(activeIdx).toBeGreaterThan(sinceIdx);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
    expect(params['p_user_1']).toBe('2026-01-01');
    expect(params['p_user_2']).toBe(true);
  });

  it('drops non-storable values from the suffix; storable siblings still appear', async () => {
    const { provider, getCreateCall } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a004', SRC, TGT),
      properties: {
        weight: 0.8,
        nested: { a: 1 },
        mixed: ['a', 1],
        since: '2026-01-01',
      },
    };

    await provider.createRelationship(TEST_REPO, rel);

    const call = getCreateCall();
    expect(call.query).toContain(".property('weight', p_user_0)");
    expect(call.query).toContain(".property('since', p_user_1)");
    expect(call.query).not.toContain(".property('nested'");
    expect(call.query).not.toContain(".property('mixed'");
    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
    expect(params['p_user_1']).toBe('2026-01-01');
    expect(params['p_user_2']).toBeUndefined();
  });

  it('throws ProviderError on a reserved-key collision before any round-trip', async () => {
    const { provider, stub } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a005', SRC, TGT),
      properties: { relationshipType: 'X' },
    };

    const before = stub.calls.length;
    await expect(provider.createRelationship(TEST_REPO, rel)).rejects.toBeInstanceOf(ProviderError);
    const after = stub.calls.length;

    const createCalls = stub.calls
      .slice(before, after)
      .filter((c) =>
        c.query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce('),
      );
    expect(createCalls).toHaveLength(0);
  });

  it("throws ProviderError on the Gremlin 'label' token collision (edge-label slot)", async () => {
    const { provider, stub } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a006', SRC, TGT),
      properties: { label: 'X' },
    };

    const before = stub.calls.length;
    await expect(provider.createRelationship(TEST_REPO, rel)).rejects.toThrow(/collides/);
    const after = stub.calls.length;
    const createCalls = stub.calls
      .slice(before, after)
      .filter((c) =>
        c.query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce('),
      );
    expect(createCalls).toHaveLength(0);
  });

  it('throws ProviderError on an unsafe identifier (rejects before round-trip)', async () => {
    const { provider, stub } = captureRelationshipCreateQuery();
    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a007', SRC, TGT),
      properties: { 'has-dash': 'X' },
    };

    const before = stub.calls.length;
    await expect(provider.createRelationship(TEST_REPO, rel)).rejects.toThrow(
      /not a valid Gremlin identifier/,
    );
    const after = stub.calls.length;
    const createCalls = stub.calls
      .slice(before, after)
      .filter((c) =>
        c.query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce('),
      );
    expect(createCalls).toHaveLength(0);
  });

  it('duplicate-detection sentinel path still fires when scalars are present', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce(')) {
        return { items: ['__duplicate'] };
      }
      return { items: [] };
    };

    const rel: StoredRelationship = {
      ...makeRelationship('40000000-0000-4000-a000-00000000a008', SRC, TGT),
      properties: { weight: 0.8 },
    };

    await expect(provider.createRelationship(TEST_REPO, rel)).rejects.toBeInstanceOf(
      DuplicateRelationshipError,
    );
    const lastCall = stub.calls[stub.calls.length - 1]!;
    // Suffix is present in the duplicate-path query too — the addE branch
    // carries the scalars whether or not it fires at runtime.
    expect(lastCall.query).toContain(".property('weight', p_user_0)");
  });
});

// ─── Single round-trip delete paths ──────────────────────────────────
//
// The aggregate('found').by('id').drop().cap('found') pattern collapses the
// previous existence-check + drop into one Gremlin round-trip per chunk. The
// bucket emits a list of ids the drop actually touched; the caller derives
// notFound = requestedIds - foundIds client-side.
//
// Shape verified live against the Cosmos emulator 2026-05-25.

// Shared bulk-test helpers used by the partition-key shape test and by the
// `importBulk user-property scalars` block further down. The same fixtures and
// the same coalesce-branch splitter feed both — keeping them in one place
// avoids drift between the two test surfaces that inspect the upsert query.

function makeStoredBulkEntity(id: string, properties: Record<string, unknown> = { key: 'value' }): StoredEntity {
  const now = new Date().toISOString();
  return {
    id,
    slug: 'test-type:' + id,
    entityType: 'test-type',
    label: id,
    summary: 'S',
    properties,
    provenance: {
      createdBy: 'x', createdByType: 'agent', createdAt: now,
      modifiedBy: 'x', modifiedByType: 'agent', modifiedAt: now,
    },
  };
}

function makeStoredBulkRelationship(id: string, properties: Record<string, unknown> = {}): StoredRelationship {
  const now = new Date().toISOString();
  return {
    id,
    relationshipType: 'LINKS',
    sourceEntityId: 'src',
    targetEntityId: 'tgt',
    properties,
    bidirectional: false,
    provenance: {
      createdBy: 'x', createdByType: 'agent', createdAt: now,
      modifiedBy: 'x', modifiedByType: 'agent', modifiedAt: now,
    },
  };
}

// Split an upsert coalesce(update, create) query into the two branches.
// Branches are separated by `, ` at the depth of the unfold/addV terminal;
// the ladder's optional-slot `choose(__.constant(...).is(neq(...)),
// __.property(...), __.identity())` blocks introduce their own `, ` at deeper
// paren levels, so a naive first-`, ` scan splits inside the ladder rather
// than at the branch boundary. Track paren depth and pick the comma at
// depth 0 of the tail (which corresponds to depth 1 of the outer coalesce).
function splitCoalesceBranches(query: string): { update: string; create: string } {
  const idx = query.indexOf('unfold()');
  expect(idx).toBeGreaterThan(-1);
  const tail = query.slice(idx);
  let depth = 0;
  for (let i = 0; i < tail.length - 1; i++) {
    const ch = tail[i];
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    else if (depth === 0 && ch === ',' && tail[i + 1] === ' ') {
      return { update: tail.slice(0, i), create: tail.slice(i + 2) };
    }
  }
  throw new Error('coalesce branch separator not found');
}

describe('single-round-trip delete paths', () => {
  const ENTITY_A = '40000000-0000-4000-a000-000000007001';
  const ENTITY_B = '40000000-0000-4000-a000-000000007002';
  const ENTITY_MISSING = '40000000-0000-4000-a000-000000007999';

  it('deleteEntities issues exactly one storage call per chunk on success', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("aggregate('found')") && query.startsWith('g.V().')) {
        // Bucket emits the matched ids; ENTITY_MISSING is filtered out by the
        // partition+id predicate on the server.
        return { items: [[ENTITY_A, ENTITY_B]] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.deleteEntities(TEST_REPO, [ENTITY_A, ENTITY_B, ENTITY_MISSING]);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.deleted).toEqual([ENTITY_A, ENTITY_B]);
    expect(result.notFound).toEqual([ENTITY_MISSING]);

    const issued = stub.calls[stub.calls.length - 1]!;
    expect(issued.query).toContain("aggregate('found').by('id')");
    expect(issued.query).toContain('.drop()');
    expect(issued.query).toContain(".cap('found')");
    expect(issued.query).not.toContain('.values(');
  });

  it('deleteEntities returns all ids as notFound when the bucket is empty', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("aggregate('found')") && query.startsWith('g.V().')) {
        return { items: [[]] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.deleteEntities(TEST_REPO, [ENTITY_MISSING]);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.deleted).toEqual([]);
    expect(result.notFound).toEqual([ENTITY_MISSING]);
  });

  it('deleteRelationships issues exactly one storage call per chunk and splits deleted/notFound', async () => {
    const { provider, stub } = makeProvider();
    const REL_A = '40000000-0000-4000-a000-000000007010';
    const REL_B = '40000000-0000-4000-a000-000000007011';
    const REL_MISSING = '40000000-0000-4000-a000-000000007099';

    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("aggregate('found')") && query.startsWith('g.E().')) {
        return { items: [[REL_A, REL_B]] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.deleteRelationships(TEST_REPO, [REL_A, REL_B, REL_MISSING]);
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.deleted).toEqual([REL_A, REL_B]);
    expect(result.notFound).toEqual([REL_MISSING]);

    const issued = stub.calls[stub.calls.length - 1]!;
    expect(issued.query).toContain("aggregate('found').by('id')");
    expect(issued.query).toContain('.drop()');
    expect(issued.query).toContain(".cap('found')");
  });

  it('deleteEntitiesByType issues one storage call and reports deletedRelationships as undefined', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("aggregate('found')") && query.includes("has('entityType', etype)")) {
        return { items: [[ENTITY_A, ENTITY_B]] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.deleteEntitiesByType(TEST_REPO, 'Person');
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.deletedEntities).toBe(2);
    expect(result.deletedRelationships).toBeUndefined();

    const issued = stub.calls[stub.calls.length - 1]!;
    expect(issued.query).not.toContain('.count()');
    expect(issued.query).not.toContain('bothE()');
    expect(issued.query).toContain("aggregate('found').by('id')");
  });

  it('deleteRelationshipsByType issues one storage call and returns the bucket count', async () => {
    const { provider, stub } = makeProvider();
    const REL_X = '40000000-0000-4000-a000-000000007020';
    const REL_Y = '40000000-0000-4000-a000-000000007021';
    const REL_Z = '40000000-0000-4000-a000-000000007022';

    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("aggregate('found')") && query.startsWith('g.E().')) {
        return { items: [[REL_X, REL_Y, REL_Z]] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.deleteRelationshipsByType(TEST_REPO, 'KNOWS');
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.deletedRelationships).toBe(3);

    const issued = stub.calls[stub.calls.length - 1]!;
    expect(issued.query).not.toContain('.count()');
    expect(issued.query).toContain("aggregate('found').by('id')");
  });

  // ─── upsertEntity / upsertRelationship partition-key constraint ────
  //
  // Cosmos rejects `.property('repositoryId', ...)` after `unfold()` at
  // parse time as "Partition key property of a vertex is readonly", which
  // killed the entire coalesce — including the create branch on brand-new
  // entities. The fix splits propParts into update vs create; this test
  // locks the SQL shape so the bug doesn't come back.

  it("upsertEntity omits .property('repositoryId', ...) on the unfold branch but keeps it on addV", async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-000000007100';

    await provider.importBulk(TEST_REPO, [
      { entities: [makeStoredBulkEntity(ENTITY_ID)] },
    ]);

    const upsert = stub.calls.find((c) => c.query.includes('addV(vertexLabel)'));
    expect(upsert).toBeDefined();
    const { update, create } = splitCoalesceBranches(upsert!.query);
    expect(update).not.toMatch(/\.property\('repositoryId',/);
    expect(create).toMatch(/\.property\('repositoryId',/);
  });

  it("upsertRelationship omits .property('repositoryId', ...) on the unfold branch but keeps it on addE", async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-000000007101';

    await provider.importBulk(TEST_REPO, [
      { relationships: [makeStoredBulkRelationship(REL_ID)] },
    ]);

    const upsert = stub.calls.find((c) => c.query.includes('addE(edgeLabel)'));
    expect(upsert).toBeDefined();
    const { update, create } = splitCoalesceBranches(upsert!.query);
    expect(update).not.toMatch(/\.property\('repositoryId',/);
    expect(create).toMatch(/\.property\('repositoryId',/);
  });
});

// ─── importBulk user-property scalars (dual-write) ─────────────────────
//
// Bulk upsert mirrors the per-entity create dual-write contract on BOTH
// halves of the coalesce(update-branch, create-branch). The emitted suffix
// is the same `.property('<key>', p_user_<i>)` chain on each branch with
// shared `p_user_*` bindings, so whichever branch fires at runtime ends up
// with the same scalar shape on the vertex/edge. The contract pins:
//   1. Native-storable values append one .property step per key in
//      insertion order on both branches.
//   2. Non-storable values stay only in the canonical JSON `properties`
//      blob (the ladder slot) — they round-trip via the read path but are
//      not predicate-queryable.
//   3. Reserved-name collisions and unsafe identifiers raise ProviderError
//      synchronously, before any submit (same contract as `createEntity` /
//      `createRelationship`).
//   4. The update branch is ADD/OVERWRITE only — no drop steps emit for
//      stale keys, because bulk import skips the per-entity pre-read.
//      Callers needing exact drop-on-omit semantics use the per-entity
//      update path instead.

function findUpsertEntityCall(stub: SubmitStub): SubmitCall {
  const call = stub.calls.find((c) => c.query.includes('addV(vertexLabel)'));
  if (!call) throw new Error('no upsertEntity call captured');
  return call;
}

function findUpsertRelationshipCall(stub: SubmitStub): SubmitCall {
  const call = stub.calls.find((c) => c.query.includes('addE(edgeLabel)'));
  if (!call) throw new Error('no upsertRelationship call captured');
  return call;
}

describe('importBulk user-property scalars', () => {
  // Entities ─────────────────────────────────────────────────────────────

  it('upsertEntity emits the scalar suffix on the create branch in insertion order with values bound', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000b001';

    await provider.importBulk(TEST_REPO, [
      {
        entities: [
          makeStoredBulkEntity(ENTITY_ID, { orgType: 'company', tier: 'premium', headcount: 42 }),
        ],
      },
    ]);

    const call = findUpsertEntityCall(stub);
    const { create } = splitCoalesceBranches(call.query);
    expect(create).toContain(".property('orgType', p_user_0)");
    expect(create).toContain(".property('tier', p_user_1)");
    expect(create).toContain(".property('headcount', p_user_2)");
    const orgIdx = create.indexOf(".property('orgType', p_user_0)");
    const tierIdx = create.indexOf(".property('tier', p_user_1)");
    const hcIdx = create.indexOf(".property('headcount', p_user_2)");
    expect(orgIdx).toBeGreaterThan(-1);
    expect(tierIdx).toBeGreaterThan(orgIdx);
    expect(hcIdx).toBeGreaterThan(tierIdx);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
    expect(params['p_user_2']).toBe(42);
  });

  it('upsertEntity emits the same scalar suffix on the update branch with no drop steps', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000b002';

    await provider.importBulk(TEST_REPO, [
      {
        entities: [
          makeStoredBulkEntity(ENTITY_ID, { orgType: 'company', tier: 'premium' }),
        ],
      },
    ]);

    const call = findUpsertEntityCall(stub);
    const { update } = splitCoalesceBranches(call.query);
    expect(update).toContain(".property('orgType', p_user_0)");
    expect(update).toContain(".property('tier', p_user_1)");
    const orgIdx = update.indexOf(".property('orgType', p_user_0)");
    const tierIdx = update.indexOf(".property('tier', p_user_1)");
    expect(orgIdx).toBeGreaterThan(-1);
    expect(tierIdx).toBeGreaterThan(orgIdx);

    // Bulk path is ADD/OVERWRITE only — no drop steps emit. Callers needing
    // exact drop-on-omit semantics fall back to per-entity updateEntity.
    expect(update).not.toMatch(/\.sideEffect\(properties\('[^']+'\)\.drop\(\)\)/);
  });

  it('upsertEntity emits the same scalar suffix on BOTH branches of the coalesce', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000b003';

    await provider.importBulk(TEST_REPO, [
      {
        entities: [
          makeStoredBulkEntity(ENTITY_ID, { orgType: 'company', tier: 'premium' }),
        ],
      },
    ]);

    const call = findUpsertEntityCall(stub);
    const { update, create } = splitCoalesceBranches(call.query);
    const expectedSuffix = `.property('orgType', p_user_0).property('tier', p_user_1)`;
    expect(update).toContain(expectedSuffix);
    expect(create).toContain(expectedSuffix);
  });

  it('upsertEntity drops non-storable values from the suffix; the blob ladder slot still carries them via JSON', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000b004';
    const inputProperties = {
      orgType: 'company',
      nested: { a: 1 },
      mixed: ['a', 1],
      tier: 'premium',
    };

    await provider.importBulk(TEST_REPO, [
      { entities: [makeStoredBulkEntity(ENTITY_ID, inputProperties)] },
    ]);

    const call = findUpsertEntityCall(stub);
    const { update, create } = splitCoalesceBranches(call.query);
    for (const branch of [update, create]) {
      expect(branch).toContain(".property('orgType', p_user_0)");
      expect(branch).toContain(".property('tier', p_user_1)");
      expect(branch).not.toContain(".property('nested'");
      expect(branch).not.toContain(".property('mixed'");
    }

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
    expect(params['p_user_2']).toBeUndefined();
    // The canonical `properties` ladder binding (p3 in the entity ladder) still
    // serialises the full input blob — non-storable values round-trip via JSON.
    expect(params['p3']).toBe(JSON.stringify(inputProperties));
  });

  it('upsertEntity throws ProviderError on a reserved-key collision before any submit', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000b005';

    const before = stub.calls.length;
    const result = await provider.importBulk(TEST_REPO, [
      {
        entities: [
          makeStoredBulkEntity(ENTITY_ID, { entityLabel: 'X' }),
        ],
      },
    ]);
    const after = stub.calls.length;

    // Validation fails synchronously inside the bulk worker — the import
    // surfaces the error per item, no upsert query is issued.
    const upsertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('addV(vertexLabel)'));
    expect(upsertCalls).toHaveLength(0);
    expect(result.entitiesImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`entity:${ENTITY_ID}`);
    expect(result.errors[0]!.error).toMatch(/collides/);
  });

  it('upsertEntity throws ProviderError on an unsafe identifier before any submit', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000b006';

    const before = stub.calls.length;
    const result = await provider.importBulk(TEST_REPO, [
      {
        entities: [
          makeStoredBulkEntity(ENTITY_ID, { 'has-dash': 'X' }),
        ],
      },
    ]);
    const after = stub.calls.length;

    const upsertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('addV(vertexLabel)'));
    expect(upsertCalls).toHaveLength(0);
    expect(result.entitiesImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`entity:${ENTITY_ID}`);
    expect(result.errors[0]!.error).toMatch(/not a valid Gremlin identifier/);
  });

  // Relationships ────────────────────────────────────────────────────────

  it('upsertRelationship emits the scalar suffix on the create branch in insertion order with values bound', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b101';

    await provider.importBulk(TEST_REPO, [
      {
        relationships: [
          makeStoredBulkRelationship(REL_ID, { weight: 0.8, since: '2026-01-01', active: true }),
        ],
      },
    ]);

    const call = findUpsertRelationshipCall(stub);
    const { create } = splitCoalesceBranches(call.query);
    expect(create).toContain(".property('weight', p_user_0)");
    expect(create).toContain(".property('since', p_user_1)");
    expect(create).toContain(".property('active', p_user_2)");
    const weightIdx = create.indexOf(".property('weight', p_user_0)");
    const sinceIdx = create.indexOf(".property('since', p_user_1)");
    const activeIdx = create.indexOf(".property('active', p_user_2)");
    expect(weightIdx).toBeGreaterThan(-1);
    expect(sinceIdx).toBeGreaterThan(weightIdx);
    expect(activeIdx).toBeGreaterThan(sinceIdx);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
    expect(params['p_user_1']).toBe('2026-01-01');
    expect(params['p_user_2']).toBe(true);
  });

  it('upsertRelationship emits the same scalar suffix on the update branch with no drop steps', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b102';

    await provider.importBulk(TEST_REPO, [
      {
        relationships: [
          makeStoredBulkRelationship(REL_ID, { weight: 0.8, since: '2026-01-01' }),
        ],
      },
    ]);

    const call = findUpsertRelationshipCall(stub);
    const { update } = splitCoalesceBranches(call.query);
    expect(update).toContain(".property('weight', p_user_0)");
    expect(update).toContain(".property('since', p_user_1)");
    const weightIdx = update.indexOf(".property('weight', p_user_0)");
    const sinceIdx = update.indexOf(".property('since', p_user_1)");
    expect(weightIdx).toBeGreaterThan(-1);
    expect(sinceIdx).toBeGreaterThan(weightIdx);

    expect(update).not.toMatch(/\.sideEffect\(properties\('[^']+'\)\.drop\(\)\)/);
  });

  it('upsertRelationship emits the same scalar suffix on BOTH branches of the coalesce', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b103';

    await provider.importBulk(TEST_REPO, [
      {
        relationships: [
          makeStoredBulkRelationship(REL_ID, { weight: 0.8, since: '2026-01-01' }),
        ],
      },
    ]);

    const call = findUpsertRelationshipCall(stub);
    const { update, create } = splitCoalesceBranches(call.query);
    const expectedSuffix = `.property('weight', p_user_0).property('since', p_user_1)`;
    expect(update).toContain(expectedSuffix);
    expect(create).toContain(expectedSuffix);
  });

  it('upsertRelationship drops non-storable values from the suffix; the blob ladder slot still carries them via JSON', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b104';
    const inputProperties = {
      weight: 0.8,
      nested: { a: 1 },
      mixed: ['a', 1],
      since: '2026-01-01',
    };

    await provider.importBulk(TEST_REPO, [
      { relationships: [makeStoredBulkRelationship(REL_ID, inputProperties)] },
    ]);

    const call = findUpsertRelationshipCall(stub);
    const { update, create } = splitCoalesceBranches(call.query);
    for (const branch of [update, create]) {
      expect(branch).toContain(".property('weight', p_user_0)");
      expect(branch).toContain(".property('since', p_user_1)");
      expect(branch).not.toContain(".property('nested'");
      expect(branch).not.toContain(".property('mixed'");
    }

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
    expect(params['p_user_1']).toBe('2026-01-01');
    expect(params['p_user_2']).toBeUndefined();
    // The canonical `properties` ladder binding (p4 in the relationship ladder
    // — relationshipType/sourceEntityId/targetEntityId/bidirectional precede
    // it) still serialises the full input blob.
    expect(params['p4']).toBe(JSON.stringify(inputProperties));
  });

  it('upsertRelationship throws ProviderError on a reserved-key collision before any submit', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b105';

    const before = stub.calls.length;
    const result = await provider.importBulk(TEST_REPO, [
      {
        relationships: [
          makeStoredBulkRelationship(REL_ID, { relationshipType: 'X' }),
        ],
      },
    ]);
    const after = stub.calls.length;

    const upsertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('addE(edgeLabel)'));
    expect(upsertCalls).toHaveLength(0);
    expect(result.relationshipsImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`relationship:${REL_ID}`);
    expect(result.errors[0]!.error).toMatch(/collides/);
  });

  it("upsertRelationship throws ProviderError on the Gremlin 'label' token collision (edge-label slot)", async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b106';

    const before = stub.calls.length;
    const result = await provider.importBulk(TEST_REPO, [
      {
        relationships: [
          makeStoredBulkRelationship(REL_ID, { label: 'X' }),
        ],
      },
    ]);
    const after = stub.calls.length;

    const upsertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('addE(edgeLabel)'));
    expect(upsertCalls).toHaveLength(0);
    expect(result.relationshipsImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`relationship:${REL_ID}`);
    expect(result.errors[0]!.error).toMatch(/collides/);
  });

  it('upsertRelationship throws ProviderError on an unsafe identifier before any submit', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000b107';

    const before = stub.calls.length;
    const result = await provider.importBulk(TEST_REPO, [
      {
        relationships: [
          makeStoredBulkRelationship(REL_ID, { 'has-dash': 'X' }),
        ],
      },
    ]);
    const after = stub.calls.length;

    const upsertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('addE(edgeLabel)'));
    expect(upsertCalls).toHaveLength(0);
    expect(result.relationshipsImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`relationship:${REL_ID}`);
    expect(result.errors[0]!.error).toMatch(/not a valid Gremlin identifier/);
  });
});

// ─── importBulk(skipExistenceCheck: true) user-property scalars ────────
//
// The skip-existence-check bulk path emits the fixed `INSERT_*_QUERY`
// strings via `insertEntity` / `insertRelationship`. Before this contract
// landed, those queries ended at the ladder chain and produced blob-only
// rows — `createEntity` and `upsertEntity` dual-wrote scalars while the
// insert path did not, so the same container could hold two structurally
// different storage shapes depending on which write path produced the row.
// The insert path now appends the same per-key user-property suffix the
// upsert paths use so every dual-write entry point honours the contract.
//
// The findInsertEntityCall / findInsertRelationshipCall helpers
// discriminate against the upsert query shape by excluding `.fold().
// coalesce(` — the insert path does not branch.

function findInsertEntityCall(stub: SubmitStub): SubmitCall {
  const call = stub.calls.find(
    (c) => c.query.startsWith('g.addV(vertexLabel)') && !c.query.includes('.fold().coalesce('),
  );
  if (!call) throw new Error('no insertEntity call captured');
  return call;
}

function findInsertRelationshipCall(stub: SubmitStub): SubmitCall {
  const call = stub.calls.find(
    (c) =>
      c.query.includes('.addE(edgeLabel)') &&
      !c.query.includes('.fold().coalesce(') &&
      c.query.startsWith("g.V().has('repositoryId', rid).hasId(srcId)"),
  );
  if (!call) throw new Error('no insertRelationship call captured');
  return call;
}

describe('importBulk(skipExistenceCheck) user-property scalars', () => {
  // Entities ─────────────────────────────────────────────────────────────

  it('insertEntity emits the byte-identical fixed query when no native-storable properties are present', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000c001';

    await provider.importBulk(
      TEST_REPO,
      [{ entities: [makeStoredBulkEntity(ENTITY_ID, {})] }],
      { skipExistenceCheck: true },
    );

    const call = findInsertEntityCall(stub);
    // Locks the zero-plan-cache-regression invariant — no per-key suffix
    // appended, so the canonical INSERT_ENTITY_QUERY string is what hit
    // the wire.
    expect(call.query).not.toContain('p_user_');
    expect(call.query.endsWith(')')).toBe(true);
    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBeUndefined();
  });

  it('insertEntity appends a single-key scalar suffix after the ladder with the value bound', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000c002';

    await provider.importBulk(
      TEST_REPO,
      [{ entities: [makeStoredBulkEntity(ENTITY_ID, { orgType: 'company' })] }],
      { skipExistenceCheck: true },
    );

    const call = findInsertEntityCall(stub);
    expect(call.query).toContain(".property('orgType', p_user_0)");
    // Suffix is appended at the tail of the ladder — no intervening
    // ladder slot can come after it.
    expect(call.query.endsWith(".property('orgType', p_user_0)")).toBe(true);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
  });

  it('insertEntity emits multi-key scalars in deterministic insertion order with sequential bindings', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000c003';

    await provider.importBulk(
      TEST_REPO,
      [
        {
          entities: [
            makeStoredBulkEntity(ENTITY_ID, {
              orgType: 'company',
              tier: 'premium',
              headcount: 42,
            }),
          ],
        },
      ],
      { skipExistenceCheck: true },
    );

    const call = findInsertEntityCall(stub);
    expect(call.query).toContain(".property('orgType', p_user_0)");
    expect(call.query).toContain(".property('tier', p_user_1)");
    expect(call.query).toContain(".property('headcount', p_user_2)");
    const orgIdx = call.query.indexOf(".property('orgType', p_user_0)");
    const tierIdx = call.query.indexOf(".property('tier', p_user_1)");
    const hcIdx = call.query.indexOf(".property('headcount', p_user_2)");
    expect(orgIdx).toBeGreaterThan(-1);
    expect(tierIdx).toBeGreaterThan(orgIdx);
    expect(hcIdx).toBeGreaterThan(tierIdx);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
    expect(params['p_user_2']).toBe(42);
  });

  it('insertEntity throws ProviderError on a reserved-key collision before any submit', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000c004';

    const before = stub.calls.length;
    const result = await provider.importBulk(
      TEST_REPO,
      [{ entities: [makeStoredBulkEntity(ENTITY_ID, { entityType: 'X' })] }],
      { skipExistenceCheck: true },
    );
    const after = stub.calls.length;

    const insertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.startsWith('g.addV(vertexLabel)'));
    expect(insertCalls).toHaveLength(0);
    expect(result.entitiesImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`entity:${ENTITY_ID}`);
    expect(result.errors[0]!.error).toMatch(/collides/);
  });

  it('insertEntity drops non-storable values from the suffix; the blob ladder slot still carries them via JSON', async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-00000000c005';
    const inputProperties = {
      orgType: 'company',
      nested: { a: 1 },
      mixed: ['a', 1],
      tier: 'premium',
    };

    await provider.importBulk(
      TEST_REPO,
      [{ entities: [makeStoredBulkEntity(ENTITY_ID, inputProperties)] }],
      { skipExistenceCheck: true },
    );

    const call = findInsertEntityCall(stub);
    expect(call.query).toContain(".property('orgType', p_user_0)");
    expect(call.query).toContain(".property('tier', p_user_1)");
    expect(call.query).not.toContain(".property('nested'");
    expect(call.query).not.toContain(".property('mixed'");

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe('company');
    expect(params['p_user_1']).toBe('premium');
    expect(params['p_user_2']).toBeUndefined();
    // p3 in the entity ladder is the canonical `properties` JSON blob —
    // non-storable values round-trip through the blob even though they
    // are excluded from the scalar suffix.
    expect(params['p3']).toBe(JSON.stringify(inputProperties));
  });

  // Relationships ────────────────────────────────────────────────────────

  it('insertRelationship emits the byte-identical fixed query when no native-storable properties are present', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000c101';

    await provider.importBulk(
      TEST_REPO,
      [{ relationships: [makeStoredBulkRelationship(REL_ID, {})] }],
      { skipExistenceCheck: true },
    );

    const call = findInsertRelationshipCall(stub);
    expect(call.query).not.toContain('p_user_');
    expect(call.query.endsWith(')')).toBe(true);
    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBeUndefined();
  });

  it('insertRelationship appends a single-key scalar suffix after the ladder with the value bound', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000c102';

    await provider.importBulk(
      TEST_REPO,
      [{ relationships: [makeStoredBulkRelationship(REL_ID, { weight: 0.8 })] }],
      { skipExistenceCheck: true },
    );

    const call = findInsertRelationshipCall(stub);
    expect(call.query).toContain(".property('weight', p_user_0)");
    expect(call.query.endsWith(".property('weight', p_user_0)")).toBe(true);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
  });

  it('insertRelationship emits multi-key scalars in deterministic insertion order with sequential bindings', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000c103';

    await provider.importBulk(
      TEST_REPO,
      [
        {
          relationships: [
            makeStoredBulkRelationship(REL_ID, {
              weight: 0.8,
              since: '2026-01-01',
              active: true,
            }),
          ],
        },
      ],
      { skipExistenceCheck: true },
    );

    const call = findInsertRelationshipCall(stub);
    expect(call.query).toContain(".property('weight', p_user_0)");
    expect(call.query).toContain(".property('since', p_user_1)");
    expect(call.query).toContain(".property('active', p_user_2)");
    const weightIdx = call.query.indexOf(".property('weight', p_user_0)");
    const sinceIdx = call.query.indexOf(".property('since', p_user_1)");
    const activeIdx = call.query.indexOf(".property('active', p_user_2)");
    expect(weightIdx).toBeGreaterThan(-1);
    expect(sinceIdx).toBeGreaterThan(weightIdx);
    expect(activeIdx).toBeGreaterThan(sinceIdx);

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
    expect(params['p_user_1']).toBe('2026-01-01');
    expect(params['p_user_2']).toBe(true);
  });

  it('insertRelationship throws ProviderError on a reserved-key collision before any submit', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000c104';

    const before = stub.calls.length;
    const result = await provider.importBulk(
      TEST_REPO,
      [{ relationships: [makeStoredBulkRelationship(REL_ID, { relationshipType: 'X' })] }],
      { skipExistenceCheck: true },
    );
    const after = stub.calls.length;

    const insertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('.addE(edgeLabel)'));
    expect(insertCalls).toHaveLength(0);
    expect(result.relationshipsImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`relationship:${REL_ID}`);
    expect(result.errors[0]!.error).toMatch(/collides/);
  });

  it("insertRelationship throws ProviderError on the Gremlin 'label' token collision (edge-label slot)", async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000c105';

    const before = stub.calls.length;
    const result = await provider.importBulk(
      TEST_REPO,
      [{ relationships: [makeStoredBulkRelationship(REL_ID, { label: 'X' })] }],
      { skipExistenceCheck: true },
    );
    const after = stub.calls.length;

    const insertCalls = stub.calls
      .slice(before, after)
      .filter((c) => c.query.includes('.addE(edgeLabel)'));
    expect(insertCalls).toHaveLength(0);
    expect(result.relationshipsImported).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.item).toBe(`relationship:${REL_ID}`);
    expect(result.errors[0]!.error).toMatch(/collides/);
  });

  it('insertRelationship drops non-storable values from the suffix; the blob ladder slot still carries them via JSON', async () => {
    const { provider, stub } = makeProvider();
    const REL_ID = '40000000-0000-4000-a000-00000000c106';
    const inputProperties = {
      weight: 0.8,
      nested: { a: 1 },
      mixed: ['a', 1],
      since: '2026-01-01',
    };

    await provider.importBulk(
      TEST_REPO,
      [{ relationships: [makeStoredBulkRelationship(REL_ID, inputProperties)] }],
      { skipExistenceCheck: true },
    );

    const call = findInsertRelationshipCall(stub);
    expect(call.query).toContain(".property('weight', p_user_0)");
    expect(call.query).toContain(".property('since', p_user_1)");
    expect(call.query).not.toContain(".property('nested'");
    expect(call.query).not.toContain(".property('mixed'");

    const params = call.params as Record<string, unknown>;
    expect(params['p_user_0']).toBe(0.8);
    expect(params['p_user_1']).toBe('2026-01-01');
    expect(params['p_user_2']).toBeUndefined();
    // p4 in the relationship ladder is the canonical `properties` JSON
    // blob — relationshipType/sourceEntityId/targetEntityId/bidirectional
    // precede it (p0..p3).
    expect(params['p4']).toBe(JSON.stringify(inputProperties));
  });
});

// ─── Step D — findEntities routes through the Document (SQL) endpoint ─
//
// The Gremlin JS-filter fan-out is gone. All findEntities calls — with or
// without searchTerm / properties — go through CosmosDocumentClient.query
// against the Cosmos NoSQL endpoint. The Gremlin connection is no longer
// touched on this path. These tests inject a stub docClient and assert the
// SQL shape, parameter binding, parallel COUNT, and properties prefilter +
// client-side exact-match.

interface DocQueryCall {
  sql: string;
  parameters: CosmosQueryParameter[];
  partitionKey: string | undefined;
}

interface DocClientStub {
  query<T>(
    sql: string,
    parameters: CosmosQueryParameter[],
    options: { partitionKey?: string },
  ): Promise<CosmosQueryResult<T>>;
  calls: DocQueryCall[];
  /** Override per test to shape returned documents/count by SQL inspection. */
  respond: (sql: string) => unknown[];
}

function makeDocClientStub(): DocClientStub {
  const stub: DocClientStub = {
    calls: [],
    respond: () => [],
    async query<T>(
      sql: string,
      parameters: CosmosQueryParameter[],
      options: { partitionKey?: string },
    ): Promise<CosmosQueryResult<T>> {
      stub.calls.push({ sql, parameters, partitionKey: options.partitionKey });
      return {
        documents: stub.respond(sql) as T[],
        requestCharge: 0,
        queryMetrics: null,
        continuationToken: null,
      };
    },
  };
  return stub;
}

function makeProviderWithDocStub(): { provider: CosmosDbProvider; doc: DocClientStub } {
  const { provider } = makeProvider();
  const doc = makeDocClientStub();
  (provider as unknown as { docClient: DocClientStub }).docClient = doc;
  return { provider, doc };
}

describe('Step D findEntities SQL shape', () => {
  it('binds the partition predicate and pins the partition key on every query', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, { limit: 10, offset: 0 });

    expect(doc.calls).toHaveLength(2);
    for (const call of doc.calls) {
      expect(call.sql).toContain('c.repositoryId = @rid');
      expect(call.parameters).toContainEqual({ name: '@rid', value: TEST_REPO });
      expect(call.partitionKey).toBe(TEST_REPO);
    }
  });

  it('filters out _repository / _vocabulary system vertices via IS_DEFINED(c.entityType)', async () => {
    // Regression — the system vertices share the partition with entities and
    // lack an `entityType` property; without this filter they leak into the
    // result page and break pagination math (conformance suite caught this
    // running against the live emulator on 2026-05-26).
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, { limit: 10, offset: 0 });

    for (const call of doc.calls) {
      expect(call.sql).toContain('IS_DEFINED(c.entityType)');
    }
  });

  it('emits searchTerm as OR of case-insensitive CONTAINS across label/slug/summary', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, { searchTerm: 'ALPHA', limit: 10, offset: 0 });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).toContain('CONTAINS(c.entityLabel[0]._value, @term, true)');
    expect(data.sql).toContain('CONTAINS(c.slug[0]._value, @term, true)');
    expect(data.sql).toContain('CONTAINS(c.summary[0]._value, @term, true)');
    expect(data.parameters).toContainEqual({ name: '@term', value: 'ALPHA' });
  });

  it('routes entityTypes through the [0]._value path (gotcha — c.entityType silently returns 0 docs)', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, {
      entityTypes: ['Person', 'Project'],
      limit: 10,
      offset: 0,
    });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).toContain('c.entityType[0]._value IN (@etype0, @etype1)');
    expect(data.sql).not.toContain('c.entityType =');
    expect(data.parameters).toContainEqual({ name: '@etype0', value: 'Person' });
    expect(data.parameters).toContainEqual({ name: '@etype1', value: 'Project' });
  });

  it('runs data + COUNT(1) in parallel and returns exact total when no properties filter', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [42] : []);

    const result = await provider.findEntities(TEST_REPO, {
      searchTerm: 'alice',
      limit: 10,
      offset: 0,
    });

    expect(doc.calls).toHaveLength(2);
    expect(doc.calls.some((c) => c.sql.startsWith('SELECT VALUE COUNT(1)'))).toBe(true);
    expect(result.total).toBe(42);
  });

  it('emits exact-eq prefilter against the dual-written scalar column when every filter value is natively storable', async () => {
    // Dual-write makes `c.<key>[0]._value` the authoritative server-side
    // column for storable values. The exact predicate is precise — no
    // substring false positives — so COUNT runs alongside and returns the
    // exact `total`.
    const { provider, doc } = makeProviderWithDocStub();

    const stored = {
      id: 'e1',
      label: 'Person',
      repositoryId: TEST_REPO,
      entityType:  [{ _value: 'Person', id: 'a' }],
      entityLabel: [{ _value: 'Alice',  id: 'b' }],
      slug:        [{ _value: 'alice',  id: 'c' }],
      properties:  [{ _value: '{"role":"engineer","seniority":"staff"}', id: 'd' }],
      role:        [{ _value: 'engineer', id: 'r' }],
      createdBy:        [{ _value: 'test',                       id: 'p1' }],
      createdByType:    [{ _value: 'agent',                      id: 'p2' }],
      createdAt:        [{ _value: '2026-05-26T00:00:00.000Z',   id: 'p3' }],
      modifiedBy:       [{ _value: 'test',                       id: 'p4' }],
      modifiedByType:   [{ _value: 'agent',                      id: 'p5' }],
      modifiedAt:       [{ _value: '2026-05-26T00:00:00.000Z',   id: 'p6' }],
    };
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [3] : [stored]);

    const result = await provider.findEntities(TEST_REPO, {
      properties: { role: 'engineer' },
      limit: 10,
      offset: 0,
    });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).toContain('c.role[0]._value = @val0');
    expect(data.sql).not.toContain('CONTAINS(c.properties[0]._value');
    expect(data.parameters).toContainEqual({ name: '@val0', value: 'engineer' });

    // COUNT runs over the same WHERE clause; the precise predicate means it
    // matches the data page set exactly, so `total` is reported.
    expect(doc.calls).toHaveLength(2);
    expect(doc.calls.some((c) => c.sql.startsWith('SELECT VALUE COUNT(1)'))).toBe(true);
    expect(result.total).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('e1');
  });

  it('emits exact-eq prefilter per key when multiple natively storable filters are combined', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, {
      properties: { role: 'engineer', active: true, level: 5 },
      limit: 10,
      offset: 0,
    });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).toContain('c.role[0]._value = @val0');
    expect(data.sql).toContain('c.active[0]._value = @val1');
    expect(data.sql).toContain('c.level[0]._value = @val2');
    expect(data.sql).not.toContain('CONTAINS(c.properties[0]._value');
    expect(data.parameters).toContainEqual({ name: '@val0', value: 'engineer' });
    expect(data.parameters).toContainEqual({ name: '@val1', value: true });
    expect(data.parameters).toContainEqual({ name: '@val2', value: 5 });
  });

  it('falls back to approximate CONTAINS and skips COUNT(1) when any filter value is not natively storable', async () => {
    // A nested object cannot be dual-written as a Cosmos Gremlin scalar, so
    // it lives only in the JSON blob. The whole filter set falls back to the
    // substring path — substring matches over-count, so COUNT is skipped and
    // `total` reports `undefined`. `matchesPropertyFilters` still refines
    // client-side over the prefiltered rows.
    const { provider, doc } = makeProviderWithDocStub();

    const truePositive = {
      id: 'e1',
      label: 'Person',
      repositoryId: TEST_REPO,
      entityType:  [{ _value: 'Person', id: 'a' }],
      entityLabel: [{ _value: 'Alice',  id: 'b' }],
      slug:        [{ _value: 'alice',  id: 'c' }],
      properties:  [{ _value: '{"meta":{"team":"core"},"role":"engineer"}', id: 'd' }],
      createdBy:        [{ _value: 'test',                       id: 'p1' }],
      createdByType:    [{ _value: 'agent',                      id: 'p2' }],
      createdAt:        [{ _value: '2026-05-26T00:00:00.000Z',   id: 'p3' }],
      modifiedBy:       [{ _value: 'test',                       id: 'p4' }],
      modifiedByType:   [{ _value: 'agent',                      id: 'p5' }],
      modifiedAt:       [{ _value: '2026-05-26T00:00:00.000Z',   id: 'p6' }],
    };
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : [truePositive]);

    const filterValue = { team: 'core' };
    const result = await provider.findEntities(TEST_REPO, {
      properties: { meta: filterValue },
      limit: 10,
      offset: 0,
    });

    expect(doc.calls).toHaveLength(1);
    const data = doc.calls[0]!;
    expect(data.sql).toContain('CONTAINS(c.properties[0]._value, @kv0, false)');
    expect(data.sql).not.toContain('COUNT(1)');
    expect(data.parameters).toContainEqual({ name: '@kv0', value: '"meta":{"team":"core"}' });
    expect(result.total).toBeUndefined();
    // Client-side refinement: nested-object equality is `===` reference, so
    // the stored blob's `{ team: 'core' }` is not the same instance as the
    // caller's filter literal and the row is rejected. Documents today's
    // observable contract for non-storable filter values.
    expect(result.items).toHaveLength(0);
  });

  it('falls back to approximate CONTAINS for mixed filter sets when at least one value is non-storable', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = () => [];

    await provider.findEntities(TEST_REPO, {
      // First value is storable; second is not. The whole set must fall
      // back — the exact column for `extra` would be absent on the dual-
      // written shape, so emitting `c.extra[0]._value = …` would silently
      // return zero rows.
      properties: { role: 'engineer', extra: { nested: 1 } },
      limit: 10,
      offset: 0,
    });

    const data = doc.calls[0]!;
    expect(data.sql).toContain('CONTAINS(c.properties[0]._value, @kv0, false)');
    expect(data.sql).toContain('CONTAINS(c.properties[0]._value, @kv1, false)');
    expect(data.sql).not.toContain('c.role[0]._value =');
    expect(data.sql).not.toContain('c.extra[0]._value =');
    expect(data.sql).not.toContain('COUNT(1)');
  });

  it('throws on reserved-key collision when the filter set is otherwise eligible for the exact path', async () => {
    // The user-property key is interpolated into the SQL identifier slot,
    // so reserved-name collisions and unsafe identifiers must be rejected
    // synchronously rather than silently mis-routed to a schema slot or
    // widening the injection surface. Matches the create-path contract.
    const { provider } = makeProviderWithDocStub();

    await expect(
      provider.findEntities(TEST_REPO, {
        properties: { entityType: 'Person' },
        limit: 10,
        offset: 0,
      }),
    ).rejects.toThrow(/schema-managed field/);
  });

  it('pages with ORDER BY c.id + OFFSET + LIMIT for deterministic pagination', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, { limit: 25, offset: 50 });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).toMatch(/ORDER BY c\.id\s+OFFSET @off\s+LIMIT @lim/);
    expect(data.parameters).toContainEqual({ name: '@off', value: 50 });
    expect(data.parameters).toContainEqual({ name: '@lim', value: 25 });
  });

  it('excludes c.embedding from the SELECT projection by default', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, { limit: 10, offset: 0 });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).not.toContain('c.embedding');
  });

  it('includes c.embedding when loadEmbeddings: true', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : []);

    await provider.findEntities(TEST_REPO, { limit: 10, offset: 0 }, { loadEmbeddings: true });

    const data = doc.calls.find((c) => !c.sql.includes('COUNT(1)'))!;
    expect(data.sql).toContain('c.embedding');
  });
});

// ─── Step E — indexing-policy diagnostic in ensureSchema ──────────────
//
// `ensureSchema()` reads the container's indexing policy after the schema
// version is settled and warns when `excludedPaths` would force the
// findEntities SQL rewrite to scan. Code-managed containers get the default
// policy (everything indexed). This guard catches containers provisioned via
// external ARM/Bicep that strip indexing on the searched paths.
//
// The diagnostic is unit-tested in isolation by invoking
// `runIndexingPolicyDiagnostic` directly via the private-access cast — going
// through `ensureSchema()` would require stubbing the module-scoped
// `cosmosRestPut` helper as well, which is covered by Step F's live run.

interface ContainerPropertiesStub {
  getContainerProperties(): Promise<{
    id: string;
    partitionKey: { paths: string[]; kind: string };
    indexingPolicy: {
      indexingMode: string;
      automatic: boolean;
      includedPaths: Array<{ path: string }>;
      excludedPaths: Array<{ path: string }>;
    };
  }>;
}

function injectContainerPropertiesStub(
  provider: CosmosDbProvider,
  excludedPaths: Array<{ path: string }>,
  override?: Partial<ContainerPropertiesStub>,
): void {
  const stub: ContainerPropertiesStub = {
    getContainerProperties: async () => ({
      id: 'c',
      partitionKey: { paths: ['/repositoryId'], kind: 'Hash' },
      indexingPolicy: {
        indexingMode: 'consistent',
        automatic: true,
        includedPaths: [{ path: '/*' }],
        excludedPaths,
      },
    }),
    ...override,
  };
  (provider as unknown as { docClient: ContainerPropertiesStub }).docClient = stub;
}

async function callDiagnostic(provider: CosmosDbProvider): Promise<void> {
  await (provider as unknown as { runIndexingPolicyDiagnostic(): Promise<void> })
    .runIndexingPolicyDiagnostic();
}

describe('Step E indexing-policy diagnostic', () => {
  it('does not warn when the default policy is applied (only /_etag excluded)', async () => {
    const { provider } = makeProvider();
    injectContainerPropertiesStub(provider, [{ path: '/"_etag"/?' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await callDiagnostic(provider);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns when /properties/* is excluded, naming the offending guard and source', async () => {
    const { provider } = makeProvider();
    injectContainerPropertiesStub(provider, [
      { path: '/"_etag"/?' },
      { path: '/properties/*' },
    ]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await callDiagnostic(provider);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    expect(message).toContain('/properties');
    expect(message).toContain('/properties/*');
    expect(message).not.toContain('/entityLabel');
    warn.mockRestore();
  });

  it('warns and lists every guarded path when the root wildcard /* is excluded', async () => {
    const { provider } = makeProvider();
    injectContainerPropertiesStub(provider, [{ path: '/*' }]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await callDiagnostic(provider);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = warn.mock.calls[0]![0] as string;
    for (const guard of ['/entityLabel', '/slug', '/summary', '/entityType', '/properties', '/repositoryId']) {
      expect(message).toContain(guard);
    }
    warn.mockRestore();
  });

  it('warns but does not throw when getContainerProperties fails', async () => {
    const { provider } = makeProvider();
    (provider as unknown as { docClient: ContainerPropertiesStub }).docClient = {
      getContainerProperties: async () => {
        throw new Error('network down');
      },
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(callDiagnostic(provider)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain('could not verify indexing policy');
    expect(warn.mock.calls[0]![0]).toContain('network down');
    warn.mockRestore();
  });
});

// ─── System-vertex partition routing ─────────────────────────────────
//
// hasId is post-routing in Cosmos Gremlin — without a partition predicate
// the engine fans the lookup out to every physical partition. Every system-
// vertex query whose repositoryId is known must therefore scope via
// `has('repositoryId', rid)` BEFORE `hasId(vid)`. These tests lock the
// emission shape so the 7 violations the 2026-05-26 audit caught do not
// regress.

describe('system-vertex queries scope by partition before hasId', () => {
  function partitionPredicateBeforeHasId(query: string): boolean {
    const partitionIdx = query.indexOf("has('repositoryId', rid)");
    if (partitionIdx === -1) return false;
    const hasIdIdx = query.indexOf('hasId(vid)');
    if (hasIdIdx === -1) return false;
    return partitionIdx < hasIdIdx;
  }

  it("getVocabulary issues g.V().has('repositoryId', rid).hasId(vid)…", async () => {
    const { provider, stub } = makeProvider();
    await provider.getVocabulary(TEST_REPO);

    const last = stub.calls[stub.calls.length - 1]!;
    expect(partitionPredicateBeforeHasId(last.query)).toBe(true);
    expect(last.params!['rid']).toBe(TEST_REPO);
    expect(last.params!['vid']).toBe(`vocab:${TEST_REPO}`);
  });

  it('saveVocabulary existence check and update branch both scope by partition first', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      // Force the existence-check to report "exists" so the update branch runs.
      if (query.includes("hasLabel('_vocabulary').count()")) return { items: [1] };
      return { items: [] };
    };

    await provider.saveVocabulary(TEST_REPO, {
      version: '1.0.0',
      lastModified: '2026-05-26T00:00:00.000Z',
      modifiedBy: 'test',
      entityTypes: [],
      relationshipTypes: [],
    });

    const existence = stub.calls.find((c) => c.query.includes("hasLabel('_vocabulary').count()"));
    const update = stub.calls.find((c) => c.query.includes(".property('vocabulary', vocabJson)"));
    expect(existence).toBeDefined();
    expect(update).toBeDefined();
    expect(partitionPredicateBeforeHasId(existence!.query)).toBe(true);
    expect(partitionPredicateBeforeHasId(update!.query)).toBe(true);
    expect(existence!.params!['rid']).toBe(TEST_REPO);
    expect(update!.params!['rid']).toBe(TEST_REPO);
  });

  it('saveVocabulary create branch keeps repositoryId on the addV (already correct)', async () => {
    const { provider, stub } = makeProvider();
    // Default stub returns { items: [] } for the existence check → addV fires.

    await provider.saveVocabulary(TEST_REPO, {
      version: '1.0.0',
      lastModified: '2026-05-26T00:00:00.000Z',
      modifiedBy: 'test',
      entityTypes: [],
      relationshipTypes: [],
    });

    const addv = stub.calls.find((c) => c.query.startsWith("g.addV('_vocabulary')"));
    expect(addv).toBeDefined();
    expect(addv!.query).toContain(".property('repositoryId', rid)");
    expect(addv!.params!['rid']).toBe(TEST_REPO);
  });

  it('createRepository existence check scopes by partition before hasId', async () => {
    const { provider, stub } = makeProvider();
    // Default stub returns { items: [] } for every query — existence check
    // returns 0 (no duplicate), index read returns [], addV+sideEffect submits
    // succeed silently.
    await provider.createRepository({
      repositoryId: TEST_REPO,
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'test',
    });

    const existence = stub.calls.find(
      (c) => c.query.includes(".has('label', lbl).count()"),
    );
    expect(existence).toBeDefined();
    expect(partitionPredicateBeforeHasId(existence!.query)).toBe(true);
    expect(existence!.params!['rid']).toBe(TEST_REPO);
  });

  it('getRepository scopes by partition before hasId', async () => {
    const { provider, stub } = makeProvider();
    await provider.getRepository(TEST_REPO);

    const last = stub.calls[stub.calls.length - 1]!;
    expect(partitionPredicateBeforeHasId(last.query)).toBe(true);
    expect(last.params!['rid']).toBe(TEST_REPO);
    expect(last.params!['vid']).toBe(`repo:${TEST_REPO}`);
  });

  it('updateRepository scopes by partition before hasId', async () => {
    const { provider, stub } = makeProvider();

    // updateRepository first calls getRepository(existing). Stub the
    // projection-bearing read to return a populated repo so the update
    // path proceeds rather than throwing RepositoryNotFoundError.
    const fakeRepo = {
      repositoryId: TEST_REPO,
      repoLabel: 'Existing',
      governanceConfig: '{"mode":"open"}',
      createdAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'test',
    };
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("hasLabel('_repository').project(")) {
        return { items: [fakeRepo] };
      }
      return { items: [] };
    };

    await provider.updateRepository(TEST_REPO, { label: 'Updated' });

    const update = stub.calls.find(
      (c) => c.query.includes("hasLabel('_repository').property("),
    );
    expect(update).toBeDefined();
    expect(partitionPredicateBeforeHasId(update!.query)).toBe(true);
    expect(update!.params!['rid']).toBe(TEST_REPO);
  });
});

// ─── _repository_index sentinel ──────────────────────────────────────
//
// listRepositories no longer issues `g.V().hasLabel('_repository')` (cross-
// partition scan). Instead it reads the sentinel in the fixed `_index`
// partition and hydrates each id via partition-scoped getRepository.

describe('_repository_index sentinel', () => {
  it('listRepositories reads the sentinel and never issues a cross-partition _repository scan', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith("g.V().has('repositoryId', pk).hasId(sid).values('repositoryIds')")) {
        return { items: [JSON.stringify([])] };
      }
      return { items: [] };
    };

    await provider.listRepositories();

    // No cross-partition scan
    expect(
      stub.calls.some((c) =>
        c.query.startsWith("g.V().hasLabel('_repository')"),
      ),
    ).toBe(false);
    // Sentinel read happened
    const sentinelRead = stub.calls.find((c) =>
      c.query.includes("has('repositoryId', pk).hasId(sid).values('repositoryIds')"),
    );
    expect(sentinelRead).toBeDefined();
    expect(sentinelRead!.params!['pk']).toBe('_index');
    expect(sentinelRead!.params!['sid']).toBe('_repository_index');
  });

  it('listRepositories hydrates each id from the sentinel via partition-scoped getRepository', async () => {
    const { provider, stub } = makeProvider();
    const RID_A = '40000000-0000-4000-a000-000000008001';
    const RID_B = '40000000-0000-4000-a000-000000008002';

    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes(".values('repositoryIds')")) {
        return { items: [JSON.stringify([RID_A, RID_B])] };
      }
      if (query.includes("hasLabel('_repository').project(")) {
        const rid = params!['rid'] as string;
        return {
          items: [{
            repositoryId: rid,
            repoLabel: `Repo ${rid.slice(0, 8)}`,
            governanceConfig: '{"mode":"open"}',
            createdAt: '2026-05-26T00:00:00.000Z',
            createdBy: 'test',
          }],
        };
      }
      return { items: [] };
    };

    const result = await provider.listRepositories();

    const hydrationCalls = stub.calls.filter((c) =>
      c.query.includes("hasLabel('_repository').project("),
    );
    expect(hydrationCalls).toHaveLength(2);
    // Each hydration is partition-scoped
    for (const call of hydrationCalls) {
      expect(call.query).toContain("has('repositoryId', rid)");
      expect(call.query).toContain('hasId(vid)');
    }
    expect(result.items.map((r) => r.repositoryId).sort()).toEqual([RID_A, RID_B].sort());
    expect(result.total).toBe(2);
  });

  it('createRepository updates the sentinel via single-submit cross-partition sideEffect', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes(".values('repositoryIds')")) {
        return { items: [JSON.stringify([])] };
      }
      return { items: [] };
    };

    await provider.createRepository({
      repositoryId: TEST_REPO,
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'test',
    });

    const addv = stub.calls.find((c) => c.query.includes("g.addV('_repository')"));
    expect(addv).toBeDefined();
    expect(addv!.query).toContain('.sideEffect(');
    expect(addv!.query).toContain("has('repositoryId', pk).hasId(sid).property('repositoryIds', updatedIndex)");
    const updated = JSON.parse(addv!.params!['updatedIndex'] as string);
    expect(updated).toEqual([TEST_REPO]);
  });
});
