// InMemoryStorageProvider — unit tests

import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStorageProvider } from './InMemoryStorageProvider.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import type { Provenance } from '../types/provenance.js';

function makeProvenance(): Provenance {
  const now = new Date().toISOString();
  return {
    createdBy: 'test', createdByType: 'agent', createdAt: now,
    modifiedBy: 'test', modifiedByType: 'agent', modifiedAt: now,
  };
}

function makeEntity(id: string, type = 'person', label = id): StoredEntity {
  return {
    id,
    slug: `${type}:${label.toLowerCase().replace(/\s+/g, '-')}`,
    entityType: type,
    label,
    properties: {},
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

describe('InMemoryStorageProvider', () => {
  let storage: InMemoryStorageProvider;
  const repoId = '30000000-0000-4000-a000-000000000001';

  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    await storage.createRepository({
      repositoryId: repoId,
      label: 'Test Repo',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });
  });

  // ─── Repository ──────────────────────────────────────────────

  describe('repository operations', () => {
    it('creates and retrieves a repository', async () => {
      const repo = await storage.getRepository(repoId);
      expect(repo).not.toBeNull();
      expect(repo!.label).toBe('Test Repo');
    });

    it('rejects duplicate repository IDs', async () => {
      await expect(storage.createRepository({
        repositoryId: repoId,
        label: 'Dupe',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'test',
      })).rejects.toThrow('already exists');
    });

    it('lists repositories', async () => {
      const list = await storage.listRepositories();
      expect(list.items).toHaveLength(1);
    });

    it('deletes a repository', async () => {
      await storage.deleteRepository(repoId);
      expect(await storage.getRepository(repoId)).toBeNull();
    });

    it('returns stats', async () => {
      const stats = await storage.getRepositoryStats(repoId);
      expect(stats.entityCount).toBe(0);
      expect(stats.relationshipCount).toBe(0);
    });
  });

  // ─── Entities ────────────────────────────────────────────────

  describe('entity operations', () => {
    it('creates and retrieves an entity', async () => {
      const entity = makeEntity('person:tim', 'person', 'Tim');
      await storage.createEntity(repoId, entity);
      const retrieved = await storage.getEntity(repoId, 'person:tim');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.label).toBe('Tim');
    });

    it('retrieves an entity by slug', async () => {
      const entity = makeEntity('person:tim', 'person', 'Tim');
      await storage.createEntity(repoId, entity);
      const retrieved = await storage.getEntityBySlug(repoId, entity.slug);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.id).toBe('person:tim');
      expect(retrieved!.label).toBe('Tim');
    });

    it('returns null for unknown slug', async () => {
      const retrieved = await storage.getEntityBySlug(repoId, 'person:nonexistent');
      expect(retrieved).toBeNull();
    });

    it('rejects duplicate entity IDs', async () => {
      const entity = makeEntity('person:tim');
      await storage.createEntity(repoId, entity);
      await expect(storage.createEntity(repoId, entity)).rejects.toThrow('already exists');
    });

    it('updates an entity', async () => {
      await storage.createEntity(repoId, makeEntity('person:tim', 'person', 'Tim'));
      const updated = await storage.updateEntity(repoId, 'person:tim', {
        label: 'Timothy',
        provenance: makeProvenance(),
      });
      expect(updated.label).toBe('Timothy');
    });

    it('deletes an entity and its relationships', async () => {
      await storage.createEntity(repoId, makeEntity('a'));
      await storage.createEntity(repoId, makeEntity('b'));
      await storage.createRelationship(repoId, makeRelationship('r1', 'knows', 'a', 'b'));

      await storage.deleteEntity(repoId, 'a');
      expect(await storage.getEntity(repoId, 'a')).toBeNull();
      expect(await storage.getRelationship(repoId, 'r1')).toBeNull();
    });

    it('finds entities by search term', async () => {
      await storage.createEntity(repoId, makeEntity('p1', 'person', 'Alice Smith'));
      await storage.createEntity(repoId, makeEntity('p2', 'person', 'Bob Jones'));
      await storage.createEntity(repoId, makeEntity('p3', 'company', 'Acme Corp'));

      const result = await storage.findEntities(repoId, {
        searchTerm: 'alice',
        limit: 10,
        offset: 0,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].label).toBe('Alice Smith');
    });

    it('finds entities by type filter', async () => {
      await storage.createEntity(repoId, makeEntity('p1', 'person', 'Alice'));
      await storage.createEntity(repoId, makeEntity('c1', 'company', 'Acme'));

      const result = await storage.findEntities(repoId, {
        entityTypes: ['company'],
        limit: 10,
        offset: 0,
      });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].entityType).toBe('company');
    });

    it('batch retrieves entities', async () => {
      await storage.createEntity(repoId, makeEntity('a'));
      await storage.createEntity(repoId, makeEntity('b'));

      const map = await storage.getEntities(repoId, ['a', 'b', 'missing']);
      expect(map.size).toBe(2);
      expect(map.has('a')).toBe(true);
      expect(map.has('missing')).toBe(false);
    });
  });

  // ─── Relationships ──────────────────────────────────────────

  describe('relationship operations', () => {
    beforeEach(async () => {
      await storage.createEntity(repoId, makeEntity('a'));
      await storage.createEntity(repoId, makeEntity('b'));
      await storage.createEntity(repoId, makeEntity('c'));
    });

    it('creates and retrieves a relationship', async () => {
      const rel = makeRelationship('r1', 'knows', 'a', 'b');
      await storage.createRelationship(repoId, rel);
      const retrieved = await storage.getRelationship(repoId, 'r1');
      expect(retrieved).not.toBeNull();
      expect(retrieved!.sourceEntityId).toBe('a');
    });

    it('gets entity relationships with direction filter', async () => {
      await storage.createRelationship(repoId, makeRelationship('r1', 'knows', 'a', 'b'));
      await storage.createRelationship(repoId, makeRelationship('r2', 'knows', 'c', 'a'));

      const outbound = await storage.getEntityRelationships(repoId, 'a', { direction: 'out' });
      expect(outbound.items).toHaveLength(1);
      expect(outbound.items[0].targetEntityId).toBe('b');

      const inbound = await storage.getEntityRelationships(repoId, 'a', { direction: 'in' });
      expect(inbound.items).toHaveLength(1);
      expect(inbound.items[0].sourceEntityId).toBe('c');

      const both = await storage.getEntityRelationships(repoId, 'a', { direction: 'both' });
      expect(both.items).toHaveLength(2);
    });

    it('deletes a relationship', async () => {
      await storage.createRelationship(repoId, makeRelationship('r1', 'knows', 'a', 'b'));
      await storage.deleteRelationship(repoId, 'r1');
      expect(await storage.getRelationship(repoId, 'r1')).toBeNull();
    });
  });

  // ─── Graph Traversal ────────────────────────────────────────

  describe('graph traversal', () => {
    beforeEach(async () => {
      await storage.createEntity(repoId, makeEntity('a', 'person', 'Alice'));
      await storage.createEntity(repoId, makeEntity('b', 'person', 'Bob'));
      await storage.createEntity(repoId, makeEntity('c', 'company', 'Acme'));
      await storage.createRelationship(repoId, makeRelationship('r1', 'knows', 'a', 'b'));
      await storage.createRelationship(repoId, makeRelationship('r2', 'works_at', 'b', 'c'));
    });

    it('explores neighborhood at depth 1', async () => {
      const result = await storage.exploreNeighborhood(repoId, 'a', {
        depth: 1,
        direction: 'both',
        limitPerType: 10,
        offsetPerType: 0,
      });
      expect(result.centerId).toBe('a');
      expect(result.layers).toHaveLength(1);
      expect(result.layers[0]['knows']).toBeDefined();
      expect(result.layers[0]['knows'].entities).toHaveLength(1);
    });

    it('explores neighborhood at depth 2', async () => {
      const result = await storage.exploreNeighborhood(repoId, 'a', {
        depth: 2,
        direction: 'both',
        limitPerType: 10,
        offsetPerType: 0,
      });
      expect(result.layers.length).toBe(2);
    });

    it('finds paths between entities', async () => {
      const result = await storage.findPaths(repoId, 'a', 'c', {
        maxDepth: 3,
        limit: 5,
        offset: 0,
      });
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].entityIds).toEqual(['a', 'b', 'c']);
    });

    it('returns empty paths when no connection', async () => {
      await storage.createEntity(repoId, makeEntity('d', 'person', 'Diana'));
      const result = await storage.findPaths(repoId, 'a', 'd', {
        maxDepth: 3,
        limit: 5,
        offset: 0,
      });
      expect(result.paths).toHaveLength(0);
    });
  });

  // ─── Timeline ──────────────────────────────────────────────

  describe('timeline', () => {
    it('returns timeline events for an entity', async () => {
      await storage.createEntity(repoId, makeEntity('a'));
      const result = await storage.getTimeline(repoId, 'a', {
        limit: 10,
        offset: 0,
      });
      expect(result.events.length).toBeGreaterThanOrEqual(1);
      expect(result.events[0].eventType).toBe('entity:created');
    });
  });

  // ─── Bulk Operations ────────────────────────────────────────

  describe('bulk operations', () => {
    it('exports and imports data', async () => {
      await storage.createEntity(repoId, makeEntity('a'));
      await storage.createEntity(repoId, makeEntity('b'));
      await storage.createRelationship(repoId, makeRelationship('r1', 'knows', 'a', 'b'));

      // Export
      const chunks: any[] = [];
      for await (const chunk of storage.exportAll(repoId)) {
        chunks.push(chunk);
      }
      expect(chunks.length).toBeGreaterThanOrEqual(2); // at least entities + relationships

      // Import into new repository
      await storage.createRepository({
        repositoryId: '30000000-0000-4000-a000-000000000002',
        label: 'Import Target',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'test',
      });

      const importChunks = chunks.map((c) =>
        c.type === 'entities' ? { entities: c.data } : { relationships: c.data },
      );
      const result = await storage.importBulk('30000000-0000-4000-a000-000000000002', importChunks);
      expect(result.entitiesImported).toBe(2);
      expect(result.relationshipsImported).toBe(1);
    });
  });
});
