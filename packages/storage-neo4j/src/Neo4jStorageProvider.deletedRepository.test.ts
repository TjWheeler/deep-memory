// Calls on a repository whose marker is gone (live).
//
// `deleteRepository` removes the `_Repository` marker first and drains the
// data afterwards, across many transactions. A delete interrupted between the
// two leaves entities, relationships and the vocabulary behind with no
// marker. Every repository-scoped call — writes, type deletes, reads that
// would hit the data left behind, exports and traversals, whatever the
// vocabulary cache holds — must treat that repository as deleted
// (`RepositoryNotFoundError`) and must not touch what is left, while
// `deleteRepository` must still finish the delete and report what it removed.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepositoryNotFoundError } from '@utaba/deep-memory';
import type {
  StorageExploreOptions,
  StoragePathOptions,
  StoredEntity,
  StoredRelationship,
  TraversalSpec,
} from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

const TEST_TIMEOUT_MS = 30_000;
const REPOSITORY_NOT_FOUND = { name: 'RepositoryNotFoundError', code: 'REPOSITORY_NOT_FOUND' };

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'deleted-repository-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'deleted-repository-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string): StoredEntity {
  return { id, slug: `person:${id}`, entityType: 'Person', label: id, properties: { key: 'value' }, provenance: provenance() };
}

function makeRelationship(id: string, sourceEntityId: string, targetEntityId: string): StoredRelationship {
  return {
    id,
    relationshipType: 'KNOWS',
    sourceEntityId,
    targetEntityId,
    properties: {},
    bidirectional: false,
    provenance: provenance(),
  };
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — calls on a repository whose marker is gone (live)', () => {
    const config = { uri: NEO4J_URI, username: NEO4J_USER, password: NEO4J_PASSWORD, database: NEO4J_DATABASE };
    let provider: Neo4jStorageProvider;
    let otherProcess: Neo4jStorageProvider;
    const repositoryIds: string[] = [];

    beforeAll(async () => {
      provider = new Neo4jStorageProvider(config);
      otherProcess = new Neo4jStorageProvider(config);
      await provider.initialize();
      await otherProcess.initialize();
      await provider.ensureSchema();
    });

    afterAll(async () => {
      for (const rid of repositoryIds) {
        try {
          await provider.deleteRepository(rid);
        } catch (err) {
          // Already deleted by the test.
          if (!(err instanceof RepositoryNotFoundError)) throw err;
        }
      }
      await provider.dispose();
      await otherProcess.dispose();
    });

    async function populatedRepository(): Promise<string> {
      const rid = randomUUID();
      repositoryIds.push(rid);
      await provider.createRepository({
        repositoryId: rid,
        label: 'Deleted repository test',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'deleted-repository-test',
      });
      await provider.createEntity(rid, makeEntity('e1'));
      await provider.createEntity(rid, makeEntity('e2'));
      await provider.createRelationship(rid, makeRelationship('r1', 'e1', 'e2'));
      return rid;
    }

    /** Remove only the marker: the state a delete interrupted after its first step leaves. */
    async function dropMarkerOnly(rid: string): Promise<void> {
      await provider.executeNativeQuery(rid, 'MATCH (r:_Repository {repositoryId: $rid}) DELETE r', { rid });
    }

    /** The repository's entities and relationships, counted directly in the store. */
    async function survivors(rid: string): Promise<{ entities: number; relationships: number }> {
      const rows = (await provider.executeNativeQuery(
        rid,
        `MATCH (n:_Entity {repositoryId: $rid})
         OPTIONAL MATCH (n)-[r {repositoryId: $rid}]->()
         RETURN count(DISTINCT n) AS entities, count(r) AS relationships`,
        { rid },
      )) as Array<Record<string, unknown>>;
      return { entities: Number(rows[0]?.['entities']), relationships: Number(rows[0]?.['relationships']) };
    }

    const TERMINAL_STEP: TraversalSpec = { start: { entityId: 'e1' }, steps: [{ direction: 'out' }], returnMode: 'terminal' };
    const EXPLORE: StorageExploreOptions = { depth: 2, direction: 'both', limitPerType: 10, offsetPerType: 0 };
    const PATHS: StoragePathOptions = { maxDepth: 2, limit: 10, offset: 0 };

    /** Drain an export, or reject with what iterating it threw. */
    async function drainExport(rid: string): Promise<number> {
      let chunks = 0;
      for await (const chunk of provider.exportAll(rid)) {
        expect(chunk).toBeDefined();
        chunks++;
      }
      return chunks;
    }

    it('refuses writes and reads, leaves the data alone, and deleteRepository still finishes', async () => {
      const rid = await populatedRepository();
      await provider.getVocabulary(rid); // fill the cache
      await dropMarkerOnly(rid);

      await expect(provider.deleteEntities(rid, ['e1', 'missing'])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      // The refusal above dropped the cached vocabulary, so this read goes to the database.
      await expect(provider.getVocabulary(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getVocabulary(rid, { fresh: true })).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getRepositoryStats(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteRelationships(rid, ['r1'])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteEntity(rid, 'e2')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteRelationship(rid, 'r1')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteRelationship(rid, 'missing')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteEntities(rid, [])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteRelationships(rid, [])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(
        provider.updateEntity(rid, 'e1', { label: 'Renamed', provenance: provenance() }),
      ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(
        provider.updateEntity(rid, 'e1', { properties: { key: 'changed' }, provenance: provenance() }),
      ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      // Ahead of the slug clash with e2.
      await expect(
        provider.updateEntity(rid, 'e1', { slug: 'person:e2', provenance: provenance() }),
      ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);

      // Type deletes refuse too, and drop nothing.
      await expect(provider.deleteEntitiesByType(rid, 'Person')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.deleteRelationshipsByType(rid, 'KNOWS')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);

      // Nothing was written or deleted (read directly: every provider read refuses).
      const rows = (await provider.executeNativeQuery(
        rid,
        'MATCH (n:_Entity {repositoryId: $rid, id: $id}) RETURN n.label AS label, n.slug AS slug, n.properties AS properties',
        { rid, id: 'e1' },
      )) as Array<Record<string, unknown>>;
      expect(rows[0]?.['label']).toBe('e1');
      expect(rows[0]?.['slug']).toBe('person:e1');
      expect(JSON.parse(String(rows[0]?.['properties']))).toEqual({ key: 'value' });
      expect(await survivors(rid)).toEqual({ entities: 2, relationships: 1 });

      await expect(provider.deleteRepository(rid)).resolves.toEqual({ deletedEntities: 2, deletedRelationships: 1 });
      await expect(provider.deleteRepository(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
    }, TEST_TIMEOUT_MS);

    it('refuses every read that would hit the data a marker-less repository still holds', async () => {
      const rid = await populatedRepository();
      // Each read below finds its rows while the marker exists.
      expect(await provider.getEntity(rid, 'e1')).not.toBeNull();
      expect((await provider.findEntities(rid, { limit: 10, offset: 0, searchTerm: 'e1' })).total).toBeGreaterThan(0);
      expect((await provider.getEntityRelationships(rid, 'e1')).items).toHaveLength(1);
      expect((await provider.findPaths(rid, 'e1', 'e2', PATHS)).totalPaths).toBe(1);
      expect(await provider.exploreNeighborhood(rid, 'e1', { ...EXPLORE, depth: 0 })).toEqual({ centerId: 'e1', layers: [] });
      expect(await drainExport(rid)).toBe(2);
      await dropMarkerOnly(rid);

      await expect(provider.getEntity(rid, 'e1')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getEntity(rid, 'e1', { loadEmbeddings: true })).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getEntityBySlug(rid, 'person:e1')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getEntities(rid, ['e1', 'e2'])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getEntities(rid, [])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.findEntities(rid, { limit: 10, offset: 0 })).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(
        provider.findEntities(rid, { limit: 10, offset: 0, entityTypes: ['Person'], properties: { key: 'value' } }),
      ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(
        provider.findEntities(rid, { limit: 10, offset: 0, searchTerm: 'e1' }),
      ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getRelationship(rid, 'r1')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getEntityRelationships(rid, 'e1')).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getEntityRelationships(rid, 'e1', { direction: 'out' })).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(
        provider.getEntityRelationships(rid, 'e2', { direction: 'in', propertyFilters: [{ key: 'k', operator: 'isNull' }] }),
      ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getTimeline(rid, 'e1', { limit: 10, offset: 0 })).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getVocabularyChangeLog(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.exploreNeighborhood(rid, 'e1', EXPLORE)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.exploreNeighborhood(rid, 'e1', { ...EXPLORE, depth: 0 })).rejects.toMatchObject(
        REPOSITORY_NOT_FOUND,
      );
      await expect(provider.findPaths(rid, 'e1', 'e2', PATHS)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.findPaths(rid, 'e1', 'e1', PATHS)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.traverse(rid, TERMINAL_STEP)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(drainExport(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.importBulk(rid, [])).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      // Rows the mapping refuses before any write still answer the missing
      // repository, alone or alongside rows that would be written.
      const reservedKey: StoredEntity = { ...makeEntity('e3'), properties: { repositoryId: 'other' } };
      const unsafeType: StoredRelationship = { ...makeRelationship('r2', 'e1', 'e2'), relationshipType: 'NOT SAFE' };
      for (const options of [undefined, { skipExistenceCheck: true }]) {
        await expect(provider.importBulk(rid, [{ entities: [reservedKey] }], options)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
        await expect(provider.importBulk(rid, [{ relationships: [unsafeType] }], options)).rejects.toMatchObject(
          REPOSITORY_NOT_FOUND,
        );
        await expect(
          provider.importBulk(rid, [{ entities: [reservedKey, makeEntity('e4')] }], options),
        ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
        await expect(
          provider.importBulk(rid, [{ entities: [reservedKey], relationships: [makeRelationship('r3', 'e1', 'e2')] }], options),
        ).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      }

      expect(await survivors(rid)).toEqual({ entities: 2, relationships: 1 });
      await expect(provider.deleteRepository(rid)).resolves.toEqual({ deletedEntities: 2, deletedRelationships: 1 });
      expect(await survivors(rid)).toEqual({ entities: 0, relationships: 0 });
    }, TEST_TIMEOUT_MS);

    // A traversal compiles against the cached vocabulary, so a warm cache must
    // not stand in for the repository: the traversal statement reads the
    // marker itself.
    const TRAVERSALS: Array<[string, (p: Neo4jStorageProvider, rid: string) => Promise<unknown>]> = [
      ['traverse', (p, rid) => p.traverse(rid, TERMINAL_STEP)],
      ['exploreNeighborhood', (p, rid) => p.exploreNeighborhood(rid, 'e1', EXPLORE)],
      ['findPaths', (p, rid) => p.findPaths(rid, 'e1', 'e2', PATHS)],
      ['findPaths to itself', (p, rid) => p.findPaths(rid, 'e1', 'e1', PATHS)],
    ];

    for (const [name, call] of TRAVERSALS) {
      it(`${name} refuses with a warm vocabulary cache once the marker is removed`, async () => {
        const rid = await populatedRepository();
        await provider.getVocabulary(rid); // fill the cache
        await expect(call(provider, rid)).resolves.toBeDefined();
        await dropMarkerOnly(rid);

        await expect(call(provider, rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
        // The refusal dropped the cached copy.
        await expect(provider.getVocabulary(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
        expect(await survivors(rid)).toEqual({ entities: 2, relationships: 1 });
      }, TEST_TIMEOUT_MS);

      it(`${name} refuses with a warm vocabulary cache once another process deletes the repository`, async () => {
        const rid = await populatedRepository();
        await provider.getVocabulary(rid); // fill this instance's cache
        await otherProcess.deleteRepository(rid);

        await expect(call(provider, rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
        await expect(provider.getVocabulary(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      }, TEST_TIMEOUT_MS);
    }

    // The first call that reaches the database refuses and drops the cached
    // copy, whichever call it is.
    const FIRST_REFUSALS: Array<[string, (p: Neo4jStorageProvider, rid: string) => Promise<unknown>]> = [
      ['getRepositoryStats', (p, rid) => p.getRepositoryStats(rid)],
      ['exportAll', (_p, rid) => drainExport(rid)],
      ['getEntity', (p, rid) => p.getEntity(rid, 'e1')],
    ];

    for (const [name, refusal] of FIRST_REFUSALS) {
      it(`a cache filled before another process deletes the repository serves only cached vocabulary reads (${name})`, async () => {
        const rid = await populatedRepository();
        await provider.getVocabulary(rid); // fill this instance's cache
        await otherProcess.deleteRepository(rid);

        // Accepted: a cache hit within the TTL is not checked against the database.
        await expect(provider.getVocabulary(rid)).resolves.toMatchObject({ entityTypes: [] });
        await expect(refusal(provider, rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
        await expect(provider.getVocabulary(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      }, TEST_TIMEOUT_MS);
    }
  });
} else {
  describe('Neo4jStorageProvider — calls on a repository whose marker is gone', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
