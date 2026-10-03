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
import { buildEdgeDeleteQuery, buildGuardedEntityDeleteQuery } from './queries/deleteByIds.js';
import type { CosmosDbConnection, GremlinResult } from './CosmosDbConnection.js';
import type {
  MemoryVocabulary,
  StoredEntity,
  StoredEntityUpdate,
  StoredRelationship,
  TraversalSpec,
} from '@utaba/deep-memory/types';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  DuplicateRepositoryError,
  EntityNotFoundError,
  ProviderError,
  RelationshipNotFoundError,
  RepositoryNotFoundError,
  SlugConflictError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import { ENTITY_CREATE_QUERY, UPDATE_ENTITY_START } from './queries/entity.js';
import { RELATIONSHIP_CREATE_QUERY } from './queries/relationship.js';
import {
  DELETE_ENTITY_BATCH_QUERY,
  DELETE_INDEX_ENTRY_QUERY,
  DELETE_VERTEX_BATCH_QUERY,
  EDGE_BATCH_DROP_QUERY,
  ENTITY_BATCH_COUNT_QUERY,
  ENTITY_BATCH_DROP_QUERY,
  REPOSITORY_MARKER_COUNT_QUERY,
} from './queries/repository.js';
import {
  VOCABULARY_BACKFILL_SCAN_SQL,
  VOCABULARY_BACKFILL_WRITE_QUERY,
  VOCABULARY_READ_QUERY,
  VOCABULARY_SAVE_QUERY,
  VOCABULARY_STATE_QUERY,
  backfillVocabularyVersions,
} from './queries/vocabulary.js';
import type { CosmosDocumentClient, CosmosQueryParameter, CosmosQueryResult } from './CosmosDocumentClient.js';

const TEST_REPO = '40000000-0000-4000-a000-000000000099';

// Every entity-create query opens with the partition-scoped gate on the
// repository's `_repository` marker vertex.
const ENTITY_CREATE_START =
  "g.V().has('repositoryId', rid).hasId(repoVid).hasLabel('_repository').fold().coalesce(";

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
    // The vocabulary read issued by getVocabulary and by traversal compilation
    // (not the compare-and-set miss follow-up, which projects version + blob).
    isVocabRead: (call) => call.query === VOCABULARY_READ_QUERY,
    submit: async (query, params) => {
      calls.push({ query, params });
      // Default: empty result. Tests override per-call by inspecting the
      // query string and returning shaped data.
      if (query === VOCABULARY_SAVE_QUERY) {
        // Compare-and-set lands: one vertex written.
        return { items: [1] };
      }
      if (query === VOCABULARY_READ_QUERY) {
        // The repository marker and the vocabulary vertex, each projected to
        // its id and blob — a JSON-stringified vocabulary so the parse path
        // succeeds.
        return {
          items: [
            { id: params?.['mid'], json: '' },
            {
              id: params?.['vid'],
              json: JSON.stringify({
                version: '1.0.0',
                lastModified: '2026-05-25T00:00:00.000Z',
                modifiedBy: 'test',
                entityTypes: [{ name: 'Person', properties: [] }],
                relationshipTypes: [],
              }),
            },
          ],
        };
      }
      if (query === REPOSITORY_MARKER_COUNT_QUERY) {
        // The repository exists.
        return { items: [1] };
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

function makeVocabulary(version: string): MemoryVocabulary {
  return {
    version,
    lastModified: '2026-05-26T00:00:00.000Z',
    modifiedBy: 'test',
    entityTypes: [],
    relationshipTypes: [],
  };
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
    await provider.saveVocabulary(
      TEST_REPO,
      {
        version: '1.0.1',
        lastModified: '2026-05-25T00:00:01.000Z',
        modifiedBy: 'test',
        entityTypes: [],
        relationshipTypes: [],
      },
      '1.0.0',
    );
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);

    const vocabReads = stub.calls.filter((c) => stub.isVocabRead(c));
    expect(vocabReads).toHaveLength(2);
  });

  it('a saveVocabulary version conflict invalidates the cache', async () => {
    const { provider, stub } = makeProvider();
    const defaultSubmit = stub.submit;
    stub.submit = async (query, params) => {
      if (query === VOCABULARY_SAVE_QUERY) {
        stub.calls.push({ query, params });
        return { items: [0] };
      }
      if (query === VOCABULARY_STATE_QUERY) {
        stub.calls.push({ query, params });
        return { items: [{ version: '1.0.5', json: JSON.stringify(makeVocabulary('1.0.5')) }] };
      }
      return defaultSubmit(query, params);
    };

    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    await expect(
      provider.saveVocabulary(TEST_REPO, makeVocabulary('1.0.1'), '1.0.0'),
    ).rejects.toBeInstanceOf(VocabularyVersionConflictError);
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);

    expect(stub.calls.filter((c) => stub.isVocabRead(c))).toHaveLength(2);
  });

  it('getVocabulary({ fresh: true }) always reads and refreshes the traversal cache', async () => {
    const { provider, stub } = makeProvider();

    const vocab = await provider.getVocabulary(TEST_REPO, { fresh: true });
    expect(vocab.version).toBe('1.0.0');
    // The fresh result is now the cache entry, so the traversal compiles
    // against it without another read.
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    expect(stub.calls.filter((c) => stub.isVocabRead(c))).toHaveLength(1);

    // A fresh read with a warm cache still goes to the database.
    await provider.getVocabulary(TEST_REPO, { fresh: true });
    expect(stub.calls.filter((c) => stub.isVocabRead(c))).toHaveLength(2);
  });

  it('getVocabulary without fresh reads the database but leaves the traversal cache alone', async () => {
    const { provider, stub } = makeProvider();

    await provider.getVocabulary(TEST_REPO);
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
    expect(stub.calls.filter((c) => stub.isVocabRead(c))).toHaveLength(2);
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

  it('getVocabulary reads only the vocabulary blob and the marker, rather than valueMap(true)', async () => {
    const { provider, stub } = makeProvider();
    await provider.getVocabulary(TEST_REPO);

    const last = stub.calls[stub.calls.length - 1];
    expect(last!.query).toBe(VOCABULARY_READ_QUERY);
    expect(last!.query).toContain("values('vocabulary')");
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
      if (query.startsWith(ENTITY_CREATE_START)) {
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
      if (query.startsWith(ENTITY_CREATE_START)) {
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

  it('createEntity is gated on the repository marker in the same query', async () => {
    const { provider, getCreateCall } = captureCreateQuery();
    await provider.createEntity(TEST_REPO, makeEntity('40000000-0000-4000-a000-000000006010'));

    const call = getCreateCall();
    // Outer gate: partition predicate first, then the marker id and label.
    expect(call.query.startsWith(ENTITY_CREATE_START)).toBe(true);
    // Inner duplicate check: the lookup runs inside map(), so it only runs
    // for a marker that exists (a bare fold() would emit [] without one).
    // Then the slug check, partition-scoped, before the write.
    expect(call.query).toContain(
      "coalesce(unfold().map(__.V().has('repositoryId', rid).hasId(vid).fold()).coalesce(unfold().constant('__duplicate'),__.V().has('repositoryId', rid).has('slug', slugVal).has('entityType').limit(1).constant('__slug_taken'),addV(vertexLabel)",
    );
    expect(call.query.endsWith("),constant('__no_repository'))")).toBe(true);
    expect(call.params!['repoVid']).toBe(`repo:${TEST_REPO}`);
    expect(call.params!['rid']).toBe(TEST_REPO);
    expect(typeof call.params!['slugVal']).toBe('string');
  });

  it('createEntity throws RepositoryNotFoundError when the marker is gone, in one call', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith(ENTITY_CREATE_START)) return { items: ['__no_repository'] };
      return { items: [] };
    };

    const before = stub.calls.length;
    await expect(
      provider.createEntity(TEST_REPO, makeEntity('40000000-0000-4000-a000-000000006011')),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.length - before).toBe(1);
  });

  it('createRelationship gates the create branch on the repository marker', async () => {
    const { provider, getCreateCall } = captureRelationshipCreateQuery();
    await provider.createRelationship(
      TEST_REPO,
      makeRelationship(
        '40000000-0000-4000-a000-000000006012',
        '40000000-0000-4000-a000-deadbeef0001',
        '40000000-0000-4000-a000-deadbeef0002',
      ),
    );

    const call = getCreateCall();
    expect(call.query).toContain(
      "unfold().constant('__duplicate'),g.V().has('repositoryId', rid).hasId(repoVid).hasLabel('_repository').fold().coalesce(" +
        "unfold().V().has('repositoryId', rid).hasId(srcId).has('entityType').addE(edgeLabel)",
    );
    expect(call.query.endsWith(",unfold().constant('__no_source'),constant('__no_repository')))")).toBe(true);
    expect(call.params!['repoVid']).toBe(`repo:${TEST_REPO}`);
  });

  it('createRelationship throws RepositoryNotFoundError when the marker is gone, in one call', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce(')) {
        return { items: ['__no_repository'] };
      }
      return { items: [] };
    };

    const rel = makeRelationship(
      '40000000-0000-4000-a000-000000006013',
      '40000000-0000-4000-a000-deadbeef0001',
      '40000000-0000-4000-a000-deadbeef0002',
    );
    const before = stub.calls.length;
    await expect(provider.createRelationship(TEST_REPO, rel)).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    expect(stub.calls.length - before).toBe(1);
  });

  it.each([
    ['__no_source', 'source', '40000000-0000-4000-a000-deadbeef0001'],
    ['__no_target', 'target', '40000000-0000-4000-a000-deadbeef0009'],
  ])(
    'createRelationship maps %s to EntityNotFoundError naming the %s, in one call',
    async (sentinel, _endpoint, missingId) => {
      const { provider, stub } = makeProvider();
      stub.submit = async (query, params) => {
        stub.calls.push({ query, params });
        if (query.startsWith('g.E().has(\'repositoryId\', rid).hasId(relId).fold().coalesce(')) {
          return { items: [sentinel] };
        }
        return { items: [] };
      };

      const rel = makeRelationship(
        '40000000-0000-4000-a000-000000006014',
        '40000000-0000-4000-a000-deadbeef0001',
        '40000000-0000-4000-a000-deadbeef0009',
      );
      const before = stub.calls.length;
      const create = provider.createRelationship(TEST_REPO, rel);
      await expect(create).rejects.toBeInstanceOf(EntityNotFoundError);
      await expect(create).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', id: missingId });
      expect(stub.calls.length - before).toBe(1);
    },
  );

  it('createRelationship tells a missing target from a missing source with a partition-scoped lookup of the source', async () => {
    const { provider, getCreateCall } = captureRelationshipCreateQuery();
    await provider.createRelationship(
      TEST_REPO,
      makeRelationship(
        '40000000-0000-4000-a000-000000006015',
        '40000000-0000-4000-a000-deadbeef0001',
        '40000000-0000-4000-a000-deadbeef0002',
      ),
    );

    const { query } = getCreateCall();
    // Fallbacks in order: the source exists (so the target is missing), the
    // marker exists (so the source is missing), no marker.
    expect(
      query.endsWith(
        ",unfold().V().has('repositoryId', rid).hasId(srcId).has('entityType').constant('__no_target')" +
          ",unfold().constant('__no_source'),constant('__no_repository')))",
      ),
    ).toBe(true);
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
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query.startsWith(UPDATE_ENTITY_START) && query.includes('.project(')) {
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
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
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

// ─── Slug uniqueness and store-side conflicts on create / update ─────

const SLUG_HOLDERS_QUERY = "g.V().has('repositoryId', rid).has('slug', slugVal).has('entityType').id()";
const ENTITY_CURRENT_QUERY =
  "g.V().has('repositoryId', rid).hasId(eid).has('entityType')" +
  ".project('entityType','label').by(values('entityType')).by(coalesce(values('entityLabel'), constant('')))";

/** Shape of the gremlin driver's ResponseError for a Cosmos-side failure. */
function cosmosResponseError(status: number): Error {
  return Object.assign(new Error(`Server error (${status})`), {
    name: 'ResponseError',
    statusCode: 500,
    statusAttributes: { 'x-ms-status-code': status },
  });
}

function slugUpdate(slug: string | undefined): StoredEntityUpdate {
  return {
    label: 'Alpha',
    ...(slug !== undefined ? { slug } : {}),
    provenance: {
      createdBy: 'test',
      createdByType: 'agent',
      createdAt: '2026-05-25T00:00:00.000Z',
      modifiedBy: 'test',
      modifiedByType: 'agent',
      modifiedAt: '2026-05-25T00:00:01.000Z',
    },
  };
}

describe('slug uniqueness', () => {
  const ENTITY_ID = '40000000-0000-4000-a000-000000006101';
  const OTHER_ID = '40000000-0000-4000-a000-000000006102';

  it('createEntity maps the slug-taken sentinel to SlugConflictError in one call', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query.startsWith(ENTITY_CREATE_START)) return { items: ['__slug_taken'] };
      return { items: [] };
    };
    const entity = makeEntity(ENTITY_ID);

    const before = stub.calls.length;
    await expect(provider.createEntity(TEST_REPO, entity)).rejects.toMatchObject({
      name: 'SlugConflictError',
      code: 'SLUG_CONFLICT',
      slug: entity.slug,
    });
    expect(stub.calls.length - before).toBe(1);
    expect(stub.calls[stub.calls.length - 1]!.params!['slugVal']).toBe(entity.slug);
  });

  it('updateEntity refuses a slug another entity holds, before any write', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query === SLUG_HOLDERS_QUERY) return { items: [OTHER_ID] };
      if (query === ENTITY_CURRENT_QUERY) return { items: [{ entityType: 'Person', label: 'Old' }] };
      return { items: [] };
    };

    const update = provider.updateEntity(TEST_REPO, ENTITY_ID, slugUpdate('person:alpha'));

    await expect(update).rejects.toBeInstanceOf(SlugConflictError);
    // The type the update leaves unchanged comes from the stored entity.
    await expect(update).rejects.toMatchObject({
      code: 'SLUG_CONFLICT',
      slug: 'person:alpha',
      entityType: 'Person',
      label: 'Alpha',
    });
    const lookup = stub.calls.find((c) => c.query === SLUG_HOLDERS_QUERY)!;
    expect(lookup.params).toEqual({ rid: TEST_REPO, slugVal: 'person:alpha' });
    expect(stub.calls.some((c) => c.query.includes('.property('))).toBe(false);
  });

  it('updateEntity reports a missing entity as EntityNotFoundError, not a slug clash', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query === SLUG_HOLDERS_QUERY) return { items: [OTHER_ID] };
      if (query === ENTITY_CURRENT_QUERY) return { items: [] };
      return { items: [] };
    };

    await expect(
      provider.updateEntity(TEST_REPO, ENTITY_ID, slugUpdate('person:alpha')),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    const existence = stub.calls.find((c) => c.query === ENTITY_CURRENT_QUERY)!;
    expect(existence.params).toEqual({ rid: TEST_REPO, eid: ENTITY_ID });
  });

  it("updateEntity accepts the entity's own slug and goes on to the write", async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query === SLUG_HOLDERS_QUERY) return { items: [ENTITY_ID] };
      return { items: [] };
    };

    // The stubbed write matches nothing, so the update itself reports the
    // entity as missing; reaching it shows the slug check let it through.
    await expect(
      provider.updateEntity(TEST_REPO, ENTITY_ID, slugUpdate('person:alpha')),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    expect(stub.calls.some((c) => c.query === ENTITY_CURRENT_QUERY)).toBe(false);
    expect(stub.calls.length).toBeGreaterThan(1);
  });

  it('updateEntity keeps its own slug when another entity holds the same slug too', async () => {
    const { provider, stub } = makeProvider();
    const projected = {
      id: ENTITY_ID,
      entityType: 'Person',
      entityLabel: 'Alpha',
      slug: 'person:alpha',
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
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query === SLUG_HOLDERS_QUERY) return { items: [ENTITY_ID, OTHER_ID] };
      if (query === ENTITY_CURRENT_QUERY) return { items: [{ entityType: 'Person', label: 'Alpha' }] };
      if (query.startsWith(UPDATE_ENTITY_START) && query.includes('.project(')) {
        return { items: [projected] };
      }
      return { items: [] };
    };

    const updated = await provider.updateEntity(TEST_REPO, ENTITY_ID, slugUpdate('person:alpha'));

    expect(updated.slug).toBe('person:alpha');
    expect(stub.calls.some((c) => c.query === ENTITY_CURRENT_QUERY)).toBe(false);
  });

  it('updateEntity reads the unchanged label from a Map-shaped projection for the refusal', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query === SLUG_HOLDERS_QUERY) return { items: [OTHER_ID] };
      if (query === ENTITY_CURRENT_QUERY) {
        return { items: [new Map<string, unknown>([['entityType', 'Person'], ['label', 'Old']])] };
      }
      return { items: [] };
    };
    const { label: _unchanged, ...withoutLabel } = slugUpdate('person:alpha');

    await expect(provider.updateEntity(TEST_REPO, ENTITY_ID, withoutLabel)).rejects.toMatchObject({
      code: 'SLUG_CONFLICT',
      entityType: 'Person',
      label: 'Old',
    });
  });

  it('updateEntity without a slug makes no slug lookup', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      return { items: [] };
    };

    const before = stub.calls.length;
    await expect(
      provider.updateEntity(TEST_REPO, ENTITY_ID, slugUpdate(undefined)),
    ).rejects.toBeInstanceOf(EntityNotFoundError);
    // The write, then the marker check that tells a missing entity from a
    // missing repository.
    expect(stub.calls.length - before).toBe(2);
    expect(stub.calls.some((c) => c.query === SLUG_HOLDERS_QUERY)).toBe(false);
  });
});

describe('create maps a store-side 409 to the duplicate error', () => {
  it('createEntity → DuplicateEntityError with the driver error as cause', async () => {
    const { provider, stub } = makeProvider();
    const driverError = cosmosResponseError(409);
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith(ENTITY_CREATE_START)) throw driverError;
      return { items: [] };
    };
    const entity = makeEntity('40000000-0000-4000-a000-000000006201');

    const create = provider.createEntity(TEST_REPO, entity);

    await expect(create).rejects.toBeInstanceOf(DuplicateEntityError);
    await expect(create).rejects.toMatchObject({ id: entity.id, cause: driverError });
  });

  it('createRelationship → DuplicateRelationshipError with the driver error as cause', async () => {
    const { provider, stub } = makeProvider();
    const driverError = cosmosResponseError(409);
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith("g.E().has('repositoryId', rid).hasId(relId).fold().coalesce(")) throw driverError;
      return { items: [] };
    };
    const rel = makeRelationship(
      '40000000-0000-4000-a000-000000006202',
      '40000000-0000-4000-a000-deadbeef0001',
      '40000000-0000-4000-a000-deadbeef0002',
    );

    const create = provider.createRelationship(TEST_REPO, rel);

    await expect(create).rejects.toBeInstanceOf(DuplicateRelationshipError);
    await expect(create).rejects.toMatchObject({ relationshipId: rel.id, cause: driverError });
  });

  it('createRepository → DuplicateRepositoryError with the driver error as cause', async () => {
    const { provider, stub } = makeProvider();
    const driverError = cosmosResponseError(409);
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith("g.addV('_vocabulary')")) throw driverError;
      return { items: [0] };
    };

    const create = provider.createRepository({
      repositoryId: TEST_REPO,
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'creator',
    });

    await expect(create).rejects.toBeInstanceOf(DuplicateRepositoryError);
    await expect(create).rejects.toMatchObject({ cause: driverError });
  });

  it('createEntity lets any other store error through unchanged', async () => {
    const { provider, stub } = makeProvider();
    const driverError = cosmosResponseError(400);
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith(ENTITY_CREATE_START)) throw driverError;
      return { items: [] };
    };

    await expect(
      provider.createEntity(TEST_REPO, makeEntity('40000000-0000-4000-a000-000000006203')),
    ).rejects.toBe(driverError);
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
    if (query.startsWith(ENTITY_CREATE_START)) {
      return { items: [{ id: 'created-vertex' }] };
    }
    return { items: [] };
  };
  return {
    provider,
    stub,
    getCreateCall: () => {
      const call = stub.calls.find((c) =>
        c.query.startsWith(ENTITY_CREATE_START),
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
        c.query.startsWith(ENTITY_CREATE_START),
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
        c.query.startsWith(ENTITY_CREATE_START),
      );
    expect(createCalls).toHaveLength(0);
  });

  it('duplicate-detection sentinel path still fires when scalars are present', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.startsWith(ENTITY_CREATE_START)) {
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
    if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
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

    // The pre-read and the marker check, and no write.
    expect(after - before).toBe(2);
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
        // Bucket emits the matched ids and the marker's id; ENTITY_MISSING is
        // filtered out by the partition+id predicate on the server.
        return { items: [[ENTITY_A, ENTITY_B, params?.['mid']]] };
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

  it('deleteEntities returns all ids as notFound when the bucket holds only the marker', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query.includes("aggregate('found')") && query.startsWith('g.V().')) {
        return { items: [[params?.['mid']]] };
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

  it('deleteRelationships reads the marker, then drops each chunk in one call, and splits deleted/notFound', async () => {
    const { provider, stub } = makeProvider();
    const REL_A = '40000000-0000-4000-a000-000000007010';
    const REL_B = '40000000-0000-4000-a000-000000007011';
    const REL_MISSING = '40000000-0000-4000-a000-000000007099';

    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query.includes("aggregate('found')") && query.startsWith('g.E().')) {
        return { items: [[REL_A, REL_B]] };
      }
      return { items: [] };
    };

    const before = stub.calls.length;
    const result = await provider.deleteRelationships(TEST_REPO, [REL_A, REL_B, REL_MISSING]);
    const after = stub.calls.length;

    expect(after - before).toBe(2);
    expect(result.deleted).toEqual([REL_A, REL_B]);
    expect(result.notFound).toEqual([REL_MISSING]);

    const [marker, issued] = stub.calls.slice(before);
    expect(marker!.query).toBe(REPOSITORY_MARKER_COUNT_QUERY);
    expect(issued!.query).toBe(buildEdgeDeleteQuery('id0, id1, id2'));
    expect(issued!.query.startsWith("g.E().has('repositoryId', rid).hasId(")).toBe(true);
  });

  it('deleteEntities sends one chunk of up to 100 ids per call', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      return { items: [[params?.['mid']]] };
    };
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);

    const before = stub.calls.length;
    const result = await provider.deleteEntities(TEST_REPO, ids);

    expect(stub.calls.length - before).toBe(2);
    expect(result.notFound).toHaveLength(150);
    expect(Object.keys(stub.calls[before]!.params!).filter((k) => /^id\d+$/.test(k))).toHaveLength(100);
    expect(Object.keys(stub.calls[before + 1]!.params!).filter((k) => /^id\d+$/.test(k))).toHaveLength(50);
  });

  it('deleteRelationships reads the marker ahead of each chunk of up to 100 ids', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      return { items: [[params?.['id0']]] };
    };
    const ids = Array.from({ length: 150 }, (_, i) => `rel-${i}`);
    const names = (n: number): string => Array.from({ length: n }, (_, i) => `id${i}`).join(', ');

    const before = stub.calls.length;
    const result = await provider.deleteRelationships(TEST_REPO, ids);

    expect(stub.calls.slice(before).map((c) => c.query)).toEqual([
      REPOSITORY_MARKER_COUNT_QUERY,
      buildEdgeDeleteQuery(names(100)),
      REPOSITORY_MARKER_COUNT_QUERY,
      buildEdgeDeleteQuery(names(50)),
    ]);
    expect(result.deleted).toEqual(['rel-0', 'rel-100']);
    expect(result.notFound).toHaveLength(148);
  });

  it('deleteEntity and deleteRelationship throw not-found for an id that does not match', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query.startsWith('g.V().')) return { items: [[params?.['mid']]] };
      return { items: [[]] };
    };

    await expect(provider.deleteEntity(TEST_REPO, ENTITY_MISSING)).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(provider.deleteRelationship(TEST_REPO, ENTITY_MISSING)).rejects.toBeInstanceOf(
      RelationshipNotFoundError,
    );
  });

  it('deleteEntity and deleteRelationship resolve when the id is found and dropped', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [1] };
      if (query.startsWith('g.V().')) return { items: [[params?.['mid'], params?.['id0']]] };
      return { items: [[params?.['id0']]] };
    };

    await expect(provider.deleteEntity(TEST_REPO, ENTITY_A)).resolves.toBeUndefined();
    await expect(provider.deleteRelationship(TEST_REPO, 'rel-1')).resolves.toBeUndefined();
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

// ─── findEntities routes through the Document (SQL) endpoint ──────────
//
// All findEntities calls — with or without searchTerm / properties — go
// through CosmosDocumentClient.query against the Cosmos NoSQL endpoint, a
// single-partition query, rather than a Gremlin read filtered in JS. The
// Gremlin connection is not touched on this path. These tests inject a stub
// docClient and assert the SQL shape, parameter binding, parallel COUNT, and
// properties prefilter + client-side exact-match.

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

describe('findEntities SQL shape', () => {
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
    // result page and break pagination math.
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

// ─── Indexing-policy diagnostic in ensureSchema ───────────────────────
//
// `ensureSchema()` reads the container's indexing policy after the schema
// version is settled and warns when `excludedPaths` would force the
// findEntities SQL query to scan. Code-managed containers get the default
// policy (everything indexed). This guard catches containers provisioned via
// external ARM/Bicep that strip indexing on the searched paths.
//
// The diagnostic is unit-tested in isolation by invoking
// `runIndexingPolicyDiagnostic` directly via the private-access cast — going
// through `ensureSchema()` would require stubbing the module-scoped
// `cosmosRestPut` helper as well; that path needs a real container.

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

describe('ensureSchema indexing-policy diagnostic', () => {
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
// emission shape so an unscoped system-vertex lookup cannot come back.

describe('system-vertex queries scope by partition before hasId', () => {
  function partitionPredicateBeforeHasId(query: string): boolean {
    const partitionIdx = query.indexOf("has('repositoryId', rid)");
    if (partitionIdx === -1) return false;
    const hasIdIdx = query.indexOf('hasId(vid)');
    if (hasIdIdx === -1) return false;
    return partitionIdx < hasIdIdx;
  }

  it("getVocabulary issues g.V().has('repositoryId', rid).hasId(within(mid, vid))…", async () => {
    const { provider, stub } = makeProvider();
    await provider.getVocabulary(TEST_REPO);

    const last = stub.calls[stub.calls.length - 1]!;
    expect(last.query.startsWith("g.V().has('repositoryId', rid).hasId(within(mid, vid))")).toBe(true);
    expect(last.params).toEqual({ rid: TEST_REPO, mid: `repo:${TEST_REPO}`, vid: `vocab:${TEST_REPO}` });
  });

  it('saveVocabulary is one compare-and-set query, partition-scoped, filtered on the expected version', async () => {
    const { provider, stub } = makeProvider();
    const next = makeVocabulary('1.1.0');

    await provider.saveVocabulary(TEST_REPO, next, '1.0.0');

    expect(stub.calls).toHaveLength(1);
    const write = stub.calls[0]!;
    expect(write.query).toBe(VOCABULARY_SAVE_QUERY);
    expect(partitionPredicateBeforeHasId(write.query)).toBe(true);
    // The version filter precedes the writes, so a stale version writes nothing.
    expect(write.query.indexOf("has('version', expectedVersion)")).toBeLessThan(
      write.query.indexOf('.property('),
    );
    expect(write.params).toEqual({
      rid: TEST_REPO,
      vid: `vocab:${TEST_REPO}`,
      expectedVersion: '1.0.0',
      newVersion: '1.1.0',
      vocabJson: JSON.stringify(next),
    });
  });

  it('saveVocabulary never creates the vocabulary vertex', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === VOCABULARY_SAVE_QUERY) return { items: [0] };
      return { items: [] };
    };

    await expect(
      provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0'),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.some((c) => c.query.includes('addV('))).toBe(false);
  });

  describe('saveVocabulary miss classification', () => {
    function stubMiss(state: { version: string; json: string } | null): {
      provider: CosmosDbProvider;
      stub: SubmitStub;
    } {
      const { provider, stub } = makeProvider();
      stub.submit = async (query, params) => {
        stub.calls.push({ query, params });
        if (query === VOCABULARY_SAVE_QUERY) return { items: [0] };
        if (query === VOCABULARY_STATE_QUERY) return { items: state === null ? [] : [state] };
        return { items: [] };
      };
      return { provider, stub };
    }

    it('no vertex → RepositoryNotFoundError', async () => {
      const { provider } = stubMiss(null);
      await expect(
        provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0'),
      ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    });

    it('version property matching the blob → VocabularyVersionConflictError with both versions', async () => {
      const { provider, stub } = stubMiss({
        version: '1.4.0',
        json: JSON.stringify(makeVocabulary('1.4.0')),
      });
      const save = provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0');
      await expect(save).rejects.toBeInstanceOf(VocabularyVersionConflictError);
      await expect(save).rejects.toMatchObject({
        repositoryId: TEST_REPO,
        expectedVersion: '1.0.0',
        actualVersion: '1.4.0',
      });

      // The follow-up reads version and blob together, partition-scoped.
      expect(stub.calls).toHaveLength(2);
      const followUp = stub.calls[1]!;
      expect(followUp.query).toBe(VOCABULARY_STATE_QUERY);
      expect(followUp.query).toContain("coalesce(values('version'), constant(''))");
      expect(partitionPredicateBeforeHasId(followUp.query)).toBe(true);
      expect(followUp.params).toEqual({ rid: TEST_REPO, vid: `vocab:${TEST_REPO}` });
    });

    function stubThrowingWrite(
      status: number,
      state: { version: string; json: string } | null,
    ): { provider: CosmosDbProvider; stub: SubmitStub } {
      const { provider, stub } = makeProvider();
      stub.submit = async (query, params) => {
        stub.calls.push({ query, params });
        if (query === VOCABULARY_SAVE_QUERY) {
          // Shape of the gremlin driver's ResponseError: the protocol status
          // is a generic server error, the Cosmos status is in the attributes.
          throw Object.assign(
            new Error('Server error: {"ActivityId":"0000","StatusCode":' + status + '} (500)'),
            { statusCode: 500, statusAttributes: { 'x-ms-status-code': status } },
          );
        }
        if (query === VOCABULARY_STATE_QUERY) return { items: state === null ? [] : [state] };
        return { items: [] };
      };
      return { provider, stub };
    }

    it('a 412 from a lost optimistic-concurrency race is classified as a version conflict', async () => {
      const { provider, stub } = stubThrowingWrite(412, {
        version: '1.7.0',
        json: JSON.stringify(makeVocabulary('1.7.0')),
      });

      const save = provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0');
      await expect(save).rejects.toBeInstanceOf(VocabularyVersionConflictError);
      await expect(save).rejects.toMatchObject({ expectedVersion: '1.0.0', actualVersion: '1.7.0' });
      // No retry of the write: one attempt, then the classification read.
      expect(stub.calls.map((c) => c.query)).toEqual([VOCABULARY_SAVE_QUERY, VOCABULARY_STATE_QUERY]);
    });

    it('a 404 from a write racing a drop is classified as a missing repository', async () => {
      const { provider } = stubThrowingWrite(404, null);

      await expect(
        provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0'),
      ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    });

    it('any other write failure propagates unchanged, without the classification read', async () => {
      const { provider, stub } = stubThrowingWrite(400, null);

      await expect(
        provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0'),
      ).rejects.toThrow(/Server error/);
      expect(stub.calls.map((c) => c.query)).toEqual([VOCABULARY_SAVE_QUERY]);
    });

    it('vertex already holding exactly this write (a retried submit that landed) → success', async () => {
      const next = makeVocabulary('1.1.0');
      const { provider, stub } = stubMiss({ version: '1.1.0', json: JSON.stringify(next) });

      await expect(provider.saveVocabulary(TEST_REPO, next, '1.0.0')).resolves.toBeUndefined();
      expect(stub.calls).toHaveLength(2);
    });

    it('same version but a different blob is still a conflict', async () => {
      const ours = makeVocabulary('1.1.0');
      const theirs = { ...makeVocabulary('1.1.0'), modifiedBy: 'someone-else' };
      const { provider } = stubMiss({ version: '1.1.0', json: JSON.stringify(theirs) });

      await expect(provider.saveVocabulary(TEST_REPO, ours, '1.0.0')).rejects.toBeInstanceOf(
        VocabularyVersionConflictError,
      );
    });

    it('legacy vertex with no version property → ProviderError naming ensureSchema', async () => {
      const { provider } = stubMiss({ version: '', json: JSON.stringify(makeVocabulary('1.0.0')) });
      const save = provider.saveVocabulary(TEST_REPO, makeVocabulary('1.1.0'), '1.0.0');
      await expect(save).rejects.toBeInstanceOf(ProviderError);
      await expect(save).rejects.toThrow(/missing or stale version property.*run ensureSchema\(\)/);
    });

    it('version property out of step with the blob → ProviderError naming ensureSchema', async () => {
      const { provider } = stubMiss({ version: '1.0.0', json: JSON.stringify(makeVocabulary('1.2.0')) });
      const save = provider.saveVocabulary(TEST_REPO, makeVocabulary('1.3.0'), '1.2.0');
      await expect(save).rejects.toBeInstanceOf(ProviderError);
      await expect(save).rejects.toThrow(/run ensureSchema\(\)/);
    });
  });

  describe('createRepository', () => {
    const config = {
      repositoryId: TEST_REPO,
      label: 'Test',
      governanceConfig: { mode: 'open' as const },
      createdAt: '2026-05-26T00:00:00.000Z',
      createdBy: 'creator',
    };
    const PROBE = "g.V().has('repositoryId', rid).limit(1).count()";

    function stubCreate(probe: number, markerExists: number): {
      provider: CosmosDbProvider;
      stub: SubmitStub;
    } {
      const { provider, stub } = makeProvider();
      stub.submit = async (query, params) => {
        stub.calls.push({ query, params });
        if (query === PROBE) return { items: [probe] };
        if (query.includes(".has('label', lbl).count()")) return { items: [markerExists] };
        return { items: [] };
      };
      return { provider, stub };
    }

    it('probes the whole partition first, then writes the vocabulary and then the repository', async () => {
      const { provider, stub } = stubCreate(0, 0);
      const vocabulary = makeVocabulary('2.0.0');

      await provider.createRepository({ ...config, vocabulary });

      expect(stub.calls[0]!.query).toBe(PROBE);
      expect(stub.calls[0]!.params).toEqual({ rid: TEST_REPO });
      // An empty partition skips the marker lookup entirely.
      expect(stub.calls.some((c) => c.query.includes(".has('label', lbl).count()"))).toBe(false);

      const repoIdx = stub.calls.findIndex((c) => c.query.startsWith("g.addV('_repository')"));
      const vocabIdx = stub.calls.findIndex((c) => c.query.startsWith("g.addV('_vocabulary')"));
      // Vocabulary first: a create that stops between the two submits leaves
      // an unmarked partition, which the probe refuses and delete clears.
      expect(vocabIdx).toBeGreaterThan(0);
      expect(repoIdx).toBeGreaterThan(vocabIdx);

      const vocabWrite = stub.calls[vocabIdx]!;
      expect(vocabWrite.query).toBe(
        "g.addV('_vocabulary').property('id', vid).property('repositoryId', rid)" +
          ".property('version', vocabVersion).property('vocabulary', vocabJson)",
      );
      expect(vocabWrite.params).toEqual({
        vid: `vocab:${TEST_REPO}`,
        rid: TEST_REPO,
        vocabVersion: '2.0.0',
        vocabJson: JSON.stringify(vocabulary),
      });
    });

    it('seeds an empty vocabulary attributed to the creator when none is supplied', async () => {
      const { provider, stub } = stubCreate(0, 0);

      await provider.createRepository(config);

      const vocabWrite = stub.calls.find((c) => c.query.startsWith("g.addV('_vocabulary')"))!;
      const seeded = JSON.parse(vocabWrite.params!['vocabJson'] as string) as MemoryVocabulary;
      expect(seeded.entityTypes).toEqual([]);
      expect(seeded.relationshipTypes).toEqual([]);
      expect(seeded.modifiedBy).toBe('creator');
      expect(vocabWrite.params!['vocabVersion']).toBe(seeded.version);
    });

    it('an occupied partition with a marker → DuplicateRepositoryError, nothing written', async () => {
      const { provider, stub } = stubCreate(1, 1);

      await expect(provider.createRepository(config)).rejects.toBeInstanceOf(DuplicateRepositoryError);

      const existence = stub.calls.find((c) => c.query.includes(".has('label', lbl).count()"));
      expect(existence).toBeDefined();
      expect(partitionPredicateBeforeHasId(existence!.query)).toBe(true);
      expect(existence!.params!['rid']).toBe(TEST_REPO);
      expect(stub.calls.some((c) => c.query.includes('addV('))).toBe(false);
    });

    it('an occupied partition with no marker → ProviderError naming deleteRepository, nothing written', async () => {
      const { provider, stub } = stubCreate(1, 0);

      const create = provider.createRepository(config);
      await expect(create).rejects.toBeInstanceOf(ProviderError);
      await expect(create).rejects.toThrow(
        `Repository "${TEST_REPO}" still holds data from a delete that did not finish; call deleteRepository("${TEST_REPO}") to finish it, then create it again`,
      );
      expect(stub.calls.some((c) => c.query.includes('addV('))).toBe(false);
    });
  });

  describe('deleteRepository', () => {
    const MARKER_DROP =
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository')" +
      ".aggregate('found').by('id').drop().cap('found')";
    const PROBE = "g.V().has('repositoryId', rid).limit(1).count()";
    const SENTINEL_READ = "g.V().has('repositoryId', pk).hasId(sid).values('repositoryIds')";

    function stubDelete(options: {
      markerDropped: boolean;
      remaining: number;
      indexed: string[];
      /** A re-create lands after this many vertex batches have run. */
      recreatedAfterBatches?: number;
      /** A re-create lands just before the sentinel cleanup. */
      recreatedBeforeCleanup?: boolean;
      /** Edges in the partition; each edge batch drops up to 500. */
      edges?: number;
      /** Entity vertices in the partition; each entity batch drops up to 500. */
      entities?: number;
      /** Whether the marker point read finds the marker (default true). */
      markerExists?: boolean;
    }): { provider: CosmosDbProvider; stub: SubmitStub } {
      const { provider, stub } = makeProvider();
      const defaultSubmit = stub.submit;
      let edgesLeft = options.edges ?? 0;
      let entitiesLeft = options.entities ?? 0;
      // The vertex drain's remaining-count check is the same query as the
      // partition probe; once a drain batch has run, the partition is empty
      // unless a re-create has landed.
      let batches = 0;
      const recreated = (): boolean =>
        options.recreatedAfterBatches !== undefined && batches >= options.recreatedAfterBatches;
      stub.submit = async (query, params) => {
        stub.calls.push({ query, params });
        if (query === MARKER_DROP) {
          return { items: [options.markerDropped ? [`repo:${TEST_REPO}`] : []] };
        }
        if (query === DELETE_VERTEX_BATCH_QUERY) {
          if (recreated()) return { items: ['__recreated'] };
          batches++;
          return { items: [] };
        }
        if (query === REPOSITORY_MARKER_COUNT_QUERY) return { items: [options.markerExists === false ? 0 : 1] };
        // An aggregate-then-drop batch returns the bucket of dropped ids.
        const droppedIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `dropped-${i}`);
        if (query === EDGE_BATCH_DROP_QUERY) {
          const dropped = Math.min(edgesLeft, 500);
          edgesLeft -= dropped;
          return { items: [droppedIds(dropped)] };
        }
        if (query === ENTITY_BATCH_DROP_QUERY) {
          const dropped = Math.min(entitiesLeft, 500);
          entitiesLeft -= dropped;
          return { items: [droppedIds(dropped)] };
        }
        if (query === ENTITY_BATCH_COUNT_QUERY) return { items: [Math.min(entitiesLeft, 500)] };
        if (query === DELETE_ENTITY_BATCH_QUERY) {
          entitiesLeft = Math.max(0, entitiesLeft - 500);
          return { items: [] };
        }
        if (query === PROBE) {
          if (batches === 0) return { items: [options.remaining] };
          return { items: [recreated() ? 1 : 0] };
        }
        if (query === SENTINEL_READ) return { items: [JSON.stringify(options.indexed)] };
        if (query === DELETE_INDEX_ENTRY_QUERY) {
          return { items: options.recreatedBeforeCleanup === true ? ['__recreated'] : [] };
        }
        // Everything else (edge batches, counts, vocabulary reads for
        // traversal compilation) gets the default stub's answer; the default
        // stub records the call itself, so drop the duplicate entry.
        stub.calls.pop();
        return defaultSubmit(query, params);
      };
      return { provider, stub };
    }

    it('vertex batches and the sentinel cleanup are gated on the marker being absent', () => {
      const gate =
        "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').fold()" +
        ".coalesce(unfold().constant('__recreated'),";
      expect(DELETE_VERTEX_BATCH_QUERY).toBe(
        `${gate}__.V().has('repositoryId', rid).limit(batchSize).drop())`,
      );
      expect(DELETE_INDEX_ENTRY_QUERY).toBe(
        `${gate}__.V().has('repositoryId', pk).hasId(sid).property('repositoryIds', updatedIndex))`,
      );
    });

    it('drops the repository marker first, partition-scoped, then probes, then drains', async () => {
      const { provider, stub } = stubDelete({ markerDropped: true, remaining: 1, indexed: [TEST_REPO], edges: 1 });

      await provider.deleteRepository(TEST_REPO);

      expect(stub.calls[0]!.query).toBe(MARKER_DROP);
      expect(partitionPredicateBeforeHasId(stub.calls[0]!.query)).toBe(true);
      expect(stub.calls[0]!.params).toEqual({ rid: TEST_REPO, vid: `repo:${TEST_REPO}` });
      expect(stub.calls[1]!.query).toBe(PROBE);
      expect(stub.calls[1]!.params).toEqual({ rid: TEST_REPO });
      const firstEdgeBatch = stub.calls.findIndex((c) => c.query === EDGE_BATCH_DROP_QUERY);
      const firstBatch = stub.calls.findIndex((c) => c.query === DELETE_VERTEX_BATCH_QUERY);
      expect(firstEdgeBatch).toBeGreaterThan(1);
      expect(firstBatch).toBeGreaterThan(firstEdgeBatch);
      expect(stub.calls[firstBatch]!.params).toEqual({
        rid: TEST_REPO,
        vid: `repo:${TEST_REPO}`,
        batchSize: 500,
      });
      // The sentinel entry is removed last.
      const cleanup = stub.calls[stub.calls.length - 1]!;
      expect(cleanup.query).toBe(DELETE_INDEX_ENTRY_QUERY);
      expect(cleanup.params).toEqual({
        rid: TEST_REPO,
        vid: `repo:${TEST_REPO}`,
        pk: '_index',
        sid: '_repository_index',
        updatedIndex: JSON.stringify([]),
      });
    });

    it('drains in batches sized by bounded reads, without counting the repository first', async () => {
      const { provider, stub } = stubDelete({
        markerDropped: true,
        remaining: 1,
        indexed: [TEST_REPO],
        edges: 700,
        entities: 520,
      });
      const progress: Array<{ entitiesDeleted: number; relationshipsDeleted: number }> = [];

      const result = await provider.deleteRepository(TEST_REPO, (p) => {
        progress.push(p);
      });

      expect(result).toEqual({ deletedEntities: 520, deletedRelationships: 700 });
      expect(progress).toEqual([
        { entitiesDeleted: 0, relationshipsDeleted: 500 },
        { entitiesDeleted: 0, relationshipsDeleted: 700 },
        { entitiesDeleted: 500, relationshipsDeleted: 700 },
        { entitiesDeleted: 520, relationshipsDeleted: 700 },
      ]);
      // Every read is bounded: a batch-sized count or a one-item probe.
      for (const call of stub.calls.filter((c) => c.query.endsWith('.count()'))) {
        expect(call.query).toMatch(/\.limit\((batchSize|1)\)\.count\(\)$/);
      }
      // Two edge batches drop 500 and 200 and report it; a third finds none.
      expect(stub.calls.filter((c) => c.query === EDGE_BATCH_DROP_QUERY)).toHaveLength(3);
      for (const call of stub.calls.filter((c) => c.query === EDGE_BATCH_DROP_QUERY)) {
        expect(call.params).toEqual({ rid: TEST_REPO, batchSize: 500 });
      }
      expect(stub.calls.filter((c) => c.query === DELETE_ENTITY_BATCH_QUERY)).toHaveLength(2);
      for (const call of stub.calls.filter((c) => c.query === DELETE_ENTITY_BATCH_QUERY)) {
        expect(call.params).toEqual({ rid: TEST_REPO, vid: `repo:${TEST_REPO}`, batchSize: 500 });
      }
    });

    it('deleteAllContents drains in bounded batches and reports what it dropped', async () => {
      const { provider, stub } = stubDelete({ markerDropped: true, remaining: 1, indexed: [TEST_REPO], edges: 3, entities: 2 });
      const progress: Array<{ entitiesDeleted: number; relationshipsDeleted: number }> = [];

      const result = await provider.deleteAllContents(TEST_REPO, (p) => {
        progress.push(p);
      });

      expect(result).toEqual({ deletedEntities: 2, deletedRelationships: 3 });
      expect(progress).toEqual([
        { entitiesDeleted: 0, relationshipsDeleted: 3 },
        { entitiesDeleted: 2, relationshipsDeleted: 3 },
      ]);
      // The marker is read first, partition-scoped, and left alone with the
      // system vertices.
      expect(stub.calls[0]!.query).toBe(REPOSITORY_MARKER_COUNT_QUERY);
      expect(partitionPredicateBeforeHasId(stub.calls[0]!.query)).toBe(true);
      expect(stub.calls[0]!.params).toEqual({ rid: TEST_REPO, vid: `repo:${TEST_REPO}` });
      expect(stub.calls.some((c) => c.query === MARKER_DROP || c.query === DELETE_VERTEX_BATCH_QUERY)).toBe(false);
      // Each batch is one bounded submit that reports what it dropped; there
      // is no separate sizing read.
      expect(stub.calls.some((c) => c.query === ENTITY_BATCH_COUNT_QUERY)).toBe(false);
      for (const call of stub.calls.filter((c) => c.query === EDGE_BATCH_DROP_QUERY || c.query === ENTITY_BATCH_DROP_QUERY)) {
        expect(call.query).toContain('.limit(batchSize).aggregate(');
        expect(call.params).toEqual({ rid: TEST_REPO, batchSize: 500 });
      }
    });

    it('deleteAllContents on a missing repository throws RepositoryNotFoundError and drops nothing', async () => {
      const { provider, stub } = stubDelete({ markerDropped: false, remaining: 0, indexed: [], markerExists: false });

      await expect(provider.deleteAllContents(TEST_REPO)).rejects.toBeInstanceOf(RepositoryNotFoundError);

      expect(stub.calls.map((c) => c.query)).toEqual([REPOSITORY_MARKER_COUNT_QUERY]);
    });

    it('nothing at all for the id → RepositoryNotFoundError, no drain', async () => {
      const { provider, stub } = stubDelete({ markerDropped: false, remaining: 0, indexed: [] });

      await expect(provider.deleteRepository(TEST_REPO)).rejects.toBeInstanceOf(RepositoryNotFoundError);

      const probe = stub.calls.find((c) => c.query === PROBE);
      expect(probe!.params).toEqual({ rid: TEST_REPO });
      expect(stub.calls.some((c) => c.query.includes('drop()') && c.query !== MARKER_DROP)).toBe(false);
      expect(stub.calls.some((c) => c.query === DELETE_INDEX_ENTRY_QUERY)).toBe(false);
    });

    it('an interrupted delete (no marker, vertices remain) is finished by a retry', async () => {
      const { provider, stub } = stubDelete({ markerDropped: false, remaining: 1, indexed: [TEST_REPO] });

      await provider.deleteRepository(TEST_REPO);

      expect(stub.calls.some((c) => c.query === DELETE_VERTEX_BATCH_QUERY)).toBe(true);
      const cleanup = stub.calls.find((c) => c.query === DELETE_INDEX_ENTRY_QUERY);
      expect(JSON.parse(cleanup!.params!['updatedIndex'] as string)).toEqual([]);
    });

    it('an empty partition still listed in the sentinel is cleaned up without draining', async () => {
      const { provider, stub } = stubDelete({ markerDropped: false, remaining: 0, indexed: [TEST_REPO] });

      await provider.deleteRepository(TEST_REPO);

      expect(stub.calls.some((c) => c.query.includes('.limit(batchSize).drop()'))).toBe(false);
      const cleanup = stub.calls.find((c) => c.query === DELETE_INDEX_ENTRY_QUERY);
      expect(cleanup).toBeDefined();
      expect(JSON.parse(cleanup!.params!['updatedIndex'] as string)).toEqual([]);
    });

    it('a dropped marker over an otherwise empty partition skips both drains', async () => {
      const { provider, stub } = stubDelete({ markerDropped: true, remaining: 0, indexed: [TEST_REPO] });

      await expect(provider.deleteRepository(TEST_REPO)).resolves.toEqual({
        deletedEntities: 0,
        deletedRelationships: 0,
      });

      expect(stub.calls.map((c) => c.query)).toEqual([
        MARKER_DROP,
        PROBE,
        SENTINEL_READ,
        DELETE_INDEX_ENTRY_QUERY,
      ]);
    });

    it('stops draining and skips the sentinel cleanup once a re-create has landed', async () => {
      const { provider, stub } = stubDelete({
        markerDropped: true,
        remaining: 1,
        indexed: [TEST_REPO],
        recreatedAfterBatches: 1,
      });

      await expect(provider.deleteRepository(TEST_REPO)).resolves.toEqual({
        deletedEntities: 0,
        deletedRelationships: 0,
      });

      // Batch 1 drained the old vertices; the remaining check saw the
      // re-created ones; batch 2 found the new marker and did nothing.
      expect(stub.calls.filter((c) => c.query === DELETE_VERTEX_BATCH_QUERY)).toHaveLength(2);
      expect(stub.calls.some((c) => c.query === DELETE_INDEX_ENTRY_QUERY)).toBe(false);
    });

    it('a sentinel cleanup that finds a re-created marker leaves the sentinel alone', async () => {
      const { provider } = stubDelete({
        markerDropped: true,
        remaining: 0,
        indexed: [TEST_REPO],
        recreatedBeforeCleanup: true,
      });

      // The gated write emits the re-create sentinel and writes nothing; the
      // delete itself is complete.
      await expect(provider.deleteRepository(TEST_REPO)).resolves.toEqual({
        deletedEntities: 0,
        deletedRelationships: 0,
      });
    });

    it('drops the cached vocabulary even when the repository is not found', async () => {
      const { provider, stub } = stubDelete({ markerDropped: false, remaining: 0, indexed: [] });

      await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);
      await expect(provider.deleteRepository(TEST_REPO)).rejects.toBeInstanceOf(RepositoryNotFoundError);
      await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL);

      expect(stub.calls.filter((c) => stub.isVocabRead(c))).toHaveLength(2);
    });
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

// ─── Vocabulary version backfill ─────────────────────────────────────
//
// ensureSchema repairs the native `version` property on `_vocabulary`
// vertices so compare-and-set can match. The scan reads every vertex; only
// inconsistent ones are written, each with a partition-scoped write guarded
// on the exact blob that was decoded.

describe('backfillVocabularyVersions', () => {
  const RID_CONSISTENT = '40000000-0000-4000-a000-00000000b001';
  const RID_LEGACY = '40000000-0000-4000-a000-00000000b002';
  const RID_STALE = '40000000-0000-4000-a000-00000000b003';
  const RID_UNPARSEABLE = '40000000-0000-4000-a000-00000000b004';
  const RID_FAILING = '40000000-0000-4000-a000-00000000b005';

  interface ScanCall {
    sql: string;
    parameters: CosmosQueryParameter[];
    continuationToken: string | null | undefined;
  }

  /**
   * A vocabulary vertex as the document endpoint returns it: `repositoryId`
   * flat, every other Gremlin property an array of `{ _value, id }`, and a
   * missing property simply absent.
   */
  function vocabDoc(rid: string, version: string | null, json: string | null): Record<string, unknown> {
    const doc: Record<string, unknown> = { repositoryId: rid };
    if (version !== null) doc['version'] = [{ _value: version, id: 'p-version' }];
    if (json !== null) doc['vocabulary'] = [{ _value: json, id: 'p-vocabulary' }];
    return doc;
  }

  function stubBackfill(
    pages: unknown[][],
    onWrite: (params: Record<string, unknown> | undefined) => GremlinResult = () => ({ items: [1] }),
  ): {
    conn: CosmosDbConnection;
    docClient: CosmosDocumentClient;
    writes: SubmitCall[];
    scans: ScanCall[];
  } {
    const writes: SubmitCall[] = [];
    const scans: ScanCall[] = [];
    const conn = {
      submit: async (query: string, params?: Record<string, unknown>): Promise<GremlinResult> => {
        writes.push({ query, params });
        return onWrite(params);
      },
    } as unknown as CosmosDbConnection;
    const docClient = {
      query: async (
        sql: string,
        parameters: CosmosQueryParameter[],
        options: { continuationToken?: string | null },
      ): Promise<CosmosQueryResult<unknown>> => {
        const index = scans.length;
        scans.push({ sql, parameters, continuationToken: options.continuationToken });
        return {
          documents: pages[index] ?? [],
          requestCharge: 0,
          queryMetrics: null,
          continuationToken: index + 1 < pages.length ? `token-${index + 1}` : null,
        };
      },
    } as unknown as CosmosDocumentClient;
    return { conn, docClient, writes, scans };
  }

  function lostRace(status: number): Error {
    return Object.assign(new Error(`Server error: ActivityId : 1234 (500)`), {
      statusCode: 500,
      statusAttributes: { 'x-ms-status-code': status },
    });
  }

  it('scans system vocabulary vertices only, through the document endpoint, cross-partition', async () => {
    const { conn, docClient, scans } = stubBackfill([[]]);

    await backfillVocabularyVersions(conn, docClient);

    expect(scans).toHaveLength(1);
    expect(scans[0]!.sql).toBe(VOCABULARY_BACKFILL_SCAN_SQL);
    // Tenant entities of type `_vocabulary` carry `entityType`; the system
    // vertex never does.
    expect(VOCABULARY_BACKFILL_SCAN_SQL).toContain('NOT IS_DEFINED(c.entityType)');
    expect(scans[0]!.parameters).toEqual([{ name: '@label', value: '_vocabulary' }]);
    expect(scans[0]!.continuationToken).toBeNull();
  });

  it('pages the scan with continuation tokens until exhausted', async () => {
    const { conn, docClient, scans, writes } = stubBackfill([
      [vocabDoc(RID_LEGACY, null, JSON.stringify(makeVocabulary('1.0.0')))],
      [vocabDoc(RID_STALE, '1.0.0', JSON.stringify(makeVocabulary('1.1.0')))],
    ]);

    const result = await backfillVocabularyVersions(conn, docClient);

    expect(scans.map((s) => s.continuationToken)).toEqual([null, 'token-1']);
    expect(result).toEqual({ scanned: 2, repaired: 2, failures: [] });
    expect(writes.map((w) => w.params!['rid'])).toEqual([RID_LEGACY, RID_STALE]);
  });

  it('repairs only inconsistent vertices, each guarded on its exact blob, partition first', async () => {
    const legacyJson = JSON.stringify(makeVocabulary('1.3.0'));
    const staleJson = JSON.stringify(makeVocabulary('2.1.0'));
    const { conn, docClient, writes } = stubBackfill([
      [
        vocabDoc(RID_CONSISTENT, '1.0.0', JSON.stringify(makeVocabulary('1.0.0'))),
        vocabDoc(RID_LEGACY, null, legacyJson),
        vocabDoc(RID_STALE, '2.0.0', staleJson),
      ],
    ]);

    const result = await backfillVocabularyVersions(conn, docClient);

    expect(result).toEqual({ scanned: 3, repaired: 2, failures: [] });
    expect(writes.map((w) => w.query)).toEqual([
      VOCABULARY_BACKFILL_WRITE_QUERY,
      VOCABULARY_BACKFILL_WRITE_QUERY,
    ]);
    expect(writes.map((w) => w.params)).toEqual([
      { rid: RID_LEGACY, vid: `vocab:${RID_LEGACY}`, vocabJson: legacyJson, vocabVersion: '1.3.0' },
      { rid: RID_STALE, vid: `vocab:${RID_STALE}`, vocabJson: staleJson, vocabVersion: '2.1.0' },
    ]);
    const write = VOCABULARY_BACKFILL_WRITE_QUERY;
    expect(write.startsWith("g.V().has('repositoryId', rid).hasId(vid)")).toBe(true);
    expect(write).toContain("hasNot('entityType')");
    expect(write.indexOf("has('vocabulary', vocabJson)")).toBeLessThan(write.indexOf('.property('));
  });

  it('writes nothing when every vertex is consistent', async () => {
    const { conn, docClient, writes } = stubBackfill([
      [vocabDoc(RID_CONSISTENT, '1.0.0', JSON.stringify(makeVocabulary('1.0.0')))],
    ]);

    expect(await backfillVocabularyVersions(conn, docClient)).toEqual({ scanned: 1, repaired: 0, failures: [] });
    expect(writes).toHaveLength(0);
  });

  it('a blob guard that misses (concurrent rewrite) is neither repaired nor a failure', async () => {
    const { conn, docClient } = stubBackfill(
      [[vocabDoc(RID_LEGACY, null, JSON.stringify(makeVocabulary('1.0.0')))]],
      () => ({ items: [0] }),
    );

    expect(await backfillVocabularyVersions(conn, docClient)).toEqual({ scanned: 1, repaired: 0, failures: [] });
  });

  it.each([412, 404])('a repair write that loses a race (%i) is skipped, not a failure', async (status) => {
    const { conn, docClient } = stubBackfill(
      [[vocabDoc(RID_LEGACY, null, JSON.stringify(makeVocabulary('1.0.0')))]],
      () => {
        throw lostRace(status);
      },
    );

    expect(await backfillVocabularyVersions(conn, docClient)).toEqual({ scanned: 1, repaired: 0, failures: [] });
  });

  it('never writes a version the blob does not state, and records the vertex instead', async () => {
    const { conn, docClient, writes } = stubBackfill([
      [
        vocabDoc(RID_UNPARSEABLE, null, '{not json'),
        vocabDoc(RID_UNPARSEABLE, null, 'null'),
        vocabDoc(RID_UNPARSEABLE, null, '[1,2]'),
        vocabDoc(RID_UNPARSEABLE, null, JSON.stringify({ entityTypes: [] })),
        vocabDoc(RID_UNPARSEABLE, null, JSON.stringify({ version: '' })),
        vocabDoc(RID_UNPARSEABLE, null, null),
      ],
    ]);

    const result = await backfillVocabularyVersions(conn, docClient);

    expect(writes).toHaveLength(0);
    expect(result.repaired).toBe(0);
    expect(result.failures).toHaveLength(6);
    expect(result.failures.every((f) => f.repositoryId === RID_UNPARSEABLE)).toBe(true);
  });

  it('one bad vertex never aborts the pass', async () => {
    const goodJson = JSON.stringify(makeVocabulary('3.0.0'));
    const { conn, docClient, writes } = stubBackfill(
      [
        [
          null,
          'not-a-document',
          vocabDoc('', null, JSON.stringify(makeVocabulary('1.0.0'))),
          vocabDoc(RID_FAILING, null, JSON.stringify(makeVocabulary('1.0.0'))),
          vocabDoc(RID_LEGACY, null, goodJson),
        ],
      ],
      (params) => {
        if (params?.['rid'] === RID_FAILING) throw new ProviderError('write failed', 'retry');
        return { items: [1] };
      },
    );

    const result = await backfillVocabularyVersions(conn, docClient);

    expect(result.scanned).toBe(5);
    expect(result.repaired).toBe(1);
    expect(result.failures).toEqual([
      { repositoryId: '', reason: 'the vertex has no repositoryId' },
      { repositoryId: '', reason: 'the vertex has no repositoryId' },
      { repositoryId: '', reason: 'the vertex has no repositoryId' },
      { repositoryId: RID_FAILING, reason: 'write failed' },
    ]);
    const last = writes[writes.length - 1]!;
    expect(last.params!['rid']).toBe(RID_LEGACY);
    expect(last.params!['vocabVersion']).toBe('3.0.0');
  });

  it('propagates a failure to read a page of the scan', async () => {
    const conn = {} as unknown as CosmosDbConnection;
    const docClient = {
      query: async (): Promise<CosmosQueryResult<unknown>> => {
        throw new ProviderError('scan failed', 'retry');
      },
    } as unknown as CosmosDocumentClient;

    await expect(backfillVocabularyVersions(conn, docClient)).rejects.toThrow('scan failed');
  });
});

// ─── Deleted repository ─────────────────────────────────────────────
//
// Calls on a repository whose `_repository` marker is gone throw
// RepositoryNotFoundError, ahead of any per-entity or per-id outcome, and
// drop the traversal cache entry so a later traversal reads the vocabulary
// again.

describe('calls on a repository whose marker is gone', () => {
  const ENTITY_A = '40000000-0000-4000-a000-000000008001';
  const ENTITY_B = '40000000-0000-4000-a000-000000008002';

  /** A store whose marker is gone but whose other vertices remain. */
  function markerlessProvider(): { provider: CosmosDbProvider; stub: SubmitStub } {
    const made = makeProvider();
    const defaultSubmit = made.stub.submit;
    made.stub.submit = async (query, params) => {
      if (query === VOCABULARY_READ_QUERY) {
        made.stub.calls.push({ query, params });
        return { items: [{ id: params?.['vid'], json: JSON.stringify(makeVocabulary('1.0.0')) }] };
      }
      if (query === REPOSITORY_MARKER_COUNT_QUERY) {
        made.stub.calls.push({ query, params });
        return { items: [0] };
      }
      if (query.includes(".select('vs').unfold().has('entityType').drop()")) {
        // The matched ids come back, but not the marker's: nothing was dropped.
        made.stub.calls.push({ query, params });
        return { items: [[ENTITY_A]] };
      }
      if (query === SLUG_HOLDERS_QUERY) {
        made.stub.calls.push({ query, params });
        return { items: [ENTITY_B] };
      }
      if (query.includes(".values('properties').limit(1)")) {
        made.stub.calls.push({ query, params });
        return { items: ['{}'] };
      }
      return defaultSubmit(query, params);
    };
    return made;
  }

  it('getVocabulary throws, and a later traversal reads the vocabulary again', async () => {
    const { provider, stub } = makeProvider();
    await provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL); // fills the traversal cache
    const defaultSubmit = stub.submit;
    stub.submit = async (query, params) => {
      if (query === VOCABULARY_READ_QUERY) {
        stub.calls.push({ query, params });
        return { items: [] };
      }
      return defaultSubmit(query, params);
    };

    await expect(provider.getVocabulary(TEST_REPO, { fresh: true })).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.traverse(TEST_REPO, SIMPLE_TRAVERSAL)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.filter((c) => stub.isVocabRead(c))).toHaveLength(3);
  });

  it('getVocabulary throws when only the vocabulary vertex is left', async () => {
    const { provider } = markerlessProvider();
    await expect(provider.getVocabulary(TEST_REPO)).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('getRepositoryStats throws before running any count', async () => {
    const { provider, stub } = markerlessProvider();
    await expect(provider.getRepositoryStats(TEST_REPO)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.map((c) => c.query)).toEqual([VOCABULARY_READ_QUERY]);
  });

  it('deleteEntities throws when the bucket lacks the marker id', async () => {
    const { provider } = markerlessProvider();
    await expect(provider.deleteEntities(TEST_REPO, [ENTITY_A])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteEntity(TEST_REPO, ENTITY_A)).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('deleteRelationships and deleteRelationship read the marker and drop nothing without it', async () => {
    const { provider, stub } = markerlessProvider();
    await expect(provider.deleteRelationships(TEST_REPO, [ENTITY_A])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteRelationship(TEST_REPO, ENTITY_A)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.some((c) => c.query.includes('.drop()'))).toBe(false);
  });

  it('deleteEntities and deleteRelationships with no ids read the marker', async () => {
    const { provider, stub } = markerlessProvider();
    await expect(provider.deleteEntities(TEST_REPO, [])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteRelationships(TEST_REPO, [])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.map((c) => c.query)).toEqual([REPOSITORY_MARKER_COUNT_QUERY, REPOSITORY_MARKER_COUNT_QUERY]);
  });

  it('updateEntity throws RepositoryNotFoundError ahead of EntityNotFoundError and SlugConflictError', async () => {
    const { provider, stub } = markerlessProvider();
    const provenance = slugUpdate(undefined).provenance;

    await expect(provider.updateEntity(TEST_REPO, ENTITY_A, slugUpdate(undefined))).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(
      provider.updateEntity(TEST_REPO, ENTITY_A, { properties: { colour: 'red' }, provenance }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.updateEntity(TEST_REPO, ENTITY_A, slugUpdate('person:taken'))).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    // Every write the calls issued fetched the marker together with the entity.
    const writes = stub.calls.filter((c) => c.query.includes('.property('));
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write.query.startsWith(UPDATE_ENTITY_START)).toBe(true);
  });

  it('the guarded entity delete fetches the marker with the targets in its first step and drops only past it', () => {
    const query = buildGuardedEntityDeleteQuery('id0, id1');
    expect(query.startsWith("g.V().has('repositoryId', rid).hasId(within(mid, id0, id1))")).toBe(true);
    // No mid-traversal V(): only the first, index-backed step looks vertices up.
    expect(query.split('V()')).toHaveLength(2);
    // An entity typed `_repository` carries the marker's label; only the
    // marker lacks `entityType`.
    const markerAt = query.indexOf(".unfold().hasLabel('_repository').hasNot('entityType')");
    expect(markerAt).toBeGreaterThan(0);
    expect(query.indexOf('.drop()')).toBeGreaterThan(markerAt);
    expect(query.endsWith(".cap('found')")).toBe(true);
  });

  it('the update write fetches the marker with the entity in its first step', () => {
    expect(UPDATE_ENTITY_START.startsWith("g.V().has('repositoryId', rid).hasId(within(repoVid, eid))")).toBe(true);
    expect(UPDATE_ENTITY_START.split('V()')).toHaveLength(2);
    expect(UPDATE_ENTITY_START).toContain(".unfold().hasLabel('_repository').hasNot('entityType').select('vs')");
  });

  it('the marker read and the vocabulary read keep entity vertices out', () => {
    expect(REPOSITORY_MARKER_COUNT_QUERY).toContain(".hasLabel('_repository').hasNot('entityType').count()");
    expect(VOCABULARY_READ_QUERY).toContain(".hasLabel('_repository', '_vocabulary').hasNot('entityType')");
  });

  it('an entity delete whose marker vanishes at the second chunk throws and leaves the first chunk dropped', async () => {
    const { provider, stub } = makeProvider();
    let chunk = 0;
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      chunk += 1;
      // First chunk: marker present, every id dropped. Second: marker gone.
      return chunk === 1 ? { items: [[params?.['mid'], params?.['id0']]] } : { items: [[]] };
    };
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);

    await expect(provider.deleteEntities(TEST_REPO, ids)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    // Two guarded drops and nothing after: no compensating write for chunk 1.
    expect(stub.calls).toHaveLength(2);
    for (const call of stub.calls) expect(call.query).toContain(".hasNot('entityType').select('vs')");
  });

  it('an edge delete whose marker vanishes at the second chunk throws before that chunk drops', async () => {
    const { provider, stub } = makeProvider();
    let markerReads = 0;
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      if (query === REPOSITORY_MARKER_COUNT_QUERY) {
        markerReads += 1;
        return { items: [markerReads === 1 ? 1 : 0] };
      }
      return { items: [[params?.['id0']]] };
    };
    const ids = Array.from({ length: 150 }, (_, i) => `rel-${i}`);

    await expect(provider.deleteRelationships(TEST_REPO, ids)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stub.calls.map((c) => c.query)).toEqual([
      REPOSITORY_MARKER_COUNT_QUERY,
      buildEdgeDeleteQuery(Array.from({ length: 100 }, (_, i) => `id${i}`).join(', ')),
      REPOSITORY_MARKER_COUNT_QUERY,
    ]);
  });

  it('a guarded entity delete or a marker read with no row at all is a ProviderError', async () => {
    const { provider, stub } = makeProvider();
    stub.submit = async (query, params) => {
      stub.calls.push({ query, params });
      return { items: [] };
    };

    await expect(provider.deleteEntities(TEST_REPO, [ENTITY_A])).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.deleteEntities(TEST_REPO, [])).rejects.toBeInstanceOf(ProviderError);
    await expect(provider.deleteRelationships(TEST_REPO, [ENTITY_A])).rejects.toBeInstanceOf(ProviderError);
  });
});
