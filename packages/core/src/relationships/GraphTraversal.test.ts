// GraphTraversal — tests for neighborhood exploration and path finding

import { describe, it, expect, beforeEach } from 'vitest';
import { GraphTraversal } from './GraphTraversal.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import { buildVocabulary } from '../vocabulary/VocabularySchema.js';
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

function makeEntity(id: string, type: string, label: string): StoredEntity {
  return { id, slug: id, entityType: type, label, properties: {}, provenance: makeProvenance() };
}

function makeRel(id: string, type: string, src: string, tgt: string, bidirectional = false): StoredRelationship {
  return {
    id, relationshipType: type, sourceEntityId: src, targetEntityId: tgt,
    properties: {}, bidirectional, provenance: makeProvenance(),
  };
}

describe('GraphTraversal', () => {
  let storage: InMemoryStorageProvider;
  let traversal: GraphTraversal;
  const repoId = '60000000-0000-4000-a000-000000000001';

  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    await storage.createRepository({
      repositoryId: repoId,
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });
    await storage.saveVocabulary(repoId, buildVocabulary({
      entityTypes: [
        { type: 'person', description: 'A person' },
        { type: 'company', description: 'A company' },
        { type: 'project', description: 'A project' },
      ],
      relationshipTypes: [
        { type: 'knows', description: 'Knows', allowedSourceTypes: ['person'], allowedTargetTypes: ['person'], bidirectional: true },
        { type: 'works_at', description: 'Works at', allowedSourceTypes: ['person'], allowedTargetTypes: ['company'] },
        { type: 'leads', description: 'Leads', allowedSourceTypes: ['person'], allowedTargetTypes: ['project'] },
      ],
    }, 'test'));

    traversal = new GraphTraversal(repoId, storage);

    // Build a small graph:
    // Alice --knows--> Bob --works_at--> Acme
    //   |                \--leads--> ProjectX
    //   \--works_at--> WidgetCo
    await storage.createEntity(repoId, makeEntity('person:alice', 'person', 'Alice'));
    await storage.createEntity(repoId, makeEntity('person:bob', 'person', 'Bob'));
    await storage.createEntity(repoId, makeEntity('company:acme', 'company', 'Acme'));
    await storage.createEntity(repoId, makeEntity('company:widgetco', 'company', 'WidgetCo'));
    await storage.createEntity(repoId, makeEntity('project:x', 'project', 'Project X'));

    await storage.createRelationship(repoId, makeRel('r1', 'knows', 'person:alice', 'person:bob', true));
    await storage.createRelationship(repoId, makeRel('r2', 'works_at', 'person:bob', 'company:acme'));
    await storage.createRelationship(repoId, makeRel('r3', 'leads', 'person:bob', 'project:x'));
    await storage.createRelationship(repoId, makeRel('r4', 'works_at', 'person:alice', 'company:widgetco'));
  });

  // ─── Neighborhood Exploration ──────────────────────────────

  describe('exploreNeighborhood', () => {
    it('returns depth-1 neighbours', async () => {
      const result = await traversal.exploreNeighborhood('person:alice');
      expect(result.center.label).toBe('Alice');
      expect(result.layers).toHaveLength(1);
      expect(result.statistics.totalEntities).toBe(2); // Bob + WidgetCo
    });

    it('returns depth-2 neighbours', async () => {
      const result = await traversal.exploreNeighborhood('person:alice', { depth: 2 });
      expect(result.layers.length).toBe(2);
      // Layer 1: Bob + WidgetCo
      // Layer 2: Acme + Project X (via Bob)
      expect(result.statistics.totalEntities).toBe(4);
    });

    it('filters by relationship type', async () => {
      const result = await traversal.exploreNeighborhood('person:alice', {
        relationshipTypes: ['knows'],
      });
      expect(result.layers).toHaveLength(1);
      expect(result.layers[0]['knows']).toBeDefined();
      expect(result.layers[0]['works_at']).toBeUndefined();
    });

    it('filters by direction', async () => {
      const result = await traversal.exploreNeighborhood('person:bob', {
        direction: 'outbound',
      });
      // Bob outbound: knows (bidirectional counts), works_at Acme, leads ProjectX
      const layer = result.layers[0];
      expect(layer).toBeDefined();
    });

    it('filters by entity type', async () => {
      const result = await traversal.exploreNeighborhood('person:alice', {
        depth: 2,
        entityTypes: ['company'],
      });
      // Should only include company entities
      for (const layer of result.layers) {
        for (const group of Object.values(layer)) {
          for (const entity of group.entities) {
            expect(entity.entityType).toBe('company');
          }
        }
      }
    });

    it('respects limitPerType', async () => {
      const result = await traversal.exploreNeighborhood('person:alice', {
        depth: 1,
        limitPerType: 1,
      });
      for (const layer of result.layers) {
        for (const group of Object.values(layer)) {
          expect(group.returned).toBeLessThanOrEqual(1);
        }
      }
    });

    it('throws for non-existent entity', async () => {
      await expect(
        traversal.exploreNeighborhood('person:nobody'),
      ).rejects.toThrow('not found');
    });
  });

  // ─── Path Finding ───────────────────────────────────────────

  describe('findPaths', () => {
    it('finds a direct path', async () => {
      const result = await traversal.findPaths('person:alice', 'person:bob');
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].length).toBe(1);
      expect(result.paths[0].entities).toHaveLength(2);
      expect(result.paths[0].relationships).toHaveLength(1);
    });

    it('finds an indirect path', async () => {
      const result = await traversal.findPaths('person:alice', 'company:acme');
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].length).toBe(2);
      expect(result.paths[0].entities.map((e) => e.id)).toEqual([
        'person:alice', 'person:bob', 'company:acme',
      ]);
    });

    it('returns empty when no path exists', async () => {
      // Create a disconnected entity
      await storage.createEntity(repoId, makeEntity('person:isolated', 'person', 'Isolated'));
      const result = await traversal.findPaths('person:alice', 'person:isolated');
      expect(result.paths).toHaveLength(0);
    });

    it('finds path to self', async () => {
      const result = await traversal.findPaths('person:alice', 'person:alice');
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].length).toBe(0);
    });

    it('includes relationship direction info', async () => {
      const result = await traversal.findPaths('person:alice', 'company:acme');
      const rels = result.paths[0].relationships;
      expect(rels[0].type).toBe('knows');
      expect(rels[1].type).toBe('works_at');
    });

    it('respects maxDepth', async () => {
      const result = await traversal.findPaths('person:alice', 'company:acme', { maxDepth: 1 });
      expect(result.paths).toHaveLength(0); // Can't reach in 1 hop
    });

    it('filters by relationship type', async () => {
      const result = await traversal.findPaths('person:alice', 'company:acme', {
        relationshipTypes: ['works_at'], // Can't traverse "knows" to reach Bob
      });
      expect(result.paths).toHaveLength(0);
    });
  });
});
