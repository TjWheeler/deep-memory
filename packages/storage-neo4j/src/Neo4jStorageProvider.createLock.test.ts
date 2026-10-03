// Creates waiting on the repository-marker lock while the marker is deleted (live).
//
// Every create statement write-locks the `_Repository` marker and then
// matches it again, because Neo4j grants the lock on a node another
// transaction deleted without raising an error: only the second match sees
// that the marker is gone. This test makes that interleaving certain rather
// than likely. A transaction deletes the marker and stays open, holding the
// marker's lock; each kind of create statement is started and left waiting
// on that lock; the delete then commits. Every create must then report the
// repository as missing and write nothing.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProviderError } from '@utaba/deep-memory';
import type { BulkImportOptions, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import { Neo4jConnection } from './Neo4jConnection.js';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

/** How long to wait for every create to be blocked on the marker lock. */
const BLOCK_WAIT_MS = 15_000;
const POLL_INTERVAL_MS = 20;

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'create-lock-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'create-lock-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string): StoredEntity {
  return { id, slug: `person:${id}`, entityType: 'Person', label: id, properties: {}, provenance: provenance() };
}

function makeRelationship(id: string): StoredRelationship {
  return {
    id,
    relationshipType: 'KNOWS',
    sourceEntityId: 'a',
    targetEntityId: 'b',
    properties: {},
    bidirectional: false,
    provenance: provenance(),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The error a create rejected with, or `undefined` when it succeeded. */
async function rejectionOf(create: Promise<unknown>): Promise<unknown> {
  try {
    await create;
    return undefined;
  } catch (err) {
    return err;
  }
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — creates waiting on a deleted repository marker (live)', () => {
    let provider: Neo4jStorageProvider;
    let conn: Neo4jConnection;

    beforeAll(async () => {
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
      await provider.ensureSchema();
      conn = new Neo4jConnection({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
    });

    afterAll(async () => {
      await provider.dispose();
      await conn.close();
    });

    /** Transactions for the repository that are waiting on a lock. */
    async function blockedCount(repositoryId: string): Promise<number> {
      const rows = (await provider.executeNativeQuery(
        repositoryId,
        `SHOW TRANSACTIONS YIELD parameters, status
         WHERE parameters.rid = $repositoryId AND status STARTS WITH 'Blocked'
         RETURN count(*) AS blocked`,
        { repositoryId },
      )) as Array<{ blocked: bigint | number }>;
      return Number(rows[0]?.blocked ?? 0);
    }

    async function leftovers(repositoryId: string): Promise<{ entities: number; relationships: number }> {
      const rows = (await provider.executeNativeQuery(
        repositoryId,
        `CALL () { MATCH (n:_Entity {repositoryId: $repositoryId}) RETURN count(n) AS entities }
         CALL () { MATCH ()-[r {repositoryId: $repositoryId}]->() RETURN count(r) AS relationships }
         RETURN entities, relationships`,
        { repositoryId },
      )) as Array<{ entities: bigint | number; relationships: bigint | number }>;
      return { entities: Number(rows[0]?.entities ?? -1), relationships: Number(rows[0]?.relationships ?? -1) };
    }

    it('reports RepositoryNotFoundError from every create and writes nothing', async () => {
      const repositoryId = randomUUID();
      await provider.createRepository({
        repositoryId,
        label: 'create lock',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'create-lock-test',
      });

      // The holding transaction deletes the marker, then waits for the test
      // to say whether to commit; throwing rolls it back.
      const rollback = new ProviderError('holding transaction rolled back by the test');
      let release: (commit: boolean) => void = () => undefined;
      const decision = new Promise<boolean>((resolve) => {
        release = resolve;
      });
      let markerDeleted: () => void = () => undefined;
      const deleted = new Promise<void>((resolve) => {
        markerDeleted = resolve;
      });
      const holding = conn.executeWrite(repositoryId, async (tx) => {
        await tx.run('MATCH (r:_Repository {repositoryId: $rid}) DETACH DELETE r', {});
        markerDeleted();
        if (!(await decision)) throw rollback;
      });
      // Declared outside the try so the cleanup can wait for every create to
      // settle: one still in flight could otherwise write after the cleanup.
      let creates: Record<string, Promise<unknown>> = {};
      try {
        await Promise.race([deleted, holding]);

        const insert = { skipExistenceCheck: true } as BulkImportOptions;
        const upsert = { skipExistenceCheck: false } as BulkImportOptions;
        creates = {
          createEntity: rejectionOf(provider.createEntity(repositoryId, makeEntity('e1'))),
          createRelationship: rejectionOf(provider.createRelationship(repositoryId, makeRelationship('r1'))),
          insertEntities: rejectionOf(provider.importBulk(repositoryId, [{ entities: [makeEntity('ie1')] }], insert)),
          upsertEntities: rejectionOf(provider.importBulk(repositoryId, [{ entities: [makeEntity('ue1')] }], upsert)),
          insertRelationships: rejectionOf(
            provider.importBulk(repositoryId, [{ relationships: [makeRelationship('ir1')] }], insert),
          ),
          upsertRelationships: rejectionOf(
            provider.importBulk(repositoryId, [{ relationships: [makeRelationship('ur1')] }], upsert),
          ),
        };
        const expected = Object.keys(creates).length;

        const deadline = Date.now() + BLOCK_WAIT_MS;
        let blocked = 0;
        while (Date.now() < deadline) {
          blocked = await blockedCount(repositoryId);
          if (blocked >= expected) break;
          await delay(POLL_INTERVAL_MS);
        }
        expect(blocked).toBe(expected);

        release(true);
        await holding;

        for (const [name, settled] of Object.entries(creates)) {
          expect({ name, error: await settled }).toEqual({
            name,
            error: expect.objectContaining({ name: 'RepositoryNotFoundError', code: 'REPOSITORY_NOT_FOUND' }),
          });
        }
        expect(await leftovers(repositoryId)).toEqual({ entities: 0, relationships: 0 });
      } finally {
        release(false);
        await holding.catch((err: unknown) => {
          if (err !== rollback) throw err;
        });
        // `rejectionOf` never rejects, so this only waits.
        await Promise.all(Object.values(creates));
        // The holding transaction removed only the marker; remove the rest of
        // the repository (its vocabulary, or the marker after a rollback).
        await provider.executeNativeQuery(
          repositoryId,
          `CALL () { MATCH (n:_Vocabulary {repositoryId: $repositoryId}) DETACH DELETE n }
           CALL () { MATCH (n:_Entity {repositoryId: $repositoryId}) DETACH DELETE n }
           CALL () { MATCH (n:_Repository {repositoryId: $repositoryId}) DETACH DELETE n }`,
          { repositoryId },
        );
      }
    }, 60_000);
  });
} else {
  describe('Neo4jStorageProvider — creates waiting on a deleted repository marker', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
