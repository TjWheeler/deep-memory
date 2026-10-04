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
import type {
  MemoryVocabulary,
  OperationUsage,
  StoredEntity,
  StoredRelationship,
  VocabularyChangeRecord,
} from '@utaba/deep-memory/types';
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
  survivors: '40000000-0000-4000-a000-0000000000cd',
  typeDelete: '40000000-0000-4000-a000-0000000000ce',
  bigTypeDelete: '40000000-0000-4000-a000-0000000000cf',
  changeLog: '40000000-0000-4000-a000-0000000000d0',
  partialRecord: '40000000-0000-4000-a000-0000000000d1',
  importIds: '40000000-0000-4000-a000-0000000000d2',
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

  async function newProvider(): Promise<CosmosDbProvider> {
    const created = new CosmosDbProvider({
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
    await created.initialize();
    return created;
  }

  async function dropMarker(rid: string): Promise<void> {
    await raw.submit(
      "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').hasNot('entityType').drop()",
      { rid, vid: `repo:${rid}` },
    );
  }

  beforeAll(async () => {
    provider = await newProvider();
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

    // Nothing was written or dropped. The reads go round the provider, which
    // refuses them too.
    const a = await raw.submit(
      "g.V().has('repositoryId', rid).hasId(eid).project('label', 'properties', 'slug')" +
        ".by(values('entityLabel')).by(values('properties')).by(values('slug'))",
      { rid: RID.markerless, eid: 'ml-a' },
    );
    expect(a.items).toEqual([
      { label: 'ml-a', properties: JSON.stringify({ colour: 'blue' }), slug: makeEntity('ml-a').slug },
    ]);
    expect(await count("g.V().has('repositoryId', rid).has('entityType').count()", RID.markerless)).toBe(2);
    expect(await count("g.E().has('repositoryId', rid).count()", RID.markerless)).toBe(1);

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
    await expect(provider.getEntity(RID.collision, 'col-x')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    const survivor = await raw.submit(
      "g.V().has('repositoryId', rid).hasId(eid).project('label', 'entityType').by(values('entityLabel')).by(values('entityType'))",
      { rid: RID.collision, eid: 'col-x' },
    );
    expect(survivor.items).toEqual([{ label: 'Renamed', entityType: '_repository' }]);

    await expect(provider.deleteRepository(RID.collision)).resolves.toEqual({
      deletedEntities: 2,
      deletedRelationships: 0,
    });
  }, 60_000);

  it('deleting the entities typed _repository leaves the repository marker in place', async () => {
    const rid = RID.typeDelete;
    await freshRepository(rid);
    await provider.createEntity(rid, { ...makeEntity('td-x'), entityType: '_repository', slug: '_repository:td-x' });
    await provider.createEntity(rid, makeEntity('td-y'));
    const markerCount = async (): Promise<number> => {
      const result = await raw.submit(
        "g.V().has('repositoryId', rid).hasId(vid).hasLabel('_repository').hasNot('entityType').count()",
        { rid, vid: `repo:${rid}` },
      );
      return Number(result.items[0] ?? 0);
    };

    await expect(provider.deleteEntitiesByType(rid, '_repository')).resolves.toMatchObject({ deletedEntities: 1 });
    expect(await markerCount()).toBe(1);
    expect(await provider.getEntity(rid, 'td-x')).toBeNull();
    expect((await provider.getEntity(rid, 'td-y'))?.id).toBe('td-y');
    expect(await provider.getRepository(rid)).not.toBeNull();

    // With no entity of the type left, the marker still stays.
    await expect(provider.deleteEntitiesByType(rid, '_repository')).resolves.toMatchObject({ deletedEntities: 0 });
    expect(await markerCount()).toBe(1);

    await expect(provider.deleteRepository(rid)).resolves.toEqual({ deletedEntities: 1, deletedRelationships: 0 });
  }, 60_000);

  it('by-type deletes larger than one batch remove everything of the type and report the exact count', async () => {
    const rid = RID.bigTypeDelete;
    await freshRepository(rid);
    const things = Array.from({ length: 1_200 }, (_, i) => makeEntity(`big-${i}`));
    const others = Array.from({ length: 20 }, (_, i) => ({ ...makeEntity(`keep-${i}`), entityType: 'Other', slug: `Other:keep-${i}` }));
    // 650 LINKS edges among the kept entities, plus one OTHER edge, and one
    // LINKS edge from a Thing so the entity delete cascades through an edge.
    const links = Array.from({ length: 650 }, (_, i) => makeRelationship(`link-${i}`, `keep-${i % 20}`, `keep-${(i + 1) % 20}`));
    const otherEdge = { ...makeRelationship('other-edge', 'keep-0', 'keep-1'), relationshipType: 'OTHER' };
    const thingEdge = makeRelationship('thing-edge', 'big-0', 'keep-0');
    const chunks = [];
    for (let i = 0; i < things.length; i += 500) chunks.push({ entities: things.slice(i, i + 500) });
    chunks.push({ entities: others });
    chunks.push({ relationships: [...links, otherEdge, thingEdge] });
    const imported = await provider.importBulk(rid, chunks, { skipExistenceCheck: true });
    expect(imported.errors).toEqual([]);

    const entityCount = (type: string): Promise<number> =>
      raw.submit("g.V().has('repositoryId', rid).has('entityType', etype).count()", { rid, etype: type }).then((r) =>
        Number(r.items[0] ?? 0),
      );
    const edgeCount = (type: string): Promise<number> =>
      raw.submit("g.E().has('repositoryId', rid).hasLabel(rtype).count()", { rid, rtype: type }).then((r) =>
        Number(r.items[0] ?? 0),
      );
    expect(await entityCount('Thing')).toBe(1_200);
    expect(await edgeCount('LINKS')).toBe(651);

    await expect(provider.deleteEntitiesByType(rid, 'Thing')).resolves.toEqual({
      deletedEntities: 1_200,
      deletedRelationships: undefined,
    });
    expect(await entityCount('Thing')).toBe(0);
    expect(await entityCount('Other')).toBe(20);
    // The Thing's edge went with it.
    expect(await provider.getRelationship(rid, 'thing-edge')).toBeNull();
    await expect(provider.deleteEntitiesByType(rid, 'Thing')).resolves.toMatchObject({ deletedEntities: 0 });

    await expect(provider.deleteRelationshipsByType(rid, 'LINKS')).resolves.toEqual({ deletedRelationships: 650 });
    expect(await edgeCount('LINKS')).toBe(0);
    expect(await edgeCount('OTHER')).toBe(1);
    await expect(provider.deleteRelationshipsByType(rid, 'LINKS')).resolves.toEqual({ deletedRelationships: 0 });
  }, 600_000);

  it('importBulk upsert refuses a reused relationship id with another type or endpoints and updates the same edge', async () => {
    const rid = RID.importIds;
    await freshRepository(rid);
    for (const id of ['a', 'b', 'c']) await provider.createEntity(rid, makeEntity(id));
    await provider.createRelationship(rid, makeRelationship('taken', 'a', 'b'));
    const upsert = (relationships: StoredRelationship[]) => provider.importBulk(rid, [{ relationships }]);
    // The edge's label and endpoints as the graph holds them, and its stored fields.
    const shape = async (relId: string) => {
      const graph = await raw.submit(
        "g.E().has('repositoryId', rid).hasId(relId).project('label', 'source', 'target').by(__.label()).by(__.outV().id()).by(__.inV().id())",
        { rid, relId },
      );
      const stored = await provider.getRelationship(rid, relId);
      return {
        graph: graph.items,
        stored: stored && {
          relationshipType: stored.relationshipType,
          sourceEntityId: stored.sourceEntityId,
          targetEntityId: stored.targetEntityId,
          properties: stored.properties,
        },
      };
    };
    const original = {
      graph: [{ label: 'LINKS', source: 'a', target: 'b' }],
      stored: { relationshipType: 'LINKS', sourceEntityId: 'a', targetEntityId: 'b', properties: {} },
    };
    const refused = [expect.objectContaining({ item: 'relationship:taken', code: 'RELATIONSHIP_ALREADY_EXISTS' })];

    const otherType = await upsert([
      { ...makeRelationship('taken', 'a', 'b'), relationshipType: 'OTHER' },
      makeRelationship('fresh', 'b', 'c'),
    ]);
    expect(otherType).toMatchObject({ relationshipsImported: 1, errors: refused });
    expect(await shape('taken')).toEqual(original);
    expect((await shape('fresh')).graph).toEqual([{ label: 'LINKS', source: 'b', target: 'c' }]);

    for (const [src, tgt] of [['b', 'c'], ['b', 'a'], ['a', 'c']] as const) {
      expect(await upsert([makeRelationship('taken', src, tgt)])).toMatchObject({ relationshipsImported: 0, errors: refused });
    }
    expect(await shape('taken')).toEqual(original);

    // A missing endpoint is reported ahead of the id.
    expect(await upsert([makeRelationship('taken', 'a', 'missing')])).toMatchObject({
      relationshipsImported: 0,
      errors: [expect.objectContaining({ item: 'relationship:taken', code: 'ENTITY_NOT_FOUND' })],
    });

    // The same id, type and endpoints updates in place.
    expect(await upsert([{ ...makeRelationship('taken', 'a', 'b'), properties: { weight: 2 } }])).toMatchObject({
      relationshipsImported: 1,
      errors: [],
    });
    expect(await shape('taken')).toEqual({ ...original, stored: { ...original.stored, properties: { weight: 2 } } });

    // An id repeated within one upsert with the same type and endpoints lands as one edge.
    expect(
      await upsert([makeRelationship('twice', 'a', 'c'), { ...makeRelationship('twice', 'a', 'c'), properties: { n: 2 } }]),
    ).toMatchObject({ relationshipsImported: 2, errors: [] });
    expect((await shape('twice')).graph).toEqual([{ label: 'LINKS', source: 'a', target: 'c' }]);

    // Insert mode leaves the id check to the store, which refuses the reused id.
    expect(
      await provider.importBulk(rid, [{ relationships: [makeRelationship('taken', 'a', 'b')] }], { skipExistenceCheck: true }),
    ).toMatchObject({ relationshipsImported: 0, errors: refused });
  }, 120_000);

  it('the change record lands with the vocabulary, once, and only change-log vertices are read as records', async () => {
    const rid = RID.changeLog;
    await freshRepository(rid, makeVocabulary('1.0.0'));
    const record: VocabularyChangeRecord = {
      changeId: 'cl-change-1',
      changeType: 'entity_type_added',
      typeName: 'Thing',
      previousVersion: '1.0.0',
      newVersion: '1.1.0',
      proposedBy: 'vocabulary-test',
      proposedAt: '2026-05-27T03:00:00.000Z',
      reason: 'Adds Thing',
    };
    const next = makeVocabulary('1.1.0');

    // The vocabulary lands without its record, as when a first attempt stops
    // between the two writes.
    await provider.saveVocabulary(rid, next, '1.0.0');
    expect((await provider.getVocabularyChangeLog(rid)).total).toBe(0);

    // A retry of the same save finds its own vocabulary stored and writes the
    // record; a second retry finds the record and adds nothing.
    await provider.saveVocabulary(rid, next, '1.0.0', record);
    await provider.saveVocabulary(rid, next, '1.0.0', record);
    const log = await provider.getVocabularyChangeLog(rid);
    expect(log.total).toBe(1);
    expect(log.items).toEqual([record]);

    // An entity typed `_vocabularyChangeLog` carries the record label but is not a record.
    await provider.createEntity(rid, {
      ...makeEntity('cl-impostor'),
      entityType: '_vocabularyChangeLog',
      slug: '_vocabularyChangeLog:cl-impostor',
    });
    expect((await provider.getVocabularyChangeLog(rid)).total).toBe(1);

    // A compare-and-set with the marker gone writes neither the vocabulary nor a record.
    await dropMarker(rid);
    await expect(
      provider.saveVocabulary(rid, makeVocabulary('1.2.0'), '1.1.0', { ...record, changeId: 'cl-change-2' }),
    ).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(await storedVersionProperty(rid)).toEqual(['1.1.0']);
    expect(await count("g.V().has('repositoryId', rid).hasLabel('_vocabularyChangeLog').hasNot('entityType').count()", rid)).toBe(1);
  }, 120_000);

  it('a retried save completes a part-written change record in place, and the log orders ties by changeId', async () => {
    const rid = RID.partialRecord;
    await freshRepository(rid, makeVocabulary('1.0.0'));
    const record: VocabularyChangeRecord = {
      changeId: 'pr-change-b',
      changeType: 'entity_type_added',
      typeName: 'Thing',
      previousVersion: '1.0.0',
      newVersion: '1.1.0',
      proposedBy: 'vocabulary-test',
      proposedAt: '2026-05-27T04:00:00.000Z',
      approvedBy: 'vocabulary-approver',
      approvedAt: '2026-05-27T04:00:01.000Z',
      reason: 'Adds Thing',
    };
    const next = makeVocabulary('1.1.0');

    // A first attempt that wrote the vocabulary and stopped part-way through
    // the record's properties.
    await provider.saveVocabulary(rid, next, '1.0.0');
    await raw.submit(
      "g.addV('_vocabularyChangeLog').property('id', lid).property('repositoryId', rid).property('changeId', cid)",
      { rid, lid: 'vocablog:pr-change-b', cid: 'pr-change-b' },
    );

    // The retry finds its own vocabulary stored and completes the record.
    await provider.saveVocabulary(rid, next, '1.0.0', record);
    const log = await provider.getVocabularyChangeLog(rid);
    expect(log.total).toBe(1);
    expect(log.items).toEqual([record]);
    // The record kept its label and partition, and each property holds one value.
    const stored = await raw.submit(
      "g.V().has('repositoryId', rid).hasId(lid).project('label', 'pk', 'changeIds').by(label).by(values('repositoryId')).by(values('changeId').count())",
      { rid, lid: 'vocablog:pr-change-b' },
    );
    expect(stored.items).toHaveLength(1);
    const row = stored.items[0] as Record<string, unknown> | Map<string, unknown>;
    const field = (key: string): unknown => (row instanceof Map ? row.get(key) : row[key]);
    expect(field('label')).toBe('_vocabularyChangeLog');
    expect(field('pk')).toBe(rid);
    expect(Number(field('changeIds'))).toBe(1);

    // Records proposed at the same instant come back by changeId, descending.
    await provider.saveVocabulary(rid, makeVocabulary('1.2.0'), '1.1.0', {
      ...record,
      changeId: 'pr-change-a',
      previousVersion: '1.1.0',
      newVersion: '1.2.0',
    });
    await provider.saveVocabulary(rid, makeVocabulary('1.3.0'), '1.2.0', {
      ...record,
      changeId: 'pr-change-c',
      previousVersion: '1.2.0',
      newVersion: '1.3.0',
    });
    const all = await provider.getVocabularyChangeLog(rid);
    expect(all.items.map((r) => r.changeId)).toEqual(['pr-change-c', 'pr-change-b', 'pr-change-a']);
    const second = await provider.getVocabularyChangeLog(rid, { limit: 1, offset: 1 });
    expect(second.items.map((r) => r.changeId)).toEqual(['pr-change-b']);
  }, 120_000);

  // A repository whose marker is gone but whose data survives (a delete
  // that stopped after dropping the marker) must be refused by every read,
  // not only by the ones that would have found nothing: each call below is
  // first shown to find the surviving data.
  it('with the marker gone, calls that would find surviving data throw RepositoryNotFoundError and change nothing', async () => {
    const rid = RID.survivors;
    await freshRepository(rid, makeVocabulary('2.0.0'));
    for (const id of ['sv-a', 'sv-b', 'sv-c']) await provider.createEntity(rid, makeEntity(id));
    await provider.createRelationship(rid, makeRelationship('sv-r1', 'sv-a', 'sv-b'));
    await provider.createRelationship(rid, makeRelationship('sv-r2', 'sv-b', 'sv-c'));
    // A vocabulary change, with its record, so the change-log read has
    // something to find.
    await provider.saveVocabulary(rid, makeVocabulary('2.0.1'), '2.0.0', {
      changeId: 'sv-change-1',
      changeType: 'entity_type_added',
      typeName: 'Thing',
      newVersion: '2.0.1',
      proposedBy: 'vocabulary-test',
      proposedAt: '2026-05-27T02:00:00Z',
      reason: 'seeded',
    });

    const spec = {
      start: { entityId: 'sv-a' },
      steps: [{ direction: 'out' as const }],
      returnMode: 'terminal' as const,
      limit: 10,
    };
    const exploreOptions = { depth: 1, direction: 'both' as const, limitPerType: 10, offsetPerType: 0 };
    const pathOptions = { maxDepth: 2, limit: 10, offset: 0 };
    const drain = async (): Promise<number> => {
      let rows = 0;
      for await (const chunk of provider.exportAll(rid)) rows += chunk.data.length;
      return rows;
    };
    const reads: Array<[string, () => Promise<unknown>, unknown]> = [
      ['getEntity', async () => (await provider.getEntity(rid, 'sv-a'))?.id, 'sv-a'],
      ['getEntityBySlug', async () => (await provider.getEntityBySlug(rid, 'Thing:sv-b'))?.id, 'sv-b'],
      ['getEntities', async () => (await provider.getEntities(rid, ['sv-a', 'sv-c'])).size, 2],
      ['findEntities', async () => (await provider.findEntities(rid, { limit: 10, offset: 0 })).items.length, 3],
      [
        'findEntities by type and term',
        async () =>
          (await provider.findEntities(rid, { entityTypes: ['Thing'], searchTerm: 'sv-c', limit: 10, offset: 0 }))
            .items.length,
        1,
      ],
      ['getRelationship', async () => (await provider.getRelationship(rid, 'sv-r1'))?.id, 'sv-r1'],
      ['getVocabularyChangeLog', async () => (await provider.getVocabularyChangeLog(rid)).total, 1],
      [
        'getEntityRelationships',
        async () => (await provider.getEntityRelationships(rid, 'sv-b', { direction: 'both', limit: 10, offset: 0 })).total,
        2,
      ],
      ['getTimeline', async () => (await provider.getTimeline(rid, 'sv-b', { limit: 10, offset: 0 })).total > 0, true],
      ['exploreNeighborhood', async () => (await provider.exploreNeighborhood(rid, 'sv-b', exploreOptions)).layers.length, 1],
      ['findPaths', async () => (await provider.findPaths(rid, 'sv-a', 'sv-c', pathOptions)).totalPaths, 1],
      ['exportAll', drain, 5],
    ];
    for (const [, read, expected] of reads) {
      await expect(read()).resolves.toEqual(expected);
    }

    // Fill the vocabulary cache of this provider and of one provider per
    // traversal entry point, so each meets the dropped marker with a warm
    // cache.
    const warm = { traverse: await newProvider(), explore: await newProvider(), paths: await newProvider() };
    try {
      expect((await provider.traverse(rid, spec)).entities.map((e) => e.id)).toEqual(['sv-b']);
      for (const p of Object.values(warm)) await p.traverse(rid, spec);

      await dropMarker(rid);

      await expect(provider.traverse(rid, spec)).rejects.toBeInstanceOf(RepositoryNotFoundError);
      await expect(warm.traverse.traverse(rid, spec)).rejects.toBeInstanceOf(RepositoryNotFoundError);
      await expect(warm.explore.exploreNeighborhood(rid, 'sv-b', exploreOptions)).rejects.toBeInstanceOf(
        RepositoryNotFoundError,
      );
      await expect(warm.paths.findPaths(rid, 'sv-a', 'sv-c', pathOptions)).rejects.toBeInstanceOf(
        RepositoryNotFoundError,
      );
    } finally {
      for (const p of Object.values(warm)) await p.dispose();
    }
    // The cold-cache path: the refusal above dropped this provider's entry.
    await expect(provider.traverse(rid, { start: { entityType: 'Thing' }, returnMode: 'terminal', limit: 10 })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    for (const [name, read] of reads) {
      await expect(read(), name).rejects.toBeInstanceOf(RepositoryNotFoundError);
    }

    const entityCount = (): Promise<number> => count("g.V().has('repositoryId', rid).has('entityType').count()", rid);
    const edgeCount = (): Promise<number> => count("g.E().has('repositoryId', rid).count()", rid);
    await expect(provider.deleteEntitiesByType(rid, 'Thing')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(await entityCount()).toBe(3);
    await expect(provider.deleteRelationshipsByType(rid, 'LINKS')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(await edgeCount()).toBe(2);

    // Imports write nothing, in either mode.
    const chunks = [
      { entities: [{ ...makeEntity('sv-a'), label: 'changed' }, makeEntity('sv-new')] },
      { relationships: [makeRelationship('sv-r3', 'sv-c', 'sv-a')] },
    ];
    await expect(provider.importBulk(rid, chunks)).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(provider.importBulk(rid, chunks, { skipExistenceCheck: true })).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    expect(await entityCount()).toBe(3);
    expect(await edgeCount()).toBe(2);
    expect(await count("g.V().has('repositoryId', rid).hasId('sv-new').count()", rid)).toBe(0);
    const unchanged = await raw.submit("g.V().has('repositoryId', rid).hasId('sv-a').values('entityLabel')", { rid });
    expect(unchanged.items).toEqual(['sv-a']);

    await expect(provider.deleteRepository(rid)).resolves.toEqual({ deletedEntities: 3, deletedRelationships: 2 });
  }, 120_000);

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
