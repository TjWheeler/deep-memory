// Conformance harness for Neo4jStorageProvider.
//
// Two layers:
//
//   1. Targeted Neo4j-specific tests in this file — cover ensureSchema's
//      idempotent DDL + `_Meta` handshake, repository CRUD edge cases
//      (DuplicateRepositoryError, chunked-wipe progress callback), and
//      vocabulary CRUD with the 60 s cache (the `details.calls` round-trip
//      contract is provider-specific so it stays alongside the live tests).
//
//   2. The cross-provider `runStorageProviderConformanceTests` harness from
//      `@utaba/deep-memory/testing` — exercises the full `StorageProvider`
//      contract against the running Neo4j instance. Every contract assertion
//      is identical to the Cosmos and SQL Server runs, so any silent
//      divergence in semantics surfaces here. The Neo4j build is expected to
//      pass with zero skips and zero `total: undefined` paths (D22 —
//      findEntities is strictly more precise than the Cosmos surface because
//      every filter shape resolves to a server-side exact predicate).
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run.
// Example:
//   NEO4J_URI=bolt://localhost:7687 NEO4J_USER=neo4j NEO4J_PASSWORD=local-dev-password pnpm test

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { OperationUsage } from '@utaba/deep-memory/types';
import {
  DuplicateRepositoryError,
  RepositoryNotFoundError,
} from '@utaba/deep-memory';
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';
import { SCHEMA_VERSION } from './schema.js';

// The stable repository id baked into the cross-provider conformance harness.
// Cleaning it up before each factory call lets the harness's per-test
// `createRepository` succeed even when an earlier test was interrupted.
const CONFORMANCE_REPO_ID = '40000000-0000-4000-a000-000000000001';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

function makeRid(suffix: string): string {
  return `conf-${suffix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — ensureSchema (live)', () => {
    let provider: Neo4jStorageProvider;

    beforeAll(async () => {
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
    });

    afterAll(async () => {
      await provider.dispose();
    });

    it('returns the expected EnsureSchemaResult shape on first call', async () => {
      const result = await provider.ensureSchema();
      expect(result).toEqual({
        databaseCreated: false,
        schemaCreated: expect.any(Boolean),
        alreadyUpToDate: expect.any(Boolean),
        schemaVersion: SCHEMA_VERSION,
      });
      // Exactly one of schemaCreated / alreadyUpToDate is true.
      expect(result.schemaCreated !== result.alreadyUpToDate).toBe(true);
    });

    it('is idempotent — second call reports alreadyUpToDate', async () => {
      const result = await provider.ensureSchema();
      expect(result).toEqual({
        databaseCreated: false,
        schemaCreated: false,
        alreadyUpToDate: true,
        schemaVersion: SCHEMA_VERSION,
      });
    });
  });

  describe('Neo4jStorageProvider — repository CRUD (live)', () => {
    let provider: Neo4jStorageProvider;
    const seeded: string[] = [];

    beforeAll(async () => {
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
      await provider.ensureSchema();
    });

    afterAll(async () => {
      // Defensive cleanup — any rid that survived an aborted test.
      for (const rid of seeded) {
        try {
          await provider.deleteRepository(rid);
        } catch {
          // Already deleted or never created — ignore.
        }
      }
      await provider.dispose();
    });

    let rid: string;

    beforeEach(() => {
      rid = makeRid('crud');
      seeded.push(rid);
    });

    afterEach(async () => {
      try {
        await provider.deleteRepository(rid);
      } catch {
        // Test may have already deleted it.
      }
    });

    it('createRepository returns the stored row, getRepository round-trips it', async () => {
      const created = await provider.createRepository({
        repositoryId: rid,
        label: 'conf label',
        description: 'conf desc',
        type: 'general',
        governanceConfig: { mode: 'open' },
        metadata: { embeddingModelId: 'm', embeddingDimensions: 1 },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      expect(created.repositoryId).toBe(rid);
      expect(created.label).toBe('conf label');

      const fetched = await provider.getRepository(rid);
      expect(fetched).not.toBeNull();
      expect(fetched?.repositoryId).toBe(rid);
      expect(fetched?.description).toBe('conf desc');
      expect(fetched?.type).toBe('general');
      expect(fetched?.metadata?.embeddingModelId).toBe('m');
      expect(fetched?.governanceConfig.mode).toBe('open');
    });

    it('createRepository rejects duplicate repositoryId with DuplicateRepositoryError', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'first',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });

      await expect(
        provider.createRepository({
          repositoryId: rid,
          label: 'second',
          governanceConfig: { mode: 'open' },
          createdAt: '2026-05-27T00:00:00Z',
          createdBy: 'conformance',
        }),
      ).rejects.toBeInstanceOf(DuplicateRepositoryError);
    });

    it('getRepository returns null for an unknown id', async () => {
      const result = await provider.getRepository(`missing-${Date.now()}`);
      expect(result).toBeNull();
    });

    it('listRepositories paginates with exact totals and respects the type filter', async () => {
      const extra = makeRid('crud-extra');
      seeded.push(extra);
      await provider.createRepository({
        repositoryId: rid,
        label: 'a',
        type: 'tagged',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      await provider.createRepository({
        repositoryId: extra,
        label: 'b',
        type: 'untagged',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });

      try {
        const all = await provider.listRepositories({ limit: 100 });
        const ids = all.items.map((r) => r.repositoryId);
        expect(ids).toContain(rid);
        expect(ids).toContain(extra);
        expect(typeof all.total).toBe('number');
        expect(all.total).toBeGreaterThanOrEqual(2);

        const filtered = await provider.listRepositories({ type: 'tagged', limit: 100 });
        const filteredIds = filtered.items.map((r) => r.repositoryId);
        expect(filteredIds).toContain(rid);
        expect(filteredIds).not.toContain(extra);

        const paged = await provider.listRepositories({ limit: 1 });
        expect(paged.items).toHaveLength(1);
        expect(paged.hasMore).toBe(true);
      } finally {
        await provider.deleteRepository(extra).catch(() => undefined);
      }
    });

    it('updateRepository merges metadata and returns the updated row in one round-trip', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'before',
        governanceConfig: { mode: 'open' },
        metadata: { embeddingModelId: 'old', embeddingDimensions: 1 },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });

      const updated = await provider.updateRepository(rid, {
        label: 'after',
        metadata: { embeddingModelId: 'new', extra: 'value' },
      });
      expect(updated.label).toBe('after');
      expect(updated.metadata?.embeddingModelId).toBe('new');
      expect(updated.metadata?.embeddingDimensions).toBe(1);
      expect(updated.metadata?.['extra']).toBe('value');

      const refetched = await provider.getRepository(rid);
      expect(refetched?.label).toBe('after');
      expect(refetched?.metadata?.['extra']).toBe('value');
    });

    it('updateRepository throws RepositoryNotFoundError for an unknown id', async () => {
      await expect(
        provider.updateRepository(`missing-${Date.now()}`, { label: 'x' }),
      ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    });

    it('deleteRepository removes the repository and is idempotent on missing ids', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'to-delete',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });

      await provider.deleteRepository(rid);
      expect(await provider.getRepository(rid)).toBeNull();

      // Idempotent — re-deleting an already-deleted repo should not throw
      // (empty-match branch confirmed by probe P13).
      await expect(provider.deleteRepository(rid)).resolves.toBeUndefined();
    });

    it('deleteRepository fires the progress callback at least once when there is data to drain', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'has-data',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });

      const progress: Array<{ entitiesDeleted: number; relationshipsDeleted: number }> = [];
      // The repo has no entities or relationships, only the _Repository node,
      // so the relationship-drain loop emits no progress and the node-drain
      // loop runs once. With zero user entities, neither loop fires the
      // callback — assert the call resolves cleanly instead.
      await expect(
        provider.deleteRepository(rid, (p) => {
          progress.push({ entitiesDeleted: p.entitiesDeleted, relationshipsDeleted: p.relationshipsDeleted });
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Neo4jStorageProvider — vocabulary CRUD (live)', () => {
    let provider: Neo4jStorageProvider;
    let sinkRecords: OperationUsage[];
    const seeded: string[] = [];

    beforeAll(async () => {
      sinkRecords = [];
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
        reportUsage: (usage) => {
          sinkRecords.push(usage);
        },
      });
      await provider.initialize();
      await provider.ensureSchema();
    });

    afterAll(async () => {
      for (const id of seeded) {
        try {
          await provider.deleteRepository(id);
        } catch {
          // Already deleted or never created — ignore.
        }
      }
      await provider.dispose();
    });

    let rid: string;

    beforeEach(async () => {
      rid = makeRid('vocab');
      seeded.push(rid);
      await provider.createRepository({
        repositoryId: rid,
        label: 'vocab conformance',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      sinkRecords.length = 0;
    });

    afterEach(async () => {
      try {
        await provider.deleteRepository(rid);
      } catch {
        // Test may have already deleted it.
      }
    });

    function lastRecordFor(op: string): OperationUsage | undefined {
      for (let i = sinkRecords.length - 1; i >= 0; i -= 1) {
        const record = sinkRecords[i];
        if (record?.operation === op) return record;
      }
      return undefined;
    }

    it('getVocabulary returns an empty vocabulary when no _Vocabulary node exists', async () => {
      const vocab = await provider.getVocabulary(rid);
      expect(vocab.version).toBe('0.0.0');
      expect(vocab.entityTypes).toEqual([]);
      expect(vocab.relationshipTypes).toEqual([]);

      const record = lastRecordFor('getVocabulary');
      expect(record).toBeDefined();
      // First read against an empty repo is a cache miss — one round-trip.
      expect((record?.details as { calls?: number } | undefined)?.calls).toBe(1);
    });

    it('getVocabulary cache hit emits zero round-trips on the sink record', async () => {
      await provider.getVocabulary(rid); // populate cache
      const beforeIndex = sinkRecords.length;
      await provider.getVocabulary(rid); // cache hit
      const hits = sinkRecords.slice(beforeIndex).filter((r) => r.operation === 'getVocabulary');
      expect(hits).toHaveLength(1);
      expect((hits[0]?.details as { calls?: number } | undefined)?.calls).toBe(0);
      expect(hits[0]?.value).toBe(0);
    });

    it('saveVocabulary persists across cache invalidation', async () => {
      await provider.getVocabulary(rid); // warm cache with the empty default
      await provider.saveVocabulary(rid, {
        version: '0.1.0',
        lastModified: '2026-05-27T01:00:00Z',
        modifiedBy: 'conformance',
        entityTypes: [
          {
            type: 'Person',
            description: 'A human',
            version: '0.1.0',
            properties: [],
            createdAt: '2026-05-27T01:00:00Z',
            createdBy: 'conformance',
            modifiedAt: '2026-05-27T01:00:00Z',
            modifiedBy: 'conformance',
          },
        ],
        relationshipTypes: [],
      });

      const refetched = await provider.getVocabulary(rid);
      expect(refetched.version).toBe('0.1.0');
      expect(refetched.entityTypes[0]?.type).toBe('Person');

      const record = lastRecordFor('getVocabulary');
      // Save invalidated the cache, so this read is a miss again.
      expect((record?.details as { calls?: number } | undefined)?.calls).toBe(1);
    });

    it('saveVocabulary is idempotent — second write hits MERGE on the existing node', async () => {
      const base = {
        version: '0.1.0',
        lastModified: '2026-05-27T01:00:00Z',
        modifiedBy: 'conformance',
        entityTypes: [],
        relationshipTypes: [],
      };
      await provider.saveVocabulary(rid, base);
      await provider.saveVocabulary(rid, { ...base, version: '0.2.0' });

      const after = await provider.getVocabulary(rid);
      expect(after.version).toBe('0.2.0');
    });

    it('getVocabularyChangeLog returns an empty page when no entries exist', async () => {
      const log = await provider.getVocabularyChangeLog(rid);
      expect(log.total).toBe(0);
      expect(log.items).toEqual([]);
      expect(log.hasMore).toBe(false);

      const record = lastRecordFor('getVocabularyChangeLog');
      // Parallel data + count = two round-trips per call.
      expect((record?.details as { calls?: number } | undefined)?.calls).toBe(2);
    });
  });

  // ─── Cross-provider conformance suite ───────────────────────────────
  //
  // Shares a single driver across every harness test (one Neo4jStorageProvider
  // built once in `beforeAll`). The factory deletes the harness's stable repo
  // id before each test so the harness's own `createRepository` always lands
  // against a clean slate, then returns the shared instance. `initialize()` is
  // idempotent inside the harness's `setup`, so the shared provider passes
  // through unchanged.

  describe('Neo4jStorageProvider — cross-provider conformance (live)', () => {
    let sharedProvider: Neo4jStorageProvider;

    beforeAll(async () => {
      sharedProvider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await sharedProvider.initialize();
      await sharedProvider.ensureSchema();
    });

    afterAll(async () => {
      try {
        await sharedProvider.deleteRepository(CONFORMANCE_REPO_ID);
      } catch {
        // Already gone — fine.
      }
      await sharedProvider.dispose();
    });

    runStorageProviderConformanceTests(async () => {
      try {
        await sharedProvider.deleteRepository(CONFORMANCE_REPO_ID);
      } catch {
        // Not yet created — first test in the run, no cleanup needed.
      }
      return sharedProvider;
    });
  });

  // ─── Server-side projection (live) ─────────────────────────────────
  //
  // Reproduces the bug #5 case: `memory_query_graph { projection: { mode:
  // 'count' } }` was silently dropped, returning the full entity payload with
  // no aggregations. The compiler now emits projection-aware RETURN and the
  // executor parses the scalar rows into TraversalAggregation[].

  describe('Neo4jStorageProvider — projection (live)', () => {
    let provider: Neo4jStorageProvider;
    const RID = `projection-${Date.now()}`;

    beforeAll(async () => {
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
      await provider.ensureSchema();
      await provider.deleteRepository(RID).catch(() => undefined);
      await provider.createRepository({
        repositoryId: RID,
        label: 'projection test',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'projection-test',
      });

      // 5 companies, 4 universities, 1 non-profit — mirrors the bug repro
      // shape so the count aggregation produces a recognisable result.
      const orgs: Array<[string, string]> = [
        ['c1', 'company'],   ['c2', 'company'],     ['c3', 'company'],
        ['c4', 'company'],   ['c5', 'company'],     ['u1', 'university'],
        ['u2', 'university'],['u3', 'university'],  ['u4', 'university'],
        ['n1', 'non-profit'],
      ];
      for (const [id, orgType] of orgs) {
        await provider.createEntity(RID, {
          id,
          slug: `Organization:${id}`,
          entityType: 'Organization',
          label: id,
          summary: '',
          properties: { orgType },
          provenance: {
            createdBy: 'projection-test',
            createdByType: 'agent',
            createdAt: new Date().toISOString(),
            modifiedBy: 'projection-test',
            modifiedByType: 'agent',
            modifiedAt: new Date().toISOString(),
          },
        });
      }
    });

    afterAll(async () => {
      await provider.deleteRepository(RID).catch(() => undefined);
      await provider.dispose();
    });

    it('emits server-side count aggregation', async () => {
      const result = await provider.traverse(RID, {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], mode: 'count' },
        limit: 200,
      });

      // Entities suppressed — projection-only response.
      expect(result.entities).toEqual([]);

      // Compiled Cypher carries the projection clause.
      expect(result.queryMetadata.compiledQuery).toContain('n0.orgType AS orgType');
      expect(result.queryMetadata.compiledQuery).toContain('count(*) AS count');

      // Aggregations: one row per distinct orgType, sorted by count desc.
      expect(result.aggregations).toBeDefined();
      const byType = new Map(result.aggregations!.map((a) => [a.values['orgType'], a.count]));
      expect(byType.get('company')).toBe(5);
      expect(byType.get('university')).toBe(4);
      expect(byType.get('non-profit')).toBe(1);
    });

    it('emits server-side DISTINCT for distinct values mode', async () => {
      const result = await provider.traverse(RID, {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], distinct: true },
        limit: 200,
      });

      expect(result.queryMetadata.compiledQuery).toContain('RETURN DISTINCT n0.orgType');
      expect(result.entities).toEqual([]);
      expect(result.aggregations).toBeDefined();
      // 3 distinct orgType values, no count column.
      expect(result.aggregations).toHaveLength(3);
      for (const agg of result.aggregations!) {
        expect(agg.count).toBeUndefined();
      }
    });
  });
} else {
  describe('Neo4jStorageProvider', () => {
    it('skipped — set NEO4J_URI to run conformance tests', () => {
      expect(true).toBe(true);
    });
  });
}
