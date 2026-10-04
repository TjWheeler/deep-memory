// Batched repository drains across many batches (live).
//
// `deleteAllContents` and `deleteRepository` remove relationships with a
// keyset cursor over the repository's entities (each batch resumes after the
// last entity id the previous one visited), then remove the entities in
// batches. A repository larger than one batch makes the cursor cross several
// batches, and a hub entity with more outgoing edges than one inner
// transaction holds makes one batch commit several inner transactions. The
// counts the calls return and report as progress must still be exact.
// `deleteEntitiesByType` and `deleteRelationshipsByType` delete in the same
// batches, under the same per-statement edge cap, and their counts must be
// exact too, self-loops included: the vocabulary engine decides whether a
// resent type deletion removed anything from them.
//
// The entity drain's `DETACH DELETE` removes any edge the relationship drain
// left behind, so exact final counts alone would not show a cursor that
// stopped early. The fixture therefore puts a full batch of entities with no
// outgoing edges between entities that have them, and the tests check that
// the relationship drain alone removed every edge before any entity went.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DeleteProgressCallback, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

/** Entities the provider takes per drain batch. */
const DRAIN_BATCH = 500;
/** Three drain batches of entities. */
const ENTITIES = 3 * DRAIN_BATCH;
/**
 * Entities with no outgoing edges, in id order: more than one batch, and
 * covering the whole second batch, so one cursor batch deletes no edges
 * while entities after it still have them.
 */
const QUIET_FIRST = 400;
const QUIET_LAST = 1_099;
/** Outgoing edges of the hub entity (the last one): more than one inner transaction holds. */
const HUB_EDGES = 700;
/** A per-statement edge cap below the hub's degree, to make its batch repeat. */
const SMALL_EDGE_CAP = 100;

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'drain-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'drain-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function entityId(i: number): string {
  return `e-${String(i).padStart(5, '0')}`;
}

function makeEntity(id: string): StoredEntity {
  return { id, slug: `person:${id}`, entityType: 'Person', label: id, properties: {}, provenance: provenance() };
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

/**
 * A chain linking each entity to the next, except that the quiet run has no
 * outgoing edges, plus a hub (the last entity) linked to the first HUB_EDGES
 * entities.
 */
function contents(): { entities: StoredEntity[]; relationships: StoredRelationship[] } {
  const entities = Array.from({ length: ENTITIES }, (_, i) => makeEntity(entityId(i)));
  const relationships: StoredRelationship[] = [];
  for (let i = 0; i + 1 < ENTITIES; i++) {
    if (i >= QUIET_FIRST && i <= QUIET_LAST) continue;
    relationships.push(makeRelationship(`chain-${i}`, entityId(i), entityId(i + 1)));
  }
  const hub = entityId(ENTITIES - 1);
  for (let i = 0; i < HUB_EDGES; i++) {
    relationships.push(makeRelationship(`hub-${i}`, hub, entityId(i)));
  }
  return { entities, relationships };
}

type DeleteProgress = Parameters<DeleteProgressCallback>[0];

const EXPECTED = {
  deletedEntities: ENTITIES,
  deletedRelationships: ENTITIES - 1 - (QUIET_LAST - QUIET_FIRST + 1) + HUB_EDGES,
};

/** Takes at most SMALL_EDGE_CAP edges per relationship-drain statement. */
class SmallEdgeCapProvider extends Neo4jStorageProvider {
  protected override readonly relationshipDrainEdgeCap = SMALL_EDGE_CAP;
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — batched drains (live)', () => {
    const config = { uri: NEO4J_URI, username: NEO4J_USER, password: NEO4J_PASSWORD, database: NEO4J_DATABASE };
    let provider: Neo4jStorageProvider;
    let smallCapProvider: SmallEdgeCapProvider;
    const repositoryIds: string[] = [];

    beforeAll(async () => {
      provider = new Neo4jStorageProvider(config);
      await provider.initialize();
      await provider.ensureSchema();
      smallCapProvider = new SmallEdgeCapProvider(config);
      await smallCapProvider.initialize();
    });

    afterAll(async () => {
      for (const repositoryId of repositoryIds) {
        if ((await provider.getRepository(repositoryId)) !== null) {
          await provider.deleteRepository(repositoryId);
        }
      }
      await smallCapProvider.dispose();
      await provider.dispose();
    });

    async function populatedRepository(): Promise<string> {
      const repositoryId = randomUUID();
      repositoryIds.push(repositoryId);
      await provider.createRepository({
        repositoryId,
        label: 'drain test',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'drain-test',
      });
      const { entities, relationships } = contents();
      await provider.importBulk(repositoryId, [{ entities }]);
      await provider.importBulk(repositoryId, [{ relationships }]);
      const stats = await provider.getRepositoryStats(repositoryId);
      expect({ deletedEntities: stats.entityCount, deletedRelationships: stats.relationshipCount }).toEqual(EXPECTED);
      return repositoryId;
    }

    function expectRunningCounts(progress: DeleteProgress[]): void {
      expect(progress.length).toBeGreaterThan(2);
      for (let i = 1; i < progress.length; i++) {
        expect(progress[i]!.entitiesDeleted).toBeGreaterThanOrEqual(progress[i - 1]!.entitiesDeleted);
        expect(progress[i]!.relationshipsDeleted).toBeGreaterThanOrEqual(progress[i - 1]!.relationshipsDeleted);
      }
      // The relationship drain reports before any entity is deleted, and it
      // alone must have removed every edge: one the cursor skipped would go
      // with its entity instead, and still count in the final total.
      const relationshipPhase = progress.filter((p) => p.entitiesDeleted === 0);
      expect(relationshipPhase[relationshipPhase.length - 1]?.relationshipsDeleted).toBe(EXPECTED.deletedRelationships);
      expect(progress[progress.length - 1]).toEqual({
        entitiesDeleted: EXPECTED.deletedEntities,
        relationshipsDeleted: EXPECTED.deletedRelationships,
      });
    }

    it('deleteAllContents removes every relationship and entity across batches and counts them exactly', async () => {
      const repositoryId = await populatedRepository();
      const progress: DeleteProgress[] = [];

      await expect(provider.deleteAllContents(repositoryId, (p) => { progress.push({ ...p }); })).resolves.toEqual(EXPECTED);

      expectRunningCounts(progress);
      const stats = await provider.getRepositoryStats(repositoryId);
      expect(stats.entityCount).toBe(0);
      expect(stats.relationshipCount).toBe(0);
      expect(await provider.getRepository(repositoryId)).not.toBeNull();
    }, 120_000);

    it('deleteRepository removes every relationship and entity across batches and counts them exactly', async () => {
      const repositoryId = await populatedRepository();
      const progress: DeleteProgress[] = [];

      await expect(provider.deleteRepository(repositoryId, (p) => { progress.push({ ...p }); })).resolves.toEqual(EXPECTED);

      expectRunningCounts(progress);
      expect(await provider.getRepository(repositoryId)).toBeNull();
    }, 120_000);

    it('a hub with more edges than one drain statement takes is drained by repeating its batch', async () => {
      const repositoryId = await populatedRepository();
      const progress: DeleteProgress[] = [];

      await expect(
        smallCapProvider.deleteAllContents(repositoryId, (p) => { progress.push({ ...p }); }),
      ).resolves.toEqual(EXPECTED);

      expectRunningCounts(progress);
      // No relationship-drain statement deleted more than the cap.
      let previous = 0;
      for (const { relationshipsDeleted } of progress.filter((p) => p.entitiesDeleted === 0)) {
        expect(relationshipsDeleted - previous).toBeLessThanOrEqual(SMALL_EDGE_CAP);
        previous = relationshipsDeleted;
      }
      const stats = await provider.getRepositoryStats(repositoryId);
      expect(stats.entityCount).toBe(0);
      expect(stats.relationshipCount).toBe(0);
    }, 120_000);

    /** Two `Place` entities, one `KNOWS` edge from a person to a place, and two `LIKES` edges between people. */
    async function addOtherTypes(repositoryId: string): Promise<void> {
      const places: StoredEntity[] = ['place-a', 'place-b'].map((id) => ({
        ...makeEntity(id),
        slug: `place:${id}`,
        entityType: 'Place',
      }));
      await provider.importBulk(repositoryId, [{ entities: places }]);
      await provider.importBulk(repositoryId, [
        {
          relationships: [
            makeRelationship('person-to-place', entityId(0), 'place-a'),
            { ...makeRelationship('likes-1', entityId(1), entityId(2)), relationshipType: 'LIKES' },
            { ...makeRelationship('likes-2', entityId(ENTITIES - 1), entityId(3)), relationshipType: 'LIKES' },
          ],
        },
      ]);
    }

    it('deleteEntitiesByType removes a type larger than one batch and counts it exactly', async () => {
      const repositoryId = await populatedRepository();
      await addOtherTypes(repositoryId);

      // Every person-to-person edge, the edge to a place and both LIKES edges go with the people.
      await expect(provider.deleteEntitiesByType(repositoryId, 'Person')).resolves.toEqual({
        deletedEntities: ENTITIES,
        deletedRelationships: EXPECTED.deletedRelationships + 3,
      });

      const stats = await provider.getRepositoryStats(repositoryId);
      expect(stats.entityCount).toBe(2);
      expect(stats.relationshipCount).toBe(0);
      expect(stats.entityTypeBreakdown).toEqual({ Place: 2 });
      await expect(provider.deleteEntitiesByType(repositoryId, 'Person')).resolves.toEqual({
        deletedEntities: 0,
        deletedRelationships: 0,
      });
    }, 120_000);

    it('deleteEntitiesByType drains a hub of the deleted type by repeating its batch at the edge cap, and counts it exactly', async () => {
      const repositoryId = await populatedRepository();
      await addOtherTypes(repositoryId);

      // The hub is a Person with more edges than the small cap: its batch
      // deletes edges at the cap until they run out, then deletes the people.
      await expect(smallCapProvider.deleteEntitiesByType(repositoryId, 'Person')).resolves.toEqual({
        deletedEntities: ENTITIES,
        deletedRelationships: EXPECTED.deletedRelationships + 3,
      });

      const stats = await provider.getRepositoryStats(repositoryId);
      expect(stats.entityCount).toBe(2);
      expect(stats.relationshipCount).toBe(0);
      expect(stats.entityTypeBreakdown).toEqual({ Place: 2 });
    }, 120_000);

    it('the by-type deletes count a self-loop once', async () => {
      const repositoryId = randomUUID();
      repositoryIds.push(repositoryId);
      await provider.createRepository({
        repositoryId,
        label: 'self-loop test',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'drain-test',
      });
      const place = { ...makeEntity('loop-place'), slug: 'place:loop-place', entityType: 'Place' };
      await provider.importBulk(repositoryId, [{ entities: [makeEntity('loop-a'), makeEntity('loop-b'), place] }]);
      await provider.importBulk(repositoryId, [
        {
          relationships: [
            makeRelationship('knows-self', 'loop-a', 'loop-a'),
            makeRelationship('knows-other', 'loop-a', 'loop-b'),
            { ...makeRelationship('likes-self', 'loop-b', 'loop-b'), relationshipType: 'LIKES' },
            { ...makeRelationship('likes-place', 'loop-place', 'loop-place'), relationshipType: 'LIKES' },
          ],
        },
      ]);

      await expect(provider.deleteRelationshipsByType(repositoryId, 'KNOWS')).resolves.toEqual({
        deletedRelationships: 2,
      });
      // The people take their one remaining self-loop with them; the place keeps its own.
      await expect(provider.deleteEntitiesByType(repositoryId, 'Person')).resolves.toEqual({
        deletedEntities: 2,
        deletedRelationships: 1,
      });

      const stats = await provider.getRepositoryStats(repositoryId);
      expect(stats.entityTypeBreakdown).toEqual({ Place: 1 });
      expect(stats.relationshipTypeBreakdown).toEqual({ LIKES: 1 });
    }, 60_000);

    it('deleteRelationshipsByType removes a type across many cursor batches, repeating a hub batch, and counts it exactly', async () => {
      const repositoryId = await populatedRepository();
      await addOtherTypes(repositoryId);

      // The small edge cap makes the hub's batch repeat; the person-to-place edge is a KNOWS edge too.
      await expect(smallCapProvider.deleteRelationshipsByType(repositoryId, 'KNOWS')).resolves.toEqual({
        deletedRelationships: EXPECTED.deletedRelationships + 1,
      });

      const stats = await provider.getRepositoryStats(repositoryId);
      expect(stats.entityCount).toBe(ENTITIES + 2);
      expect(stats.relationshipTypeBreakdown).toEqual({ LIKES: 2 });
      await expect(provider.deleteRelationshipsByType(repositoryId, 'KNOWS')).resolves.toEqual({
        deletedRelationships: 0,
      });
    }, 120_000);
  });
} else {
  describe('Neo4jStorageProvider — batched drains', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
