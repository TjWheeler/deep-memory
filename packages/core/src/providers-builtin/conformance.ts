// Provider Conformance Test Suite
// Any StorageProvider implementer can import and run these tests to verify conformance.
//
// Usage:
//   import { runStorageProviderConformanceTests } from '@utaba/deep-memory';
//   runStorageProviderConformanceTests(() => new MyStorageProvider());

import { describe, it, expect, beforeEach } from 'vitest';
import type { StorageProvider } from '../providers/StorageProvider.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import type { Provenance } from '../types/provenance.js';

function makeProvenance(): Provenance {
  const now = new Date().toISOString();
  return {
    createdBy: 'conformance-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'conformance-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string, type = 'test-type', label?: string): StoredEntity {
  return {
    id,
    slug: `${type}:${(label ?? id).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    entityType: type,
    label: label ?? id,
    summary: `Summary for ${id}`,
    properties: { key: 'value' },
    provenance: makeProvenance(),
  };
}

function makeRelationship(
  id: string,
  type: string,
  sourceId: string,
  targetId: string,
  bidirectional = false,
): StoredRelationship {
  return {
    id,
    relationshipType: type,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    properties: {},
    bidirectional,
    provenance: makeProvenance(),
  };
}

/**
 * Run the full StorageProvider conformance test suite.
 *
 * @param factory - A function that creates a fresh, empty StorageProvider instance.
 *                  Called before each test to ensure isolation.
 */
export function runStorageProviderConformanceTests(
  factory: () => StorageProvider | Promise<StorageProvider>,
): void {
  // Use a stable GUID so external cleanup scripts can target it
  const repoId = '40000000-0000-4000-a000-000000000001';

  let provider: StorageProvider;

  async function setup(): Promise<void> {
    provider = await factory();
    if (provider.initialize) await provider.initialize();

    await provider.createRepository({
      repositoryId: repoId,
      label: 'Conformance Test',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'conformance-test',
    });
  }

  describe('StorageProvider Conformance Tests', () => {
    beforeEach(async () => {
      await setup();
    });

    // ─── Repository ─────────────────────────────────────────

    describe('repository operations', () => {
      it('creates a repository', async () => {
        const repo = await provider.getRepository(repoId);
        expect(repo).not.toBeNull();
        expect(repo!.repositoryId).toBe(repoId);
        expect(repo!.label).toBe('Conformance Test');
      });

      it('returns null for non-existent repository', async () => {
        const repo = await provider.getRepository('ffffffff-ffff-4fff-afff-ffffffffffff');
        expect(repo).toBeNull();
      });

      it('lists repositories', async () => {
        const list = await provider.listRepositories();
        expect(list.items.length).toBeGreaterThanOrEqual(1);
        expect(list.items.some((r) => r.repositoryId === repoId)).toBe(true);
      });

      it('updates a repository', async () => {
        const updated = await provider.updateRepository(repoId, {
          label: 'Updated Label',
          description: 'Updated description',
          governanceConfig: { mode: 'open', defaultSimilarityThreshold: 0.4 },
        });
        expect(updated.label).toBe('Updated Label');
        expect(updated.description).toBe('Updated description');
        expect(updated.governanceConfig.defaultSimilarityThreshold).toBe(0.4);

        // Verify persistence
        const fetched = await provider.getRepository(repoId);
        expect(fetched!.label).toBe('Updated Label');
        expect(fetched!.governanceConfig.defaultSimilarityThreshold).toBe(0.4);
      });

      it('deletes a repository', async () => {
        await provider.deleteRepository(repoId);
        expect(await provider.getRepository(repoId)).toBeNull();
      });

      it('returns repository stats', async () => {
        const stats = await provider.getRepositoryStats(repoId);
        expect(stats.entityCount).toBe(0);
        expect(stats.relationshipCount).toBe(0);
        expect(typeof stats.vocabularyVersion).toBe('string');
      });
    });

    // ─── Vocabulary ─────────────────────────────────────────

    describe('vocabulary operations', () => {
      it('gets and saves vocabulary', async () => {
        const vocab = await provider.getVocabulary(repoId);
        expect(vocab).toBeDefined();
        expect(typeof vocab.version).toBe('string');

        const updated = { ...vocab, version: '1.0.0' };
        await provider.saveVocabulary(repoId, updated);

        const fetched = await provider.getVocabulary(repoId);
        expect(fetched.version).toBe('1.0.0');
      });

      it('returns vocabulary change log', async () => {
        const log = await provider.getVocabularyChangeLog(repoId);
        expect(Array.isArray(log.items)).toBe(true);
      });
    });

    // ─── Entities ───────────────────────────────────────────

    describe('entity operations', () => {
      it('creates and retrieves an entity', async () => {
        const entity = makeEntity('e1');
        await provider.createEntity(repoId, entity);

        const retrieved = await provider.getEntity(repoId, 'e1');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe('e1');
        expect(retrieved!.label).toBe('e1');
      });

      it('retrieves an entity by slug', async () => {
        const entity = makeEntity('e1', 'test-type', 'Alpha');
        await provider.createEntity(repoId, entity);

        const retrieved = await provider.getEntityBySlug(repoId, entity.slug);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe('e1');
        expect(retrieved!.slug).toBe(entity.slug);
      });

      it('returns null for non-existent entity', async () => {
        const result = await provider.getEntity(repoId, 'nonexistent');
        expect(result).toBeNull();
      });

      it('returns null for non-existent slug', async () => {
        const result = await provider.getEntityBySlug(repoId, 'nonexistent:slug');
        expect(result).toBeNull();
      });

      it('batch retrieves entities', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.createEntity(repoId, makeEntity('e2'));

        const map = await provider.getEntities(repoId, ['e1', 'e2', 'missing']);
        expect(map.size).toBe(2);
        expect(map.has('e1')).toBe(true);
        expect(map.has('e2')).toBe(true);
        expect(map.has('missing')).toBe(false);
      });

      it('updates an entity', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        const updated = await provider.updateEntity(repoId, 'e1', {
          label: 'Updated Label',
          provenance: makeProvenance(),
        });
        expect(updated.label).toBe('Updated Label');

        const fetched = await provider.getEntity(repoId, 'e1');
        expect(fetched!.label).toBe('Updated Label');
      });

      it('clears summary/data/dataFormat when null is passed', async () => {
        const entity: StoredEntity = {
          ...makeEntity('e1'),
          summary: 'starting summary',
          data: 'raw content',
          dataFormat: 'text/plain',
        };
        await provider.createEntity(repoId, entity);

        await provider.updateEntity(repoId, 'e1', {
          summary: null,
          data: null,
          dataFormat: null,
          provenance: makeProvenance(),
        });

        const fetched = await provider.getEntity(repoId, 'e1');
        expect(fetched!.summary).toBeUndefined();
        expect(fetched!.data).toBeUndefined();
        expect(fetched!.dataFormat).toBeUndefined();
      });

      it('preserves summary/data/dataFormat when undefined is passed', async () => {
        const entity: StoredEntity = {
          ...makeEntity('e1'),
          summary: 'keep me',
          data: 'keep me too',
          dataFormat: 'text/plain',
        };
        await provider.createEntity(repoId, entity);

        await provider.updateEntity(repoId, 'e1', {
          label: 'Renamed',
          provenance: makeProvenance(),
        });

        const fetched = await provider.getEntity(repoId, 'e1');
        expect(fetched!.summary).toBe('keep me');
        expect(fetched!.data).toBe('keep me too');
        expect(fetched!.dataFormat).toBe('text/plain');
      });

      it('deletes an entity', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.deleteEntity(repoId, 'e1');
        expect(await provider.getEntity(repoId, 'e1')).toBeNull();
      });

      it('finds entities by search term', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'test-type', 'Alpha'));
        await provider.createEntity(repoId, makeEntity('e2', 'test-type', 'Beta'));

        const result = await provider.findEntities(repoId, {
          searchTerm: 'alpha',
          limit: 10,
          offset: 0,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.label).toBe('Alpha');
      });

      it('finds entities by type filter', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'type-a', 'A'));
        await provider.createEntity(repoId, makeEntity('e2', 'type-b', 'B'));

        const result = await provider.findEntities(repoId, {
          entityTypes: ['type-a'],
          limit: 10,
          offset: 0,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.entityType).toBe('type-a');
      });

      it('paginates find results', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.createEntity(repoId, makeEntity('e2'));
        await provider.createEntity(repoId, makeEntity('e3'));

        const page1 = await provider.findEntities(repoId, { limit: 2, offset: 0 });
        expect(page1.items).toHaveLength(2);
        expect(page1.hasMore).toBe(true);

        const page2 = await provider.findEntities(repoId, { limit: 2, offset: 2 });
        expect(page2.items).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });
    });

    // ─── Relationships ──────────────────────────────────────

    describe('relationship operations', () => {
      beforeEach(async () => {
        await provider.createEntity(repoId, makeEntity('a'));
        await provider.createEntity(repoId, makeEntity('b'));
        await provider.createEntity(repoId, makeEntity('c'));
      });

      it('creates and retrieves a relationship', async () => {
        const rel = makeRelationship('r1', 'connects', 'a', 'b');
        await provider.createRelationship(repoId, rel);

        const retrieved = await provider.getRelationship(repoId, 'r1');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.sourceEntityId).toBe('a');
        expect(retrieved!.targetEntityId).toBe('b');
      });

      it('returns null for non-existent relationship', async () => {
        expect(await provider.getRelationship(repoId, 'nonexistent')).toBeNull();
      });

      it('gets entity relationships', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'connects', 'c', 'a'));

        const result = await provider.getEntityRelationships(repoId, 'a');
        expect(result.items).toHaveLength(2);
      });

      it('filters relationships by direction', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'connects', 'c', 'a'));

        const outbound = await provider.getEntityRelationships(repoId, 'a', { direction: 'outbound' });
        expect(outbound.items).toHaveLength(1);
        expect(outbound.items[0]!.targetEntityId).toBe('b');

        const inbound = await provider.getEntityRelationships(repoId, 'a', { direction: 'inbound' });
        expect(inbound.items).toHaveLength(1);
        expect(inbound.items[0]!.sourceEntityId).toBe('c');
      });

      it('deletes a relationship', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.deleteRelationship(repoId, 'r1');
        expect(await provider.getRelationship(repoId, 'r1')).toBeNull();
      });
    });

    // ─── Graph Traversal ────────────────────────────────────

    describe('graph traversal', () => {
      beforeEach(async () => {
        await provider.createEntity(repoId, makeEntity('a', 'node', 'A'));
        await provider.createEntity(repoId, makeEntity('b', 'node', 'B'));
        await provider.createEntity(repoId, makeEntity('c', 'node', 'C'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'links', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'links', 'b', 'c'));
      });

      it('explores neighborhood at depth 1', async () => {
        const result = await provider.exploreNeighborhood(repoId, 'a', {
          depth: 1,
          direction: 'both',
          limitPerType: 10,
          offsetPerType: 0,
        });
        expect(result.centerId).toBe('a');
        expect(result.layers).toHaveLength(1);
      });

      it('finds paths between connected entities', async () => {
        const result = await provider.findPaths(repoId, 'a', 'c', {
          maxDepth: 3,
          limit: 5,
          offset: 0,
        });
        expect(result.paths.length).toBeGreaterThanOrEqual(1);
        const firstPath = result.paths[0]!;
        expect(firstPath.entityIds[0]).toBe('a');
        expect(firstPath.entityIds[firstPath.entityIds.length - 1]).toBe('c');
      });

      it('returns empty paths when no connection', async () => {
        await provider.createEntity(repoId, makeEntity('isolated', 'node', 'Isolated'));
        const result = await provider.findPaths(repoId, 'a', 'isolated', {
          maxDepth: 3,
          limit: 5,
          offset: 0,
        });
        expect(result.paths).toHaveLength(0);
      });

      it('finds paths through non-bidirectional inbound edges', async () => {
        // Graph: a → b ← d (both edges are non-bidirectional)
        // Path from a to d should traverse: a →(outbound) b ←(inbound) d
        await provider.createEntity(repoId, makeEntity('d', 'node', 'D'));
        await provider.createRelationship(repoId, makeRelationship('r3', 'links', 'd', 'b'));
        const result = await provider.findPaths(repoId, 'a', 'd', {
          maxDepth: 3,
          limit: 5,
          offset: 0,
        });
        expect(result.paths.length).toBeGreaterThanOrEqual(1);
        const firstPath = result.paths[0]!;
        expect(firstPath.entityIds[0]).toBe('a');
        expect(firstPath.entityIds[firstPath.entityIds.length - 1]).toBe('d');
      });
    });

    // ─── Timeline ───────────────────────────────────────────

    describe('timeline', () => {
      it('returns timeline events', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        const result = await provider.getTimeline(repoId, 'e1', {
          limit: 10,
          offset: 0,
        });
        expect(result.events.length).toBeGreaterThanOrEqual(1);
      });
    });

    // ─── Bulk Operations ────────────────────────────────────

    describe('bulk operations', () => {
      it('exports data', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));

        const chunks = [];
        for await (const chunk of provider.exportAll(repoId)) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('imports data', async () => {
        const result = await provider.importBulk(repoId, [
          { entities: [makeEntity('imported-1'), makeEntity('imported-2')] },
          { relationships: [makeRelationship('ir1', 'links', 'imported-1', 'imported-2')] },
        ]);
        expect(result.entitiesImported).toBe(2);
        expect(result.relationshipsImported).toBe(1);

        // Verify imported data is accessible
        const e = await provider.getEntity(repoId, 'imported-1');
        expect(e).not.toBeNull();
      });
    });

    // ─── Delete All Contents ───────────────────────────────

    describe('deleteAllContents', () => {
      it('deletes all entities and relationships but preserves the repository', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'alpha'));
        await provider.createEntity(repoId, makeEntity('e2', 'beta'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'links', 'e1', 'e2'));

        const result = await provider.deleteAllContents(repoId);
        expect(result.deletedEntities).toBe(2);
        expect(result.deletedRelationships).toBe(1);

        // Repository still exists
        const repo = await provider.getRepository(repoId);
        expect(repo).not.toBeNull();

        // Vocabulary still exists
        const vocab = await provider.getVocabulary(repoId);
        expect(vocab).toBeDefined();

        // Contents are gone
        const stats = await provider.getRepositoryStats(repoId);
        expect(stats.entityCount).toBe(0);
        expect(stats.relationshipCount).toBe(0);
      });

      it('returns zero counts on an empty repository', async () => {
        const result = await provider.deleteAllContents(repoId);
        expect(result.deletedEntities).toBe(0);
        expect(result.deletedRelationships).toBe(0);
      });
    });

    // ─── Stats after data ───────────────────────────────────

    describe('stats reflect data', () => {
      it('counts entities and relationships', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'alpha'));
        await provider.createEntity(repoId, makeEntity('e2', 'alpha'));
        await provider.createEntity(repoId, makeEntity('e3', 'beta'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'links', 'e1', 'e2'));

        const stats = await provider.getRepositoryStats(repoId);
        expect(stats.entityCount).toBe(3);
        expect(stats.relationshipCount).toBe(1);
        expect(stats.entityTypeBreakdown['alpha']).toBe(2);
        expect(stats.entityTypeBreakdown['beta']).toBe(1);
        expect(stats.relationshipTypeBreakdown['links']).toBe(1);
      });
    });
  });
}
