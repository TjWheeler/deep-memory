// Creates racing deleteRepository (live).
//
// deleteRepository deletes the `_Repository` marker and then drains the
// repository across many transactions. Every create statement write-locks
// the marker and writes only while it still exists, so a create either
// commits before the marker goes (and the drain removes it) or fails with
// RepositoryNotFoundError. Whatever the interleaving, nothing the repository
// held — entity, relationship, vocabulary or marker — may survive the
// delete.
//
// Each round starts a large import chunk and waits until its statement is
// running on the server before deleting the repository, so the delete
// overlaps a write that has already found the marker — the case a create
// that only reads the marker loses. Single entity and relationship creates,
// and relationship imports through both the insert and the upsert template,
// are in flight at the same time.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BulkImportOptions, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

const ROUNDS = 20;
/** Single creates of each kind in flight alongside the import. */
const CREATES_PER_ROUND = 8;
/**
 * Rows in the import chunk — one statement. Large enough that the statement
 * is still running when the test sees it on the server and starts the delete.
 */
const IMPORT_ROWS = 5_000;
/** Rows in each relationship import (insert and upsert) in flight alongside. */
const RELATIONSHIP_IMPORT_ROWS = 50;
/** How long to look for the running import statement before giving up on the round. */
const IMPORT_WATCH_MS = 5_000;
const POLL_INTERVAL_MS = 5;

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'delete-race-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'delete-race-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string): StoredEntity {
  return {
    id,
    slug: `person:${id}`,
    entityType: 'Person',
    label: id,
    properties: {},
    provenance: provenance(),
  };
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A create that is allowed to lose the race, and only that way. */
async function settleCreate(create: Promise<unknown>): Promise<'created' | 'repository-gone'> {
  try {
    await create;
    return 'created';
  } catch (err) {
    if ((err as { code?: unknown }).code === 'REPOSITORY_NOT_FOUND') return 'repository-gone';
    throw err;
  }
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — creates racing deleteRepository (live)', () => {
    let provider: Neo4jStorageProvider;
    const repositoryIds: string[] = [];

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
      // Every round deletes its repository, so the only expected refusal here
      // is that it is already gone.
      try {
        for (const repositoryId of repositoryIds) {
          await provider.deleteRepository(repositoryId).catch((err: unknown) => {
            if ((err as { code?: unknown }).code !== 'REPOSITORY_NOT_FOUND') throw err;
          });
        }
      } finally {
        await provider.dispose();
      }
    });

    /** Count every node and edge still carrying `repositoryId`. */
    async function leftovers(repositoryId: string): Promise<Record<string, number>> {
      const rows = (await provider.executeNativeQuery(
        repositoryId,
        `CALL () { MATCH (n:_Entity {repositoryId: $repositoryId}) RETURN count(n) AS entities }
         CALL () { MATCH (:_Entity {repositoryId: $repositoryId})-[r]-() RETURN count(r) AS relationships }
         CALL () { MATCH (n:_Repository {repositoryId: $repositoryId}) RETURN count(n) AS markers }
         CALL () { MATCH (n:_Vocabulary {repositoryId: $repositoryId}) RETURN count(n) AS vocabularies }
         RETURN entities, relationships, markers, vocabularies`,
        { repositoryId },
      )) as Array<Record<string, bigint | number>>;
      const counts: Record<string, number> = {};
      for (const [key, value] of Object.entries(rows[0] ?? {})) counts[key] = Number(value);
      return counts;
    }

    /**
     * Wait until the repository's import statement is running on the server.
     * False when it could not be seen (it finished first, or never started).
     */
    async function importIsRunning(repositoryId: string, settled: Promise<unknown>): Promise<boolean> {
      let done = false;
      const finish = (): void => {
        done = true;
      };
      settled.then(finish, finish);
      const deadline = Date.now() + IMPORT_WATCH_MS;
      while (!done && Date.now() < deadline) {
        const rows = (await provider.executeNativeQuery(
          repositoryId,
          `SHOW TRANSACTIONS YIELD currentQuery, parameters
           WHERE parameters.rid = $repositoryId AND currentQuery CONTAINS 'UNWIND $rows'
           RETURN count(*) AS running`,
          { repositoryId },
        )) as Array<{ running: bigint | number }>;
        if (Number(rows[0]?.running ?? 0) > 0) return true;
        await delay(POLL_INTERVAL_MS);
      }
      return false;
    }

    it(`leaves nothing behind over ${ROUNDS} rounds of creates overlapping the delete`, async () => {
      let overlappedRounds = 0;

      for (let round = 0; round < ROUNDS; round++) {
        const repositoryId = randomUUID();
        repositoryIds.push(repositoryId);
        await provider.createRepository({
          repositoryId,
          label: `delete race ${round}`,
          governanceConfig: { mode: 'open' },
          createdAt: new Date().toISOString(),
          createdBy: 'delete-race-test',
        });
        await provider.createEntity(repositoryId, makeEntity('anchor-a'));
        await provider.createEntity(repositoryId, makeEntity('anchor-b'));

        const importRows = Array.from({ length: IMPORT_ROWS }, (_, i) => makeEntity(`bulk-${i}`));
        const importing = settleCreate(
          provider
            .importBulk(repositoryId, [{ entities: importRows }], {
              skipExistenceCheck: true,
              chunkSize: IMPORT_ROWS,
            } as BulkImportOptions)
            .then((result) => {
              expect(result.errors).toEqual([]);
            }),
        );
        const singles: Array<Promise<'created' | 'repository-gone'>> = [];
        for (const skipExistenceCheck of [true, false]) {
          const prefix = skipExistenceCheck ? 'ri' : 'ru';
          const rows = Array.from({ length: RELATIONSHIP_IMPORT_ROWS }, (_, i) =>
            makeRelationship(`${prefix}-${i}`, 'anchor-a', 'anchor-b'),
          );
          singles.push(
            settleCreate(
              provider
                .importBulk(repositoryId, [{ relationships: rows }], { skipExistenceCheck })
                .then((result) => {
                  expect(result.errors).toEqual([]);
                }),
            ),
          );
        }
        for (let i = 0; i < CREATES_PER_ROUND; i++) {
          singles.push(settleCreate(provider.createEntity(repositoryId, makeEntity(`e-${i}`))));
          singles.push(
            settleCreate(
              provider.createRelationship(repositoryId, makeRelationship(`r-${i}`, 'anchor-a', 'anchor-b')),
            ),
          );
        }

        if (await importIsRunning(repositoryId, importing)) overlappedRounds++;
        await provider.deleteRepository(repositoryId);
        await Promise.all([importing, ...singles]);

        // Every create that starts after the delete must be refused.
        expect(await settleCreate(provider.createEntity(repositoryId, makeEntity('late')))).toBe(
          'repository-gone',
        );
        expect(
          await settleCreate(
            provider.createRelationship(repositoryId, makeRelationship('late', 'anchor-a', 'anchor-b')),
          ),
        ).toBe('repository-gone');
        await expect(
          provider.importBulk(repositoryId, [{ entities: [makeEntity('late-bulk')] }]),
        ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
        for (const skipExistenceCheck of [true, false]) {
          await expect(
            provider.importBulk(
              repositoryId,
              [{ relationships: [makeRelationship('late-rel', 'anchor-a', 'anchor-b')] }],
              { skipExistenceCheck },
            ),
          ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
        }

        expect(await leftovers(repositoryId)).toEqual({
          entities: 0,
          relationships: 0,
          markers: 0,
          vocabularies: 0,
        });
      }

      // The delete overlapped a running import in at least one round, so the
      // race was exercised rather than avoided.
      expect(overlappedRounds).toBeGreaterThan(0);
    }, 300_000);
  });
} else {
  describe('Neo4jStorageProvider — creates racing deleteRepository', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
