// Relationship id uniqueness through bulk import (live).
//
// A relationship id is unique across every relationship type in a
// repository, and only within it. Neo4j relationship constraints cover one
// type only, so the upsert import statement checks the id itself: a row
// whose id another edge in the repository carries with a different type or
// different endpoints is refused with RELATIONSHIP_ALREADY_EXISTS and the
// rest of its chunk still lands; the same edge re-imported is updated in
// place. The insert path trusts the caller about ids already in the store
// and refuses only an id repeated within the one call.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'relationship-id-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'relationship-id-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string): StoredEntity {
  return { id, slug: `person:${id}`, entityType: 'Person', label: id, properties: {}, provenance: provenance() };
}

function makeRelationship(
  id: string,
  relationshipType: string,
  sourceEntityId: string,
  targetEntityId: string,
): StoredRelationship {
  return {
    id,
    relationshipType,
    sourceEntityId,
    targetEntityId,
    properties: {},
    bidirectional: false,
    provenance: provenance(),
  };
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — relationship id uniqueness through import (live)', () => {
    let provider: Neo4jStorageProvider;
    let repositoryId: string;
    let otherRepositoryId: string | undefined;

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

    async function createRepositoryWithEntities(id: string): Promise<void> {
      await provider.createRepository({
        repositoryId: id,
        label: 'relationship id',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'relationship-id-test',
      });
      for (const entityId of ['a', 'b', 'c']) await provider.createEntity(id, makeEntity(entityId));
    }

    beforeEach(async () => {
      repositoryId = randomUUID();
      otherRepositoryId = undefined;
      await createRepositoryWithEntities(repositoryId);
      await provider.createRelationship(repositoryId, makeRelationship('taken', 'KNOWS', 'a', 'b'));
    });

    afterEach(async () => {
      for (const id of [repositoryId, otherRepositoryId]) {
        if (id === undefined) continue;
        await provider.deleteRepository(id).catch((err: unknown) => {
          if ((err as { code?: unknown }).code !== 'REPOSITORY_NOT_FOUND') throw err;
        });
      }
    });

    afterAll(async () => {
      await provider.dispose();
    });

    async function edgesWithId(inRepository: string, id: string): Promise<number> {
      const rows = (await provider.executeNativeQuery(
        inRepository,
        'MATCH (:_Entity {repositoryId: $repositoryId})-[r {repositoryId: $repositoryId, id: $id}]->() RETURN count(r) AS edges',
        { repositoryId: inRepository, id },
      )) as Array<{ edges: bigint | number }>;
      return Number(rows[0]?.edges ?? 0);
    }

    it('upsert refuses a row whose id another type already uses, and imports the rest', async () => {
      const result = await provider.importBulk(
        repositoryId,
        [
          {
            relationships: [
              makeRelationship('taken', 'WORKS_WITH', 'a', 'b'),
              makeRelationship('fresh', 'WORKS_WITH', 'b', 'c'),
            ],
          },
        ],
        { skipExistenceCheck: false },
      );

      expect(result.relationshipsImported).toBe(1);
      expect(result.errors).toEqual([
        expect.objectContaining({ item: 'relationship:taken', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
      ]);
      expect(await edgesWithId(repositoryId, 'taken')).toBe(1);
      expect(await provider.getRelationship(repositoryId, 'taken')).toMatchObject({ relationshipType: 'KNOWS' });
      expect(await edgesWithId(repositoryId, 'fresh')).toBe(1);
    });

    it('upsert refuses a row with the same id and type but different endpoints', async () => {
      const result = await provider.importBulk(
        repositoryId,
        [{ relationships: [makeRelationship('taken', 'KNOWS', 'b', 'c')] }],
        { skipExistenceCheck: false },
      );

      expect(result.relationshipsImported).toBe(0);
      expect(result.errors).toEqual([
        expect.objectContaining({ item: 'relationship:taken', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
      ]);
      expect(await edgesWithId(repositoryId, 'taken')).toBe(1);
      expect(await provider.getRelationship(repositoryId, 'taken')).toMatchObject({
        sourceEntityId: 'a',
        targetEntityId: 'b',
      });
    });

    it('updates an edge re-imported through the upsert path instead of refusing it', async () => {
      const reimport = { ...makeRelationship('taken', 'KNOWS', 'a', 'b'), properties: { weight: 2 } };
      const result = await provider.importBulk(repositoryId, [{ relationships: [reimport] }], {
        skipExistenceCheck: false,
      });

      expect(result).toMatchObject({ relationshipsImported: 1, errors: [] });
      expect(await edgesWithId(repositoryId, 'taken')).toBe(1);
      expect(await provider.getRelationship(repositoryId, 'taken')).toMatchObject({ properties: { weight: 2 } });
    });

    it('insert refuses a repeat of an id within one call, in the same chunk or a later one', async () => {
      const result = await provider.importBulk(
        repositoryId,
        [
          {
            relationships: [
              makeRelationship('twice', 'KNOWS', 'b', 'c'),
              makeRelationship('twice', 'KNOWS', 'a', 'c'),
            ],
          },
          { relationships: [makeRelationship('twice', 'WORKS_WITH', 'a', 'c')] },
        ],
        { skipExistenceCheck: true },
      );

      expect(result.relationshipsImported).toBe(1);
      expect(result.errors).toEqual([
        expect.objectContaining({ item: 'relationship:twice', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
        expect.objectContaining({ item: 'relationship:twice', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
      ]);
      expect(await edgesWithId(repositoryId, 'twice')).toBe(1);
      expect(await provider.getRelationship(repositoryId, 'twice')).toMatchObject({
        sourceEntityId: 'b',
        targetEntityId: 'c',
      });
    });

    it.each([true, false])(
      'accepts an id another repository already uses and leaves that edge unchanged (skipExistenceCheck %s)',
      async (skipExistenceCheck) => {
        otherRepositoryId = randomUUID();
        await createRepositoryWithEntities(otherRepositoryId);

        const result = await provider.importBulk(
          otherRepositoryId,
          [{ relationships: [makeRelationship('taken', 'WORKS_WITH', 'b', 'c')] }],
          { skipExistenceCheck },
        );

        expect(result).toMatchObject({ relationshipsImported: 1, errors: [] });
        expect(await edgesWithId(otherRepositoryId, 'taken')).toBe(1);
        expect(await provider.getRelationship(otherRepositoryId, 'taken')).toMatchObject({
          relationshipType: 'WORKS_WITH',
          sourceEntityId: 'b',
          targetEntityId: 'c',
        });
        expect(await edgesWithId(repositoryId, 'taken')).toBe(1);
        expect(await provider.getRelationship(repositoryId, 'taken')).toMatchObject({
          relationshipType: 'KNOWS',
          sourceEntityId: 'a',
          targetEntityId: 'b',
          properties: {},
        });
      },
    );
  });
} else {
  describe('Neo4jStorageProvider — relationship id uniqueness through import', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
