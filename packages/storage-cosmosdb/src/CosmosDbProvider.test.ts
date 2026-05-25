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
import type { TraversalSpec } from '@utaba/deep-memory/types';

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
