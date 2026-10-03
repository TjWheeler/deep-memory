// Calls on a repository whose marker is gone (live).
//
// `deleteRepository` removes the `_Repository` marker first and drains the
// data afterwards, across many transactions. A delete interrupted between the
// two leaves entities, relationships and the vocabulary behind with no
// marker. Every repository-scoped write and the vocabulary and stats reads
// must treat that repository as deleted (`RepositoryNotFoundError`) and must
// not touch what is left, while `deleteRepository` must still finish the
// delete and report what it removed.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RepositoryNotFoundError } from '@utaba/deep-memory';
import type { StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
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

      // Nothing was written or deleted.
      const e1 = await provider.getEntity(rid, 'e1');
      expect(e1?.label).toBe('e1');
      expect(e1?.slug).toBe('person:e1');
      expect(e1?.properties).toEqual({ key: 'value' });
      expect(await provider.getEntity(rid, 'e2')).not.toBeNull();
      expect(await provider.getRelationship(rid, 'r1')).not.toBeNull();

      await expect(provider.deleteRepository(rid)).resolves.toEqual({ deletedEntities: 2, deletedRelationships: 1 });
      await expect(provider.deleteRepository(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
    }, TEST_TIMEOUT_MS);

    it('a cache filled before another process deletes the repository serves only cached vocabulary reads', async () => {
      const rid = await populatedRepository();
      await provider.getVocabulary(rid); // fill this instance's cache
      await otherProcess.deleteRepository(rid);

      // Accepted: a cache hit within the TTL is not checked against the database.
      await expect(provider.getVocabulary(rid)).resolves.toMatchObject({ entityTypes: [] });
      // Everything that reaches the database refuses, and the first refusal
      // drops the cached copy.
      await expect(provider.getRepositoryStats(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
      await expect(provider.getVocabulary(rid)).rejects.toMatchObject(REPOSITORY_NOT_FOUND);
    }, TEST_TIMEOUT_MS);
  });
} else {
  describe('Neo4jStorageProvider — calls on a repository whose marker is gone', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
