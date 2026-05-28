// Cross-repository isolation — D3b layer 4.
//
// Two repositories `A` and `B` sit on the same Neo4j database with deliberately
// overlapping entity ids and relationship ids. Each repository holds a distinct
// graph: distinct labels, distinct entity types, distinct relationship types,
// distinct cardinalities. The two graphs share nothing at the storage layer —
// every node and edge carries a `repositoryId` property that the provider's
// chokepoint binds into every Cypher predicate.
//
// This file exercises every public read API on `Neo4jStorageProvider` against
// repo A, asserts that nothing returned references repo B, then runs the
// symmetric check against B. A regression in the chokepoint (a leaked `$rid`
// binding, a missing `WHERE n.repositoryId = $rid` predicate, a fulltext index
// query that forgets to filter by repository) would surface as cross-leak in
// at least one of these assertions.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

const ISOLATION_RUN_ID = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const REPO_A = `iso-A-${ISOLATION_RUN_ID}`;
const REPO_B = `iso-B-${ISOLATION_RUN_ID}`;

const SHARED_ENTITY_IDS = ['e1', 'e2', 'e3'] as const;
const SHARED_REL_IDS = ['r1', 'r2'] as const;

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'isolation-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'isolation-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(
  repoTag: 'A' | 'B',
  id: string,
  entityType: string,
  label: string,
): StoredEntity {
  return {
    id,
    slug: `${entityType}:${repoTag}-${id}`,
    entityType,
    label,
    summary: `${repoTag} fixture summary for ${id}`,
    // tagOwner is a per-scalar property; D22 / O1 lay it down as a native
    // Neo4j property alongside the JSON blob, so it is server-side queryable.
    // Distinct values per repo make leakage detectable through findEntities.
    properties: { tagOwner: repoTag },
    provenance: provenance(),
  };
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
  describe('Neo4jStorageProvider — cross-repository isolation (live)', () => {
    let provider: Neo4jStorageProvider;

    // Repo A: 3 entities (Person/Person/Place), 2 KNOWS edges between them.
    // Repo B: 2 entities (Animal/Animal), 1 FRIENDS edge. Overlapping ids
    // mean every leak path between the two graphs is detectable — a returned
    // entity for repo A whose label starts with "B-" or entityType "Animal"
    // is direct evidence of a chokepoint bypass.
    beforeAll(async () => {
      provider = new Neo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
      await provider.ensureSchema();

      // Defensive cleanup — survives an interrupted prior run.
      await provider.deleteRepository(REPO_A).catch(() => undefined);
      await provider.deleteRepository(REPO_B).catch(() => undefined);

      await provider.createRepository({
        repositoryId: REPO_A,
        label: 'isolation A',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'isolation-test',
      });
      await provider.createRepository({
        repositoryId: REPO_B,
        label: 'isolation B',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'isolation-test',
      });

      // Repo A graph: Person e1 -> Person e2 -> Place e3 (two KNOWS edges).
      await provider.createEntity(REPO_A, makeEntity('A', 'e1', 'Person', 'A-Alice'));
      await provider.createEntity(REPO_A, makeEntity('A', 'e2', 'Person', 'A-Bob'));
      await provider.createEntity(REPO_A, makeEntity('A', 'e3', 'Place', 'A-Cafe'));
      await provider.createRelationship(REPO_A, makeRelationship('r1', 'KNOWS', 'e1', 'e2'));
      await provider.createRelationship(REPO_A, makeRelationship('r2', 'KNOWS', 'e2', 'e3'));

      // Repo B graph: Animal e1 -> Animal e2 (one FRIENDS edge). e3 absent.
      await provider.createEntity(REPO_B, makeEntity('B', 'e1', 'Animal', 'B-Cat'));
      await provider.createEntity(REPO_B, makeEntity('B', 'e2', 'Animal', 'B-Dog'));
      await provider.createRelationship(REPO_B, makeRelationship('r1', 'FRIENDS', 'e1', 'e2'));
    });

    afterAll(async () => {
      await provider.deleteRepository(REPO_A).catch(() => undefined);
      await provider.deleteRepository(REPO_B).catch(() => undefined);
      await provider.dispose();
    });

    // ─── Helpers ────────────────────────────────────────────────────

    /** Throw if any entity in the bag carries the wrong-repo signature. */
    function assertEntitiesAreFromRepo(
      entities: Array<{ label?: string; entityType?: string; properties?: Record<string, unknown> }>,
      expectedTag: 'A' | 'B',
    ): void {
      for (const entity of entities) {
        if (entity.label !== undefined) {
          expect(entity.label.startsWith(`${expectedTag}-`)).toBe(true);
        }
        if (entity.entityType !== undefined) {
          if (expectedTag === 'A') {
            expect(['Person', 'Place']).toContain(entity.entityType);
          } else {
            expect(['Animal']).toContain(entity.entityType);
          }
        }
        if (entity.properties && 'tagOwner' in entity.properties) {
          expect(entity.properties['tagOwner']).toBe(expectedTag);
        }
      }
    }

    /** Throw if any relationship in the bag carries the wrong-repo type. */
    function assertRelationshipsAreFromRepo(
      relationships: Array<{ type?: string; relationshipType?: string }>,
      expectedTag: 'A' | 'B',
    ): void {
      const expectedType = expectedTag === 'A' ? 'KNOWS' : 'FRIENDS';
      for (const rel of relationships) {
        const observed = rel.type ?? rel.relationshipType;
        expect(observed).toBe(expectedType);
      }
    }

    // ─── getEntity ──────────────────────────────────────────────────

    it('getEntity returns the repository-scoped record for overlapping ids', async () => {
      for (const id of SHARED_ENTITY_IDS) {
        const fromA = await provider.getEntity(REPO_A, id);
        const fromB = await provider.getEntity(REPO_B, id);

        if (id === 'e3') {
          // e3 only exists in A.
          expect(fromA).not.toBeNull();
          expect(fromA?.label).toBe('A-Cafe');
          expect(fromB).toBeNull();
          continue;
        }
        expect(fromA?.label?.startsWith('A-')).toBe(true);
        expect(fromB?.label?.startsWith('B-')).toBe(true);
        expect(fromA?.entityType === fromB?.entityType).toBe(false);
        expect(fromA?.properties['tagOwner']).toBe('A');
        expect(fromB?.properties['tagOwner']).toBe('B');
      }
    });

    // ─── getEntityBySlug ────────────────────────────────────────────

    it('getEntityBySlug does not return the other repository even when the slug exists there', async () => {
      // A's e1 slug is `Person:A-e1`. Query that slug in repo B — B's slugs
      // all start with `Animal:B-`, so the read must return null.
      const slugFromA = `Person:A-e1`;
      const queriedFromB = await provider.getEntityBySlug(REPO_B, slugFromA);
      expect(queriedFromB).toBeNull();
      const queriedFromA = await provider.getEntityBySlug(REPO_A, slugFromA);
      expect(queriedFromA).not.toBeNull();
      expect(queriedFromA?.label).toBe('A-Alice');
    });

    // ─── getEntities (batch) ────────────────────────────────────────

    it('getEntities returns only the scoped repository for overlapping id batches', async () => {
      const ids = [...SHARED_ENTITY_IDS];

      const mapA = await provider.getEntities(REPO_A, ids);
      const mapB = await provider.getEntities(REPO_B, ids);

      expect(mapA.size).toBe(3);
      assertEntitiesAreFromRepo([...mapA.values()], 'A');

      // e3 absent from B — batch returns the two that exist.
      expect(mapB.size).toBe(2);
      expect(mapB.has('e3')).toBe(false);
      assertEntitiesAreFromRepo([...mapB.values()], 'B');
    });

    // ─── findEntities ───────────────────────────────────────────────

    it('findEntities with no filter returns only repository-scoped entities', async () => {
      const resultA = await provider.findEntities(REPO_A, { limit: 50, offset: 0 });
      expect(resultA.total).toBe(3);
      assertEntitiesAreFromRepo(resultA.items, 'A');

      const resultB = await provider.findEntities(REPO_B, { limit: 50, offset: 0 });
      expect(resultB.total).toBe(2);
      assertEntitiesAreFromRepo(resultB.items, 'B');
    });

    it('findEntities with entityType filter cannot leak the other repository', async () => {
      // 'Animal' only exists in B — A must return zero.
      const animalsInA = await provider.findEntities(REPO_A, {
        entityTypes: ['Animal'],
        limit: 50,
        offset: 0,
      });
      expect(animalsInA.total).toBe(0);
      expect(animalsInA.items).toHaveLength(0);

      const animalsInB = await provider.findEntities(REPO_B, {
        entityTypes: ['Animal'],
        limit: 50,
        offset: 0,
      });
      expect(animalsInB.total).toBe(2);
      assertEntitiesAreFromRepo(animalsInB.items, 'B');
    });

    it('findEntities searchTerm cannot leak the other repository through the fulltext index', async () => {
      // The fulltext index `dm_entity_text` is unfiltered by repository; the
      // provider must post-filter on `node.repositoryId = $rid`. A regression
      // there would surface as cross-repo hits below.
      const resultA = await provider.findEntities(REPO_A, {
        searchTerm: 'fixture',
        limit: 50,
        offset: 0,
      });
      assertEntitiesAreFromRepo(resultA.items, 'A');

      const resultB = await provider.findEntities(REPO_B, {
        searchTerm: 'fixture',
        limit: 50,
        offset: 0,
      });
      assertEntitiesAreFromRepo(resultB.items, 'B');
    });

    it('findEntities property predicate scopes to the repository even on a per-scalar match', async () => {
      // The tagOwner scalar is `'A'` in repo A and `'B'` in repo B. Querying
      // `tagOwner == 'B'` in repo A must return zero — even though Neo4j has
      // matching nodes, they all belong to B.
      const bRowsInA = await provider.findEntities(REPO_A, {
        properties: { tagOwner: 'B' },
        limit: 50,
        offset: 0,
      });
      expect(bRowsInA.total).toBe(0);
      expect(bRowsInA.items).toHaveLength(0);

      const bRowsInB = await provider.findEntities(REPO_B, {
        properties: { tagOwner: 'B' },
        limit: 50,
        offset: 0,
      });
      expect(bRowsInB.total).toBe(2);
      assertEntitiesAreFromRepo(bRowsInB.items, 'B');
    });

    // ─── getRelationship ────────────────────────────────────────────

    it('getRelationship returns the repository-scoped edge for overlapping ids', async () => {
      const r1FromA = await provider.getRelationship(REPO_A, 'r1');
      const r1FromB = await provider.getRelationship(REPO_B, 'r1');
      expect(r1FromA?.relationshipType).toBe('KNOWS');
      expect(r1FromB?.relationshipType).toBe('FRIENDS');

      // r2 only exists in A.
      const r2FromA = await provider.getRelationship(REPO_A, 'r2');
      const r2FromB = await provider.getRelationship(REPO_B, 'r2');
      expect(r2FromA?.relationshipType).toBe('KNOWS');
      expect(r2FromB).toBeNull();
    });

    // ─── getEntityRelationships ─────────────────────────────────────

    it('getEntityRelationships returns only the scoped repository edges', async () => {
      const fromA = await provider.getEntityRelationships(REPO_A, 'e1');
      assertRelationshipsAreFromRepo(fromA.items, 'A');
      // e1 in A is the source of one KNOWS edge to e2.
      expect(fromA.items.some((r) => r.relationshipType === 'FRIENDS')).toBe(false);

      const fromB = await provider.getEntityRelationships(REPO_B, 'e1');
      assertRelationshipsAreFromRepo(fromB.items, 'B');
      expect(fromB.items.some((r) => r.relationshipType === 'KNOWS')).toBe(false);
    });

    // ─── traverse ──────────────────────────────────────────────────

    it('traverse confines results to the repository subgraph', async () => {
      const fromA = await provider.traverse(REPO_A, {
        start: { entityId: 'e1' },
        steps: [{ direction: 'out' }],
        returnMode: 'all',
        detailLevel: 'full',
        includeProvenance: false,
      });
      assertEntitiesAreFromRepo(fromA.entities, 'A');
      assertRelationshipsAreFromRepo(fromA.relationships ?? [], 'A');

      const fromB = await provider.traverse(REPO_B, {
        start: { entityId: 'e1' },
        steps: [{ direction: 'out' }],
        returnMode: 'all',
        detailLevel: 'full',
        includeProvenance: false,
      });
      assertEntitiesAreFromRepo(fromB.entities, 'B');
      assertRelationshipsAreFromRepo(fromB.relationships ?? [], 'B');
    });

    // ─── exploreNeighborhood ────────────────────────────────────────

    it('exploreNeighborhood walks only the scoped repository graph', async () => {
      const fromA = await provider.exploreNeighborhood(REPO_A, 'e1', {
        depth: 2,
        direction: 'both',
        limitPerType: 10,
        offsetPerType: 0,
      });
      expect(fromA.centerId).toBe('e1');
      const aTypes = new Set(fromA.layers.flatMap((layer) => Object.keys(layer)));
      expect(aTypes.has('FRIENDS')).toBe(false);
      for (const layer of fromA.layers) {
        for (const group of Object.values(layer)) {
          assertEntitiesAreFromRepo(group.entities, 'A');
          assertRelationshipsAreFromRepo(group.relationships, 'A');
        }
      }

      const fromB = await provider.exploreNeighborhood(REPO_B, 'e1', {
        depth: 2,
        direction: 'both',
        limitPerType: 10,
        offsetPerType: 0,
      });
      const bTypes = new Set(fromB.layers.flatMap((layer) => Object.keys(layer)));
      expect(bTypes.has('KNOWS')).toBe(false);
      for (const layer of fromB.layers) {
        for (const group of Object.values(layer)) {
          assertEntitiesAreFromRepo(group.entities, 'B');
          assertRelationshipsAreFromRepo(group.relationships, 'B');
        }
      }
    });

    // ─── findPaths ──────────────────────────────────────────────────

    it('findPaths only finds paths inside the scoped repository', async () => {
      // e1 -> e3 path exists in A (via e2), but e3 does not exist in B.
      const fromA = await provider.findPaths(REPO_A, 'e1', 'e3', {
        maxDepth: 3,
        limit: 5,
        offset: 0,
      });
      expect(fromA.paths.length).toBeGreaterThanOrEqual(1);
      // Every relationship referenced in every path belongs to A.
      const aRelIds = new Set(fromA.paths.flatMap((p) => p.relationshipIds));
      for (const relId of aRelIds) {
        const rel = await provider.getRelationship(REPO_A, relId);
        expect(rel?.relationshipType).toBe('KNOWS');
      }

      const fromB = await provider.findPaths(REPO_B, 'e1', 'e3', {
        maxDepth: 3,
        limit: 5,
        offset: 0,
      });
      expect(fromB.paths).toHaveLength(0);
    });

    // ─── getTimeline ───────────────────────────────────────────────

    it('getTimeline references only scoped-repository relationships', async () => {
      const fromA = await provider.getTimeline(REPO_A, 'e1', { limit: 50, offset: 0 });
      expect(fromA.events.length).toBeGreaterThan(0);
      // Relationship-created events in A reference KNOWS edges only.
      for (const event of fromA.events) {
        if (event.relationshipId !== undefined) {
          const rel = await provider.getRelationship(REPO_A, event.relationshipId);
          expect(rel?.relationshipType).toBe('KNOWS');
        }
      }

      const fromB = await provider.getTimeline(REPO_B, 'e1', { limit: 50, offset: 0 });
      for (const event of fromB.events) {
        if (event.relationshipId !== undefined) {
          const rel = await provider.getRelationship(REPO_B, event.relationshipId);
          expect(rel?.relationshipType).toBe('FRIENDS');
        }
      }
    });

    // ─── getRepositoryStats ────────────────────────────────────────

    it('getRepositoryStats reports per-repository counts only', async () => {
      const statsA = await provider.getRepositoryStats(REPO_A);
      expect(statsA.entityCount).toBe(3);
      expect(statsA.relationshipCount).toBe(2);
      expect(statsA.entityTypeBreakdown['Person']).toBe(2);
      expect(statsA.entityTypeBreakdown['Place']).toBe(1);
      expect(statsA.entityTypeBreakdown['Animal']).toBeUndefined();
      expect(statsA.relationshipTypeBreakdown['KNOWS']).toBe(2);
      expect(statsA.relationshipTypeBreakdown['FRIENDS']).toBeUndefined();

      const statsB = await provider.getRepositoryStats(REPO_B);
      expect(statsB.entityCount).toBe(2);
      expect(statsB.relationshipCount).toBe(1);
      expect(statsB.entityTypeBreakdown['Animal']).toBe(2);
      expect(statsB.entityTypeBreakdown['Person']).toBeUndefined();
      expect(statsB.entityTypeBreakdown['Place']).toBeUndefined();
      expect(statsB.relationshipTypeBreakdown['FRIENDS']).toBe(1);
      expect(statsB.relationshipTypeBreakdown['KNOWS']).toBeUndefined();
    });

    // Reference the shared id constant so it stays alive even if a future
    // refactor moves all the looped assertions inline.
    it('shared id contract — overlapping ids exist in both repositories', async () => {
      const overlapping = SHARED_ENTITY_IDS.filter((id) => id !== 'e3');
      const relOverlap = [SHARED_REL_IDS[0]];
      for (const id of overlapping) {
        expect(await provider.getEntity(REPO_A, id)).not.toBeNull();
        expect(await provider.getEntity(REPO_B, id)).not.toBeNull();
      }
      for (const relId of relOverlap) {
        expect(await provider.getRelationship(REPO_A, relId)).not.toBeNull();
        expect(await provider.getRelationship(REPO_B, relId)).not.toBeNull();
      }
    });
  });
} else {
  describe('Neo4jStorageProvider — cross-repository isolation', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
