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
} from '@utaba/deep-memory';
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

// ─── Single round-trip delete paths ──────────────────────────────────
//
// The aggregate('found').by('id').drop().cap('found') pattern collapses the
// previous existence-check + drop into one Gremlin round-trip per chunk. The
// bucket emits a list of ids the drop actually touched; the caller derives
// notFound = requestedIds - foundIds client-side.
//
// Shape verified live against the Cosmos emulator 2026-05-25.

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

  function makeStoredEntity(id: string): StoredEntity {
    const now = new Date().toISOString();
    return {
      id,
      slug: 'test-type:' + id,
      entityType: 'test-type',
      label: id,
      summary: 'S',
      properties: { key: 'value' },
      provenance: {
        createdBy: 'x', createdByType: 'agent', createdAt: now,
        modifiedBy: 'x', modifiedByType: 'agent', modifiedAt: now,
      },
    };
  }

  function makeStoredRelationship(id: string): StoredRelationship {
    const now = new Date().toISOString();
    return {
      id,
      relationshipType: 'LINKS',
      sourceEntityId: 'src',
      targetEntityId: 'tgt',
      properties: {},
      bidirectional: false,
      provenance: {
        createdBy: 'x', createdByType: 'agent', createdAt: now,
        modifiedBy: 'x', modifiedByType: 'agent', modifiedAt: now,
      },
    };
  }

  function splitCoalesceBranches(query: string): { update: string; create: string } {
    const idx = query.indexOf('unfold()');
    expect(idx).toBeGreaterThan(-1);
    const tail = query.slice(idx);
    // Branches are separated by `, ` at the top level of coalesce(...).
    // For these single-shot queries, the only `, ` outside a binding param
    // list is the one separating unfold from addV/addE.
    const splitIdx = tail.indexOf(', ');
    expect(splitIdx).toBeGreaterThan(-1);
    return { update: tail.slice(0, splitIdx), create: tail.slice(splitIdx + 2) };
  }

  it("upsertEntity omits .property('repositoryId', ...) on the unfold branch but keeps it on addV", async () => {
    const { provider, stub } = makeProvider();
    const ENTITY_ID = '40000000-0000-4000-a000-000000007100';

    await provider.importBulk(TEST_REPO, [
      { entities: [makeStoredEntity(ENTITY_ID)] },
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
      { relationships: [makeStoredRelationship(REL_ID)] },
    ]);

    const upsert = stub.calls.find((c) => c.query.includes('addE(edgeLabel)'));
    expect(upsert).toBeDefined();
    const { update, create } = splitCoalesceBranches(upsert!.query);
    expect(update).not.toMatch(/\.property\('repositoryId',/);
    expect(create).toMatch(/\.property\('repositoryId',/);
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

  it('skips COUNT(1) and reports total: undefined when properties filter is present', async () => {
    const { provider, doc } = makeProviderWithDocStub();
    doc.respond = () => [];

    const result = await provider.findEntities(TEST_REPO, {
      properties: { role: 'engineer' },
      limit: 10,
      offset: 0,
    });

    expect(doc.calls).toHaveLength(1);
    expect(doc.calls[0]!.sql).not.toContain('COUNT(1)');
    expect(result.total).toBeUndefined();
  });

  it('emits a CONTAINS prefilter for each properties key and exact-matches client-side', async () => {
    const { provider, doc } = makeProviderWithDocStub();

    // Stored properties as a JSON-stringified blob, matching the Gremlin-managed
    // [{_value, id}] document shape from the probe.
    const truePositive = {
      id: 'e1',
      label: 'Person',
      repositoryId: TEST_REPO,
      entityType:  [{ _value: 'Person', id: 'a' }],
      entityLabel: [{ _value: 'Alice',  id: 'b' }],
      slug:        [{ _value: 'alice',  id: 'c' }],
      properties:  [{ _value: '{"role":"engineer","seniority":"staff"}', id: 'd' }],
      createdBy:        [{ _value: 'test',                       id: 'p1' }],
      createdByType:    [{ _value: 'agent',                      id: 'p2' }],
      createdAt:        [{ _value: '2026-05-26T00:00:00.000Z',   id: 'p3' }],
      modifiedBy:       [{ _value: 'test',                       id: 'p4' }],
      modifiedByType:   [{ _value: 'agent',                      id: 'p5' }],
      modifiedAt:       [{ _value: '2026-05-26T00:00:00.000Z',   id: 'p6' }],
    };
    // False positive: the substring `"role":"engineer"` appears literally
    // *inside another property's value* (e.g. summary). Server-side CONTAINS
    // accepts it; client-side matchesPropertyFilters must reject it because
    // the actual `role` property is `manager`.
    const falsePositive = {
      ...truePositive,
      id: 'e2',
      properties:  [{ _value: '{"role":"manager","note":"\\"role\\":\\"engineer\\""}', id: 'd2' }],
    };
    doc.respond = (sql) => (sql.includes('COUNT(1)') ? [0] : [truePositive, falsePositive]);

    const result = await provider.findEntities(TEST_REPO, {
      properties: { role: 'engineer' },
      limit: 10,
      offset: 0,
    });

    const data = doc.calls[0]!;
    expect(data.sql).toContain('CONTAINS(c.properties[0]._value, @kv0, false)');
    expect(data.parameters).toContainEqual({ name: '@kv0', value: '"role":"engineer"' });

    // Only the true positive survives the client-side exact-match.
    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.id).toBe('e1');
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
