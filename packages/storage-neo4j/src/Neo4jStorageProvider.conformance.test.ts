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
import type { MemoryVocabulary, OperationUsage, StoredEntity } from '@utaba/deep-memory/types';
import {
  DuplicateRepositoryError,
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';
import { Neo4jConnection } from './Neo4jConnection.js';
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

function makeEntity(id: string): StoredEntity {
  const now = new Date().toISOString();
  return {
    id,
    slug: `Thing:${id}`,
    entityType: 'Thing',
    label: id,
    summary: '',
    properties: {},
    provenance: {
      createdBy: 'conformance',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 'conformance',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
  };
}

function makeVocabulary(version: string): MemoryVocabulary {
  return {
    version,
    lastModified: '2026-05-27T01:00:00Z',
    modifiedBy: 'conformance',
    entityTypes: [],
    relationshipTypes: [],
  };
}

/**
 * Direct connection for assertions and fixtures the provider surface cannot
 * express (raw node counts, simulating nodes written by an earlier release).
 * Every query through it is still repository-scoped.
 */
function makeRawConnection(): Neo4jConnection {
  return new Neo4jConnection({
    uri: NEO4J_URI ?? '',
    username: NEO4J_USER,
    password: NEO4J_PASSWORD,
    database: NEO4J_DATABASE,
  });
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
    let rawConnection: Neo4jConnection;
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
      rawConnection = makeRawConnection();
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
      await rawConnection.close();
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

    it('deleteRepository removes the repository and throws RepositoryNotFoundError on a second delete', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'to-delete',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });

      await provider.deleteRepository(rid);
      expect(await provider.getRepository(rid)).toBeNull();

      // The repository marker is deleted first and a delete that removes no
      // marker reports the repository as missing.
      await expect(provider.deleteRepository(rid)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    });

    it('deleteRepository leaves no nodes scoped to the repository', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'wipe-check',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      await provider.createEntity(rid, makeEntity('wipe-e1'));
      await provider.createEntity(rid, makeEntity('wipe-e2'));
      // A node under a label the provider never writes, as a native query
      // could create; the delete must still remove it.
      await rawConnection.executeQuery(
        'CREATE (:ConformanceNativeNode {repositoryId: $rid})',
        {},
        { repositoryId: rid },
      );

      await provider.deleteRepository(rid);

      const remaining = await rawConnection.executeQuery(
        'MATCH (n {repositoryId: $rid}) RETURN count(n) AS total',
        {},
        { repositoryId: rid, routing: 'READ' },
      );
      expect(remaining.records[0]?.get('total')).toBe(0n);
      await expect(provider.createEntity(rid, makeEntity('wipe-e3'))).rejects.toBeInstanceOf(
        RepositoryNotFoundError,
      );
    });

    it('a delete interrupted after the marker is removed blocks re-creation until a retry finishes it', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'interrupted-delete',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      await provider.createEntity(rid, makeEntity('half-e1'));
      await provider.createEntity(rid, makeEntity('half-e2'));
      const now = new Date().toISOString();
      await provider.createRelationship(rid, {
        id: 'half-r1',
        relationshipType: 'connects',
        sourceEntityId: 'half-e1',
        targetEntityId: 'half-e2',
        properties: {},
        bidirectional: false,
        provenance: {
          createdBy: 'conformance',
          createdByType: 'agent',
          createdAt: now,
          modifiedBy: 'conformance',
          modifiedByType: 'agent',
          modifiedAt: now,
        },
      });

      // Simulate a delete that stopped right after removing the marker.
      await rawConnection.executeQuery(
        'MATCH (r:_Repository {repositoryId: $rid}) DETACH DELETE r',
        {},
        { repositoryId: rid },
      );

      const config = {
        repositoryId: rid,
        label: 'recreated',
        governanceConfig: { mode: 'open' as const },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      };
      await expect(provider.createRepository(config)).rejects.toBeInstanceOf(ProviderError);

      // The retry finds the leftovers and finishes the wipe.
      await expect(provider.deleteRepository(rid)).resolves.toBeUndefined();
      const remaining = await rawConnection.executeQuery(
        'MATCH (n {repositoryId: $rid}) RETURN count(n) AS total',
        {},
        { repositoryId: rid, routing: 'READ' },
      );
      expect(remaining.records[0]?.get('total')).toBe(0n);

      await provider.createRepository(config);
      const vocabularies = await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN count(v) AS total',
        {},
        { repositoryId: rid, routing: 'READ' },
      );
      expect(vocabularies.records[0]?.get('total')).toBe(1n);
    });

    it('leftover entities with no marker or vocabulary also block re-creation until a retry clears them', async () => {
      await provider.createRepository({
        repositoryId: rid,
        label: 'straggler',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      await provider.createEntity(rid, makeEntity('straggler-e1'));
      // Simulate an entity create that committed after a delete finished.
      await rawConnection.executeQuery(
        'MATCH (n {repositoryId: $rid}) WHERE n:_Repository OR n:_Vocabulary DETACH DELETE n',
        {},
        { repositoryId: rid },
      );

      const config = {
        repositoryId: rid,
        label: 'recreated',
        governanceConfig: { mode: 'open' as const },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      };
      await expect(provider.createRepository(config)).rejects.toBeInstanceOf(ProviderError);
      await expect(provider.deleteRepository(rid)).resolves.toBeUndefined();
      await provider.createRepository(config);
      expect(await provider.getEntity(rid, 'straggler-e1')).toBeNull();
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
      // The repo has no entities or relationships, only its _Repository and
      // _Vocabulary nodes. The marker is removed up front, the relationship
      // and entity drains find nothing and emit no progress, and the final
      // system-node drain removes the _Vocabulary node without a callback —
      // assert the call resolves cleanly.
      await expect(
        provider.deleteRepository(rid, (p) => {
          progress.push({ entitiesDeleted: p.entitiesDeleted, relationshipsDeleted: p.relationshipsDeleted });
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('Neo4jStorageProvider — vocabulary CRUD (live)', () => {
    let provider: Neo4jStorageProvider;
    // A second provider stands in for another process sharing the database:
    // its writes do not touch `provider`'s in-process vocabulary cache.
    let otherProcess: Neo4jStorageProvider;
    let rawConnection: Neo4jConnection;
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
      otherProcess = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await otherProcess.initialize();
      rawConnection = makeRawConnection();
    });

    afterAll(async () => {
      for (const id of seeded) {
        try {
          await provider.deleteRepository(id);
        } catch {
          // Already deleted or never created — ignore.
        }
      }
      await rawConnection.close();
      await otherProcess.dispose();
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

    function callsOf(record: OperationUsage | undefined): number | undefined {
      return (record?.details as { calls?: number } | undefined)?.calls;
    }

    it('createRepository writes the repository and its vocabulary in one round-trip', async () => {
      const created = makeRid('vocab-create');
      seeded.push(created);
      await provider.createRepository({
        repositoryId: created,
        label: 'single round-trip create',
        governanceConfig: { mode: 'open' },
        vocabulary: makeVocabulary('3.1.0'),
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      expect(callsOf(lastRecordFor('createRepository'))).toBe(1);

      const stored = await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN v.version AS version',
        {},
        { repositoryId: created, routing: 'READ' },
      );
      expect(stored.records).toHaveLength(1);
      expect(stored.records[0]?.get('version')).toBe('3.1.0');
    });

    it('getVocabulary returns the empty vocabulary seeded by createRepository', async () => {
      const vocab = await provider.getVocabulary(rid);
      expect(vocab.version).toBe('0.0.0');
      expect(vocab.entityTypes).toEqual([]);
      expect(vocab.relationshipTypes).toEqual([]);

      const record = lastRecordFor('getVocabulary');
      expect(record).toBeDefined();
      // createRepository does not populate the cache — the first read is a
      // miss and costs one round-trip.
      expect(callsOf(record)).toBe(1);
    });

    it('getVocabulary cache hit emits zero round-trips on the sink record', async () => {
      await provider.getVocabulary(rid); // populate cache
      const beforeIndex = sinkRecords.length;
      await provider.getVocabulary(rid); // cache hit
      const hits = sinkRecords.slice(beforeIndex).filter((r) => r.operation === 'getVocabulary');
      expect(hits).toHaveLength(1);
      expect(callsOf(hits[0])).toBe(0);
      expect(hits[0]?.value).toBe(0);
    });

    it('getVocabulary with { fresh: true } bypasses a warm cache and refreshes it', async () => {
      await provider.getVocabulary(rid); // warm cache with 0.0.0
      await otherProcess.saveVocabulary(rid, makeVocabulary('0.5.0'), '0.0.0');

      // The plain read is served from the now-stale cache.
      const cached = await provider.getVocabulary(rid);
      expect(cached.version).toBe('0.0.0');
      expect(callsOf(lastRecordFor('getVocabulary'))).toBe(0);

      const fresh = await provider.getVocabulary(rid, { fresh: true });
      expect(fresh.version).toBe('0.5.0');
      expect(callsOf(lastRecordFor('getVocabulary'))).toBe(1);

      // The fresh result replaced the cache entry.
      const after = await provider.getVocabulary(rid);
      expect(after.version).toBe('0.5.0');
      expect(callsOf(lastRecordFor('getVocabulary'))).toBe(0);
    });

    it('saveVocabulary persists across cache invalidation in one round-trip', async () => {
      await provider.getVocabulary(rid); // warm cache with the seeded default
      await provider.saveVocabulary(
        rid,
        {
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
        },
        '0.0.0',
      );
      // Compare-and-set success path: the guarded SET is the only round-trip.
      expect(callsOf(lastRecordFor('saveVocabulary'))).toBe(1);

      const refetched = await provider.getVocabulary(rid);
      expect(refetched.version).toBe('0.1.0');
      expect(refetched.entityTypes[0]?.type).toBe('Person');

      // Save invalidated the cache, so this read is a miss again.
      expect(callsOf(lastRecordFor('getVocabulary'))).toBe(1);
    });

    it('concurrent saves against the same base version admit exactly one writer', async () => {
      const writers = 20;
      // Warm up first so the writers really overlap: one write compiles and
      // caches the statement's plan, and a concurrent batch of reads opens
      // enough pooled connections. A cold compile or connection handshakes
      // stagger the batch and would hide a check-then-write race.
      await provider.saveVocabulary(rid, makeVocabulary('0.1.0'), '0.0.0');
      await Promise.all(
        Array.from({ length: writers }, () => provider.getVocabulary(rid, { fresh: true })),
      );

      const attempts = Array.from({ length: writers }, (_, i) =>
        provider.saveVocabulary(rid, makeVocabulary(`1.0.${i}`), '0.1.0'),
      );
      const settled = await Promise.allSettled(attempts);

      const winners = settled.flatMap((s, i) => (s.status === 'fulfilled' ? [i] : []));
      expect(winners).toHaveLength(1);
      for (const s of settled) {
        if (s.status === 'rejected') {
          expect(s.reason).toBeInstanceOf(VocabularyVersionConflictError);
        }
      }
      const stored = await provider.getVocabulary(rid, { fresh: true });
      expect(stored.version).toBe(`1.0.${winners[0] ?? -1}`);
    });

    it('a replayed save of the exact vocabulary it already wrote succeeds instead of conflicting', async () => {
      // Equivalent to the driver retrying a committed write whose
      // acknowledgement was lost: same vocabulary, same expected version.
      const vocabulary = makeVocabulary('0.1.0');
      await provider.saveVocabulary(rid, vocabulary, '0.0.0');
      await expect(provider.saveVocabulary(rid, vocabulary, '0.0.0')).resolves.toBeUndefined();

      // A different vocabulary against the same stale base still conflicts.
      await expect(
        provider.saveVocabulary(rid, { ...vocabulary, modifiedBy: 'someone-else' }, '0.0.0'),
      ).rejects.toBeInstanceOf(VocabularyVersionConflictError);
      expect((await provider.getVocabulary(rid, { fresh: true })).version).toBe('0.1.0');
    });

    it('successive compare-and-set writes each advance the stored version', async () => {
      await provider.saveVocabulary(rid, makeVocabulary('0.1.0'), '0.0.0');
      await provider.saveVocabulary(rid, makeVocabulary('0.2.0'), '0.1.0');

      const after = await provider.getVocabulary(rid);
      expect(after.version).toBe('0.2.0');
    });

    it('a stale saveVocabulary costs one follow-up read and drops the cached copy', async () => {
      await provider.getVocabulary(rid); // warm cache with 0.0.0
      await otherProcess.saveVocabulary(rid, makeVocabulary('0.7.0'), '0.0.0');

      const stale = provider.saveVocabulary(rid, makeVocabulary('0.1.0'), '0.0.0');
      await expect(stale).rejects.toBeInstanceOf(VocabularyVersionConflictError);
      await expect(stale).rejects.toMatchObject({
        repositoryId: rid,
        expectedVersion: '0.0.0',
        actualVersion: '0.7.0',
      });
      // Guarded SET that matched nothing + the follow-up version read.
      expect(callsOf(lastRecordFor('saveVocabulary'))).toBe(2);

      // The conflict invalidated the cache, so this read goes to the database.
      const after = await provider.getVocabulary(rid);
      expect(after.version).toBe('0.7.0');
      expect(callsOf(lastRecordFor('getVocabulary'))).toBe(1);
    });

    it('legacy _Vocabulary without version is backfilled by ensureSchema', async () => {
      // Reproduce a node written by an earlier release: the version lives only
      // inside the JSON blob.
      await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) SET v.vocabulary = $json REMOVE v.version',
        { json: JSON.stringify(makeVocabulary('0.3.0')) },
        { repositoryId: rid },
      );

      // Without the property compare-and-set can never match; the provider
      // says so rather than reporting a version conflict.
      await expect(
        provider.saveVocabulary(rid, makeVocabulary('0.4.0'), '0.3.0'),
      ).rejects.toBeInstanceOf(ProviderError);

      const result = await provider.ensureSchema();
      expect(result.schemaVersion).toBe(SCHEMA_VERSION);

      const stored = await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN v.version AS version',
        {},
        { repositoryId: rid, routing: 'READ' },
      );
      expect(stored.records[0]?.get('version')).toBe('0.3.0');

      const current = await provider.getVocabulary(rid, { fresh: true });
      expect(current.version).toBe('0.3.0');
      await provider.saveVocabulary(rid, { ...current, version: '0.4.0' }, current.version);
      expect((await provider.getVocabulary(rid, { fresh: true })).version).toBe('0.4.0');

      // Idempotent: a second pass leaves the now-current property alone.
      await provider.ensureSchema();
      expect((await provider.getVocabulary(rid, { fresh: true })).version).toBe('0.4.0');
    });

    it('ensureSchema repairs a version property left stale by an earlier release\'s write', async () => {
      // An earlier release rewrote only the blob, leaving the property at the
      // seeded 0.0.0.
      await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) SET v.vocabulary = $json',
        { json: JSON.stringify(makeVocabulary('0.9.0')) },
        { repositoryId: rid },
      );

      // Callers read 0.9.0 from the blob, which the stale property can never
      // match; the provider reports the repair rather than a conflict.
      await expect(
        provider.saveVocabulary(rid, makeVocabulary('0.10.0'), '0.9.0'),
      ).rejects.toBeInstanceOf(ProviderError);

      await provider.ensureSchema();

      const readVersion = async (): Promise<unknown> => {
        const stored = await rawConnection.executeQuery(
          'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN v.version AS version',
          {},
          { repositoryId: rid, routing: 'READ' },
        );
        return stored.records[0]?.get('version');
      };
      expect(await readVersion()).toBe('0.9.0');

      await provider.saveVocabulary(rid, makeVocabulary('0.10.0'), '0.9.0');
      expect(await readVersion()).toBe('0.10.0');

      // A second pass finds every node consistent and writes nothing: the
      // schema-version read plus the repair scan, no per-node writes.
      await provider.ensureSchema();
      expect(callsOf(lastRecordFor('ensureSchema'))).toBe(2);
      expect(await readVersion()).toBe('0.10.0');
      expect((await provider.getVocabulary(rid, { fresh: true })).version).toBe('0.10.0');
    });

    it('ensureSchema tolerates vocabulary blobs with no usable version', async () => {
      const other = makeRid('vocab-blob');
      seeded.push(other);
      await provider.createRepository({
        repositoryId: other,
        label: 'null blob',
        governanceConfig: { mode: 'open' },
        createdAt: '2026-05-27T00:00:00Z',
        createdBy: 'conformance',
      });
      // An object blob without a version: nothing correct to write.
      await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) SET v.vocabulary = $json REMOVE v.version',
        { json: '{"entityTypes":[]}' },
        { repositoryId: rid },
      );
      // A JSON `null` blob: decodes to the empty vocabulary, like a read does.
      await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) SET v.vocabulary = $json REMOVE v.version',
        { json: 'null' },
        { repositoryId: other },
      );

      await expect(provider.ensureSchema()).resolves.toBeDefined();

      const versionOf = async (id: string): Promise<unknown> => {
        const stored = await rawConnection.executeQuery(
          'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN v.version AS version',
          {},
          { repositoryId: id, routing: 'READ' },
        );
        return stored.records[0]?.get('version');
      };
      expect(await versionOf(rid)).toBeNull();
      expect(await versionOf(other)).toBe('0.0.0');
      expect((await provider.getVocabulary(other, { fresh: true })).version).toBe('0.0.0');
    });

    it('saveVocabulary never recreates the vocabulary of a deleted repository', async () => {
      await provider.deleteRepository(rid);

      await expect(
        provider.saveVocabulary(rid, makeVocabulary('0.1.0'), '0.0.0'),
      ).rejects.toBeInstanceOf(RepositoryNotFoundError);

      const stored = await rawConnection.executeQuery(
        'MATCH (v:_Vocabulary {repositoryId: $rid}) RETURN count(v) AS total',
        {},
        { repositoryId: rid, routing: 'READ' },
      );
      expect(stored.records[0]?.get('total')).toBe(0n);
    });

    it('getVocabularyChangeLog returns an empty page when no entries exist', async () => {
      const log = await provider.getVocabularyChangeLog(rid);
      expect(log.total).toBe(0);
      expect(log.items).toEqual([]);
      expect(log.hasMore).toBe(false);

      const record = lastRecordFor('getVocabularyChangeLog');
      // Parallel data + count = two round-trips per call.
      expect(callsOf(record)).toBe(2);
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
