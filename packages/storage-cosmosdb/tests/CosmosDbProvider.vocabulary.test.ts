// Live tests for the CosmosDB provider's vocabulary compare-and-set, the
// repository-marker gate on entity / relationship creates, the version
// backfill run by ensureSchema, and delete / re-create recovery. They pin the
// Gremlin shapes those paths depend on against a real Cosmos Gremlin engine
// (nested `coalesce` with a mid-traversal `V()`, `has()` equality on a large
// string property, per-vertex atomicity of a filtered property write).
//
// Uses its own container so the ensureSchema backfill, which scans every
// `_vocabulary` vertex in the container, only ever touches this file's data.
//
// Requires a running CosmosDB emulator (or account) with Gremlin enabled.
// Set environment variables:
//   COSMOSDB_GREMLIN_ENDPOINT=ws://localhost:8901/
//   COSMOSDB_KEY=<emulator or account key>
//   COSMOSDB_REST_ENDPOINT=https://localhost:8081   (optional; derived from the Gremlin host otherwise)

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MemoryVocabulary, OperationUsage, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import {
  DuplicateEntityError,
  DuplicateRelationshipError,
  EntityNotFoundError,
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import { CosmosDbProvider } from '../src/CosmosDbProvider.js';
import { CosmosDbConnection } from '../src/CosmosDbConnection.js';
import { VOCABULARY_BACKFILL_WRITE_QUERY } from '../src/queries/vocabulary.js';
import { UPDATE_ENTITY_START } from '../src/queries/entity.js';
import { DELETE_INDEX_ENTRY_QUERY, DELETE_VERTEX_BATCH_QUERY } from '../src/queries/repository.js';

const ENDPOINT = process.env['COSMOSDB_GREMLIN_ENDPOINT'];
const KEY = process.env['COSMOSDB_KEY'];
const REST_ENDPOINT = process.env['COSMOSDB_REST_ENDPOINT'];

const DATABASE = 'deep-memory-test';
const CONTAINER = 'graph-vocabulary-test';

// Stable v4 UUIDs reserved for this file; each test starts by clearing its own.
const RID = {
  seed: '40000000-0000-4000-a000-0000000000c1',
  gate: '40000000-0000-4000-a000-0000000000c2',
  wipe: '40000000-0000-4000-a000-0000000000c3',
  cas: '40000000-0000-4000-a000-0000000000c4',
  race: '40000000-0000-4000-a000-0000000000c5',
  legacy: '40000000-0000-4000-a000-0000000000c6',
  stale: '40000000-0000-4000-a000-0000000000c7',
  large: '40000000-0000-4000-a000-0000000000c8',
  interrupted: '40000000-0000-4000-a000-0000000000c9',
  recreate: '40000000-0000-4000-a000-0000000000ca',
  markerless: '40000000-0000-4000-a000-0000000000cb',
  collision: '40000000-0000-4000-a000-0000000000cc',
} as const;

const skipIfNoEndpoint = !ENDPOINT || !KEY;

function makeVocabulary(version: string, entityTypeCount = 0): MemoryVocabulary {
  const now = '2026-05-27T01:00:00Z';
  return {
    version,
    lastModified: now,
    modifiedBy: 'vocabulary-test',
    entityTypes: Array.from({ length: entityTypeCount }, (_, i) => ({
      type: `Type${i}`,
      description: `Entity type ${i}: ${'a fairly long description of what this type represents. '.repeat(8)}`,
      version,
      properties: [
        { name: 'name', type: 'string' as const, required: true, description: 'The display name' },
        { name: 'note', type: 'string' as const, required: false, description: 'A free-form note' },
      ],
      createdAt: now,
      createdBy: 'vocabulary-test',
      modifiedAt: now,
      modifiedBy: 'vocabulary-test',
    })),
    relationshipTypes: [],
  };
}

function makeEntity(id: string): StoredEntity {
  const now = new Date().toISOString();
  return {
    id,
    slug: `Thing:${id}`,
    entityType: 'Thing',
    label: id,
    summary: '',
    properties: { colour: 'blue' },
    provenance: {
      createdBy: 'vocabulary-test',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 'vocabulary-test',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
  };
}

function makeRelationship(id: string, src: string, tgt: string): StoredRelationship {
  const now = new Date().toISOString();
  return {
    id,
    relationshipType: 'LINKS',
    sourceEntityId: src,
    targetEntityId: tgt,
    properties: {},
    bidirectional: false,
    provenance: {
      createdBy: 'vocabulary-test',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 'vocabulary-test',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
  };
}

(skipIfNoEndpoint ? describe.skip : describe)('CosmosDbProvider — vocabulary and repository gate (live)', () => {
  let provider: CosmosDbProvider;
  // Direct connection for fixtures and assertions the provider surface cannot
  // express (raw vertex counts, simulating vertices written by an earlier
  // release). Every query through it is partition-scoped to a test id.
  let raw: CosmosDbConnection;
  const usage: OperationUsage[] = [];

  function callsOfLast(operation: string): number | undefined {
    for (let i = usage.length - 1; i >= 0; i--) {
      const record = usage[i]!;
      if (record.operation === operation) {
        return (record.details as { calls?: number } | undefined)?.calls;
      }
    }
    return undefined;
  }

  async function clear(rid: string): Promise<void> {
    try {
      await provider.deleteRepository(rid);
    } catch (err) {
      if (!(err instanceof RepositoryNotFoundError)) throw err;
    }
  }

  async function freshRepository(rid: string, vocabulary?: MemoryVocabulary): Promise<void> {
    await clear(rid);
    await provider.createRepository({
      repositoryId: rid,
      label: `vocabulary-test ${rid.slice(-2)}`,
      governanceConfig: { mode: 'open' },
      ...(vocabulary ? { vocabulary } : {}),
      createdAt: new Date().toISOString(),
      createdBy: 'vocabulary-test',
    });
  }

  async function count(query: string, rid: string): Promise<number> {
    const result = await raw.submit(query, { rid });
    return Number(result.items[0] ?? 0);
  }

  async function storedVersionProperty(rid: string): Promise<unknown[]> {
    const result = await raw.submit(
      "g.V().has('repositoryId', rid).hasLabel('_vocabulary').values('version')",
      { rid },
    );
    return result.items;
  }

  beforeAll(async () => {
    provider = new CosmosDbProvider({
      endpoint: ENDPOINT!,
      key: KEY!,
      database: DATABASE,
      container: CONTAINER,
      ...(REST_ENDPOINT ? { restEndpoint: REST_ENDPOINT } : {}),
      rejectUnauthorized: false,
      reportUsage: (record) => {
        usage.push(record);
      },
    });
    await provider.initialize();
    await provider.ensureSchema();
    raw = new CosmosDbConnection({
      endpoint: ENDPOINT!,
      key: KEY!,
      database: DATABASE,
      container: CONTAINER,
      rejectUnauthorized: false,
    });
    await raw.connect();
  }, 120_000);

  afterAll(async () => {
    for (const rid of Object.values(RID)) {
      await clear(rid);
    }
    await raw.close();
    await provider.dispose();
  }, 120_000);

  it('createRepository seeds exactly one vocabulary vertex carrying the version property', async () => {
    await freshRepository(RID.seed, makeVocabulary('3.1.0'));

    expect(await storedVersionProperty(RID.seed)).toEqual(['3.1.0']);
    expect((await provider.getVocabulary(RID.seed, { fresh: true })).version).toBe('3.1.0');
  });

  it('createEntity and createRelationship write through the repository gate', async () => {
    await freshRepository(RID.gate);

    await provider.createEntity(RID.gate, makeEntity('gate-a'));
    // The gated create stays a single round-trip.
    expect(callsOfLast('createEntity')).toBe(1);
    await provider.createEntity(RID.gate, makeEntity('gate-b'));
    expect((await provider.getEntity(RID.gate, 'gate-a'))?.label).toBe('gate-a');
    await expect(provider.createEntity(RID.gate, makeEntity('gate-a'))).rejects.toBeInstanceOf(
      DuplicateEntityError,
    );

    await provider.createRelationship(RID.gate, makeRelationship('gate-r1', 'gate-a', 'gate-b'));
    expect(callsOfLast('createRelationship')).toBe(1);
    expect((await provider.getRelationship(RID.gate, 'gate-r1'))?.sourceEntityId).toBe('gate-a');
    await expect(
      provider.createRelationship(RID.gate, makeRelationship('gate-r1', 'gate-a', 'gate-b')),
    ).rejects.toBeInstanceOf(DuplicateRelationshipError);

    // A missing endpoint is reported as that entity, not as a missing repository, and writes nothing.
    const missingEndpoint = provider.createRelationship(
      RID.gate,
      makeRelationship('gate-r2', 'gate-a', 'gate-missing'),
    );
    await expect(missingEndpoint).rejects.toBeInstanceOf(EntityNotFoundError);
    await expect(missingEndpoint).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', id: 'gate-missing' });
    expect(await provider.getRelationship(RID.gate, 'gate-r2')).toBeNull();
  });

  it('after deleteRepository every write is refused and nothing scoped to the repository remains', async () => {
    await freshRepository(RID.wipe);
    await provider.createEntity(RID.wipe, makeEntity('wipe-a'));
    await provider.createEntity(RID.wipe, makeEntity('wipe-b'));
    await provider.createRelationship(RID.wipe, makeRelationship('wipe-r1', 'wipe-a', 'wipe-b'));
    const vocab = await provider.getVocabulary(RID.wipe, { fresh: true });

    await provider.deleteRepository(RID.wipe);

    await expect(provider.createEntity(RID.wipe, makeEntity('wipe-c'))).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(
      provider.createRelationship(RID.wipe, makeRelationship('wipe-r2', 'wipe-a', 'wipe-b')),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(
      provider.saveVocabulary(RID.wipe, { ...vocab, version: '9.0.0' }, vocab.version),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);

    expect(await count("g.V().has('repositoryId', rid).count()", RID.wipe)).toBe(0);
    expect(await count("g.E().has('repositoryId', rid).count()", RID.wipe)).toBe(0);
    await expect(provider.deleteRepository(RID.wipe)).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('saveVocabulary is compare-and-set: one round-trip on success, a typed conflict on a stale version', async () => {
    await freshRepository(RID.cas, makeVocabulary('1.0.0'));

    await provider.saveVocabulary(RID.cas, makeVocabulary('1.1.0'), '1.0.0');
    expect(callsOfLast('saveVocabulary')).toBe(1);
    expect(await storedVersionProperty(RID.cas)).toEqual(['1.1.0']);

    const stale = provider.saveVocabulary(RID.cas, makeVocabulary('1.2.0'), '1.0.0');
    await expect(stale).rejects.toBeInstanceOf(VocabularyVersionConflictError);
    await expect(stale).rejects.toMatchObject({
      repositoryId: RID.cas,
      expectedVersion: '1.0.0',
      actualVersion: '1.1.0',
    });
    expect(callsOfLast('saveVocabulary')).toBe(2);
    expect((await provider.getVocabulary(RID.cas, { fresh: true })).version).toBe('1.1.0');
  });

  it('of concurrent saves against the same version, exactly one lands', async () => {
    await freshRepository(RID.race, makeVocabulary('1.0.0'));
    const contenders = Array.from({ length: 20 }, (_, i) => makeVocabulary(`1.${i + 1}.0`));

    const outcomes = await Promise.allSettled(
      contenders.map((v) => provider.saveVocabulary(RID.race, v, '1.0.0')),
    );

    const winners = outcomes
      .map((o, i) => ({ o, version: contenders[i]!.version }))
      .filter((x) => x.o.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        expect(o.reason).toBeInstanceOf(VocabularyVersionConflictError);
      }
    }
    const stored = await provider.getVocabulary(RID.race, { fresh: true });
    expect(stored.version).toBe(winners[0]!.version);
    expect(await storedVersionProperty(RID.race)).toEqual([winners[0]!.version]);
  }, 60_000);

  it('a legacy vocabulary vertex without a version property is refused, then repaired by ensureSchema', async () => {
    await freshRepository(RID.legacy, makeVocabulary('0.3.0'));
    // Reproduce a vertex written by an earlier release: the version lives only
    // inside the JSON blob.
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').sideEffect(properties('version').drop())",
      { rid: RID.legacy, vid: `vocab:${RID.legacy}` },
    );
    expect(await storedVersionProperty(RID.legacy)).toEqual([]);

    const refused = provider.saveVocabulary(RID.legacy, makeVocabulary('0.4.0'), '0.3.0');
    await expect(refused).rejects.toBeInstanceOf(ProviderError);
    await expect(refused).rejects.toThrow(/run ensureSchema\(\)/);

    await provider.ensureSchema();
    expect(await storedVersionProperty(RID.legacy)).toEqual(['0.3.0']);

    const current = await provider.getVocabulary(RID.legacy, { fresh: true });
    await provider.saveVocabulary(RID.legacy, { ...current, version: '0.4.0' }, current.version);
    expect((await provider.getVocabulary(RID.legacy, { fresh: true })).version).toBe('0.4.0');

    // Idempotent: a second pass leaves the now-current property alone.
    await provider.ensureSchema();
    expect(await storedVersionProperty(RID.legacy)).toEqual(['0.4.0']);
  }, 60_000);

  it('a version property out of step with the blob is refused, then repaired by ensureSchema', async () => {
    await freshRepository(RID.stale, makeVocabulary('0.3.0'));
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').property('version', v)",
      { rid: RID.stale, vid: `vocab:${RID.stale}`, v: '0.0.1' },
    );

    await expect(
      provider.saveVocabulary(RID.stale, makeVocabulary('0.4.0'), '0.3.0'),
    ).rejects.toBeInstanceOf(ProviderError);

    await provider.ensureSchema();
    expect(await storedVersionProperty(RID.stale)).toEqual(['0.3.0']);
    await provider.saveVocabulary(RID.stale, makeVocabulary('0.4.0'), '0.3.0');
  }, 60_000);

  it('the backfill guard matches a large blob exactly and misses any other blob', async () => {
    // As large as a Gremlin submit can carry: the emulator closes the socket
    // on a request of about 128 KB, and the blob travels JSON-escaped inside
    // the request (a vocabulary write of that size fails the same way through
    // saveVocabulary). ~83 KB of blob is well past any index-term length, so
    // the guard can only match by comparing the stored string itself.
    const large = makeVocabulary('5.0.0', 100);
    const largeJson = JSON.stringify(large);
    expect(largeJson.length).toBeGreaterThan(80_000);
    await freshRepository(RID.large, large);
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_vocabulary').sideEffect(properties('version').drop())",
      { rid: RID.large, vid: `vocab:${RID.large}` },
    );

    // A blob that differs by one character does not match the guard.
    const missed = await raw.submit(VOCABULARY_BACKFILL_WRITE_QUERY, {
      rid: RID.large,
      vid: `vocab:${RID.large}`,
      vocabJson: `${largeJson} `,
      vocabVersion: '5.0.0',
    });
    expect(Number(missed.items[0] ?? 0)).toBe(0);
    expect(await storedVersionProperty(RID.large)).toEqual([]);

    // The exact stored blob does, via the ensureSchema pass.
    await provider.ensureSchema();
    expect(await storedVersionProperty(RID.large)).toEqual(['5.0.0']);
  }, 60_000);

  it('an interrupted delete blocks re-create until deleteRepository finishes it', async () => {
    await freshRepository(RID.interrupted, makeVocabulary('2.0.0'));
    await provider.createEntity(RID.interrupted, makeEntity('int-a'));
    // Simulate a delete that stopped right after dropping the marker.
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').drop()",
      { rid: RID.interrupted, vid: `repo:${RID.interrupted}` },
    );

    const refused = provider.createRepository({
      repositoryId: RID.interrupted,
      label: 'recreated',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'vocabulary-test',
    });
    await expect(refused).rejects.toBeInstanceOf(ProviderError);
    await expect(refused).rejects.toThrow(/call deleteRepository/);

    await provider.deleteRepository(RID.interrupted);
    expect(await count("g.V().has('repositoryId', rid).count()", RID.interrupted)).toBe(0);
    expect((await provider.listRepositories({ limit: 1000 })).items.map((r) => r.repositoryId)).not.toContain(
      RID.interrupted,
    );

    await provider.createRepository({
      repositoryId: RID.interrupted,
      label: 'recreated',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'vocabulary-test',
    });
    expect(await count("g.V().has('repositoryId', rid).hasLabel('_vocabulary').count()", RID.interrupted)).toBe(1);
    expect(await count("g.V().has('repositoryId', rid).has('entityType').count()", RID.interrupted)).toBe(0);
  }, 60_000);

  it('a repository whose marker is gone refuses writes and reads, and deleteRepository still finishes it', async () => {
    await freshRepository(RID.markerless, makeVocabulary('2.0.0'));
    await provider.createEntity(RID.markerless, makeEntity('ml-a'));
    await provider.createEntity(RID.markerless, makeEntity('ml-b'));
    await provider.createRelationship(RID.markerless, makeRelationship('ml-r', 'ml-a', 'ml-b'));
    // Simulate a delete that stopped right after dropping the marker.
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').drop()",
      { rid: RID.markerless, vid: `repo:${RID.markerless}` },
    );
    const provenance = makeEntity('ml-a').provenance;

    await expect(provider.getVocabulary(RID.markerless)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.getVocabulary(RID.markerless, { fresh: true })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(provider.getRepositoryStats(RID.markerless)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteEntities(RID.markerless, ['ml-a', 'missing'])).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(provider.deleteRelationships(RID.markerless, ['ml-r'])).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(provider.deleteEntity(RID.markerless, 'ml-b')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteRelationship(RID.markerless, 'ml-r')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteEntities(RID.markerless, [])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteRelationships(RID.markerless, [])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.updateEntity(RID.markerless, 'ml-a', { label: 'Renamed', provenance })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(
      provider.updateEntity(RID.markerless, 'ml-a', { properties: { colour: 'red' }, provenance }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    // Ahead of the slug clash with ml-b.
    await expect(
      provider.updateEntity(RID.markerless, 'ml-a', { slug: 'Thing:ml-b', provenance }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);

    // Nothing was written or dropped.
    const a = await provider.getEntity(RID.markerless, 'ml-a');
    expect(a?.label).toBe('ml-a');
    expect(a?.properties).toEqual({ colour: 'blue' });
    expect(a?.slug).toBe(makeEntity('ml-a').slug);
    expect(await provider.getEntity(RID.markerless, 'ml-b')).not.toBeNull();
    expect(await provider.getRelationship(RID.markerless, 'ml-r')).not.toBeNull();

    await expect(provider.deleteRepository(RID.markerless)).resolves.toEqual({
      deletedEntities: 2,
      deletedRelationships: 1,
    });
    await expect(provider.deleteRepository(RID.markerless)).rejects.toBeInstanceOf(RepositoryNotFoundError);
  }, 60_000);

  // The entity type is the vertex label, so an entity typed `_repository`
  // carries the marker's label. The marker guards tell the two apart by
  // `entityType`, which only entity vertices carry. Written at the provider
  // level, below any vocabulary validation.
  it('an entity typed _repository is never taken for the repository marker', async () => {
    await freshRepository(RID.collision);
    const impostor = (id: string): StoredEntity => ({ ...makeEntity(id), entityType: '_repository', slug: `_repository:${id}` });
    await provider.createEntity(RID.collision, impostor('col-x'));
    await provider.createEntity(RID.collision, impostor('col-z'));
    await provider.createEntity(RID.collision, makeEntity('col-y'));
    const provenance = makeEntity('col-x').provenance;

    // Marker present: the write runs once and the drop reports the id once.
    await expect(provider.updateEntity(RID.collision, 'col-x', { label: 'Renamed', provenance })).resolves.toMatchObject({
      id: 'col-x',
      label: 'Renamed',
    });
    const rows = await raw.submit(`${UPDATE_ENTITY_START}.property('entityLabel', p0).id()`, {
      rid: RID.collision,
      repoVid: `repo:${RID.collision}`,
      eid: 'col-x',
      p0: 'Renamed',
    });
    expect(rows.items).toEqual(['col-x']);
    await expect(provider.deleteEntities(RID.collision, ['col-z'])).resolves.toEqual({
      deleted: ['col-z'],
      notFound: [],
    });
    expect(await provider.getEntity(RID.collision, 'col-z')).toBeNull();

    // Marker absent: the impostor does not stand in for it.
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').hasNot('entityType').drop()",
      { rid: RID.collision, vid: `repo:${RID.collision}` },
    );
    await expect(provider.deleteEntities(RID.collision, ['col-x'])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.deleteEntity(RID.collision, 'col-x')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.updateEntity(RID.collision, 'col-x', { label: 'Overwritten', provenance })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    await expect(provider.getVocabulary(RID.collision, { fresh: true })).rejects.toBeInstanceOf(RepositoryNotFoundError);
    const survivor = await provider.getEntity(RID.collision, 'col-x');
    expect(survivor?.label).toBe('Renamed');
    expect(survivor?.entityType).toBe('_repository');

    await expect(provider.deleteRepository(RID.collision)).resolves.toEqual({
      deletedEntities: 2,
      deletedRelationships: 0,
    });
  }, 60_000);

  it('the delete drain and sentinel cleanup stand down while a marker exists', async () => {
    await freshRepository(RID.recreate);
    await provider.createEntity(RID.recreate, makeEntity('rec-a'));
    const before = await count("g.V().has('repositoryId', rid).count()", RID.recreate);

    const batch = await raw.submit(DELETE_VERTEX_BATCH_QUERY, {
      rid: RID.recreate,
      vid: `repo:${RID.recreate}`,
      batchSize: 500,
    });
    expect(batch.items).toEqual(['__recreated']);
    expect(await count("g.V().has('repositoryId', rid).count()", RID.recreate)).toBe(before);

    const cleanup = await raw.submit(DELETE_INDEX_ENTRY_QUERY, {
      rid: RID.recreate,
      vid: `repo:${RID.recreate}`,
      pk: '_index',
      sid: '_repository_index',
      updatedIndex: JSON.stringify([]),
    });
    expect(cleanup.items).toEqual(['__recreated']);
    expect((await provider.listRepositories({ limit: 1000 })).items.map((r) => r.repositoryId)).toContain(
      RID.recreate,
    );
  }, 60_000);
});
