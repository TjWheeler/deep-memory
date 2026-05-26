// Focused unit tests for CosmosDbProvider behaviors that do not need a live
// emulator. Currently covers the Phase 2 vocabulary cache: shape of the
// query/binding emitted by traversal compilation, cache hit/miss counts,
// invalidation on saveVocabulary.
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
  UnsupportedQueryError,
} from '@utaba/deep-memory';

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

describe('Phase 2 vocabulary cache', () => {
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

describe('Phase 2 non-traversal read paths emit projection chains, not valueMap(true)', () => {
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

// ─── Phase 6 — single round-trip create / update ─────────────────────
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
    label: 'Phase 6 Probe',
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

describe('Phase 6 single-round-trip create / update', () => {
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

// ─── Phase 7 — single round-trip delete paths ────────────────────────
//
// The aggregate('found').by('id').drop().cap('found') pattern collapses the
// previous existence-check + drop into one Gremlin round-trip per chunk. The
// bucket emits a list of ids the drop actually touched; the caller derives
// notFound = requestedIds - foundIds client-side.
//
// Shape verified live against the Cosmos emulator 2026-05-25 — see
// local-tests/phase7-shape-probe.mjs.

describe('Phase 7 single-round-trip delete paths', () => {
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
});

// ─── Phase 8 — findEntities JS-filter requires entityTypes ───────────
//
// CosmosDB Gremlin silently drops TextP.containing(), so searchTerm /
// properties filters run client-side after loading every type-matched
// vertex into memory. Without entityTypes, "type-matched" means every
// vertex in the partition — an unbounded fan-out. The guard rejects
// these queries with a typed error before issuing any Gremlin.

describe('Phase 8 findEntities requires entityTypes for JS-filter path', () => {
  it('throws UnsupportedQueryError when searchTerm is set without entityTypes', async () => {
    const { provider, stub } = makeProvider();
    const before = stub.calls.length;

    await expect(
      provider.findEntities(TEST_REPO, { searchTerm: 'alpha', limit: 10, offset: 0 }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);

    const after = stub.calls.length;
    expect(after - before).toBe(0);
  });

  it('throws UnsupportedQueryError when properties is set without entityTypes', async () => {
    const { provider, stub } = makeProvider();
    const before = stub.calls.length;

    await expect(
      provider.findEntities(TEST_REPO, {
        properties: { role: 'admin' },
        limit: 10,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);

    const after = stub.calls.length;
    expect(after - before).toBe(0);
  });

  it('throws UnsupportedQueryError when entityTypes is an empty array', async () => {
    const { provider, stub } = makeProvider();
    const before = stub.calls.length;

    await expect(
      provider.findEntities(TEST_REPO, {
        searchTerm: 'alpha',
        entityTypes: [],
        limit: 10,
        offset: 0,
      }),
    ).rejects.toBeInstanceOf(UnsupportedQueryError);

    const after = stub.calls.length;
    expect(after - before).toBe(0);
  });

  it('proceeds to the JS-filter Gremlin query when entityTypes is provided', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.findEntities(TEST_REPO, {
      searchTerm: 'alpha',
      entityTypes: ['Person'],
      limit: 10,
      offset: 0,
    });
    const after = stub.calls.length;

    expect(after - before).toBe(1);
    expect(result.items).toEqual([]);

    const issued = stub.calls[stub.calls.length - 1]!;
    expect(issued.query).toContain("has('entityType', within(");
    // JS-filter path: no server-side range, no count.
    expect(issued.query).not.toContain('.range(');
    expect(issued.query).not.toContain('.count()');
  });

  it('uses the fast (server-paginated) path when no searchTerm or properties are present', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes('.count()')) {
        return { items: [0] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    await provider.findEntities(TEST_REPO, {
      // No entityTypes — fast path doesn't require them; only the JS-filter
      // path does, and only when searchTerm/properties force client-side work.
      limit: 10,
      offset: 0,
    });
    const after = stub.calls.length;

    // Fast path issues count + data — two storage calls.
    expect(after - before).toBe(2);
  });
});
