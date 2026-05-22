import { describe, it, expect, beforeEach } from 'vitest';
import { executeFallbackTraversal } from './FallbackTraversalExecutor.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { TraversalSpec } from '../types/traversal.js';

describe('FallbackTraversalExecutor', () => {
  let storage: InMemoryStorageProvider;
  const repoId = 'test-repo-id';

  // Build a small equipment → component → fluid graph
  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    await storage.createRepository({
      repositoryId: repoId,
      type: 'test',
      label: 'Test',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'test',
    });

    // Save vocabulary
    await storage.saveVocabulary(repoId, {
      version: '1.0.0',
      lastModified: new Date().toISOString(),
      modifiedBy: 'test',
      entityTypes: [
        { type: 'Equipment', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
        { type: 'Component', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
        { type: 'Fluid', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
      ],
      relationshipTypes: [
        { type: 'HAS_COMPONENT', description: '', version: '1.0', allowedSourceTypes: ['Equipment'], allowedTargetTypes: ['Component'], bidirectional: false, createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
        { type: 'REQUIRES_FLUID', description: '', version: '1.0', allowedSourceTypes: ['Component'], allowedTargetTypes: ['Fluid'], bidirectional: false, createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
      ],
    });

    const provenance = { actorId: 'test', timestamp: new Date().toISOString(), conversationId: 'test' };

    // Create entities
    await storage.createEntity(repoId, { id: 'equip-1', slug: 'Equipment:pc7000', entityType: 'Equipment', label: 'PC7000', properties: {}, provenance });
    await storage.createEntity(repoId, { id: 'comp-1', slug: 'Component:engine', entityType: 'Component', label: 'Engine', properties: {}, provenance });
    await storage.createEntity(repoId, { id: 'comp-2', slug: 'Component:hydraulics', entityType: 'Component', label: 'Hydraulics', properties: {}, provenance });
    await storage.createEntity(repoId, { id: 'fluid-1', slug: 'Fluid:engine-oil', entityType: 'Fluid', label: 'Engine Oil', properties: { viscosity: 15 }, provenance });
    await storage.createEntity(repoId, { id: 'fluid-2', slug: 'Fluid:hydraulic-oil', entityType: 'Fluid', label: 'Hydraulic Oil', properties: { viscosity: 46 }, provenance });

    // Create relationships
    await storage.createRelationship(repoId, { id: 'rel-1', relationshipType: 'HAS_COMPONENT', sourceEntityId: 'equip-1', targetEntityId: 'comp-1', properties: {}, bidirectional: false, provenance });
    await storage.createRelationship(repoId, { id: 'rel-2', relationshipType: 'HAS_COMPONENT', sourceEntityId: 'equip-1', targetEntityId: 'comp-2', properties: {}, bidirectional: false, provenance });
    await storage.createRelationship(repoId, { id: 'rel-3', relationshipType: 'REQUIRES_FLUID', sourceEntityId: 'comp-1', targetEntityId: 'fluid-1', properties: { capacity: 40 }, bidirectional: false, provenance });
    await storage.createRelationship(repoId, { id: 'rel-4', relationshipType: 'REQUIRES_FLUID', sourceEntityId: 'comp-2', targetEntityId: 'fluid-2', properties: { capacity: 200 }, bidirectional: false, provenance });
  });

  it('executes a single-hop traversal', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(2);
    expect(result.entities.map((e) => e.label).sort()).toEqual(['Engine', 'Hydraulics']);
    expect(result.total).toBe(2);
    expect(result.queryMetadata.executionTimeMs).toBeGreaterThanOrEqual(0);
  });

  it('executes a two-hop traversal (equipment → components → fluids)', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(2);
    expect(result.entities.map((e) => e.label).sort()).toEqual(['Engine Oil', 'Hydraulic Oil']);
  });

  it('filters by entity type', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [{ direction: 'out', entityTypes: ['Component'] }],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(2);
    expect(result.entities.every((e) => 'entityType' in e && e.entityType === 'Component')).toBe(true);
  });

  it('filters by relationship properties', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        {
          direction: 'out',
          relationshipTypes: ['REQUIRES_FLUID'],
          relationshipFilter: [{ key: 'capacity', operator: 'gte', value: 100 }],
        },
      ],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.label).toBe('Hydraulic Oil');
  });

  it('supports entity property filters', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        {
          direction: 'out',
          relationshipTypes: ['REQUIRES_FLUID'],
          entityFilter: [{ key: 'viscosity', operator: 'lt', value: 20 }],
        },
      ],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.label).toBe('Engine Oil');
  });

  it('supports start by slug', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'Equipment:pc7000' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(2);
  });

  it('respects limit and offset', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'terminal',
      limit: 1,
      offset: 0,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.returned).toBe(1);
    expect(result.total).toBe(2);
    expect(result.hasMore).toBe(true);
  });

  it('deduplicates by default', async () => {
    // This test uses a graph where two paths lead to the same entity
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    const ids = result.entities.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('includes relationships in path mode', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [{ direction: 'out', relationshipTypes: ['HAS_COMPONENT'] }],
      returnMode: 'path',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.paths).toBeDefined();
    expect(result.paths!.length).toBe(2);
    expect(result.relationships).toBeDefined();
    expect(result.relationships!.length).toBeGreaterThan(0);
  });

  it('includes all entities in all mode', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'all',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    // Should include starting entity + both components + both fluids (5 total, deduped)
    expect(result.entities.length).toBe(5);
  });

  it('traverses inbound direction', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'fluid-1' },
      steps: [{ direction: 'in', relationshipTypes: ['REQUIRES_FLUID'] }],
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.label).toBe('Engine');
  });

  it('throws EntityNotFoundError for unknown start entity', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'nonexistent' },
      steps: [{ direction: 'out' }],
      returnMode: 'terminal',
    };

    await expect(executeFallbackTraversal(repoId, storage, spec))
      .rejects.toThrow('not found');
  });

  // ─── Vertex queries (zero steps) ───────────────────────────────

  it('returns starting entities with zero steps', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Component' },
      returnMode: 'terminal',
      limit: 50,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(2);
    expect(result.entities.map((e) => e.label).sort()).toEqual(['Engine', 'Hydraulics']);
  });

  it('returns starting entity by ID with zero steps', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      returnMode: 'terminal',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.label).toBe('PC7000');
  });

  it('filters starting entities by property with zero steps', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Fluid', filter: [{ key: 'viscosity', operator: 'gte', value: 40 }] },
      returnMode: 'terminal',
      limit: 50,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.label).toBe('Hydraulic Oil');
  });

  // ─── Select / Aggregation ─────────────────────────────────────

  // ─── Projection ────────────────────────────────────────────────

  it('projection returns distinct property values and suppresses entities', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Fluid' },
      returnMode: 'terminal',
      projection: { properties: ['viscosity'], distinct: true },
      limit: 50,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toEqual([]);
    expect(result.aggregations).toBeDefined();
    expect(result.aggregations!.length).toBe(2);
    const values = result.aggregations!.map((a) => a.values['viscosity']).sort();
    expect(values).toEqual([15, 46]);
  });

  it('projection count by property value', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Component' },
      returnMode: 'terminal',
      projection: { properties: ['componentType'], mode: 'count' },
      limit: 50,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toEqual([]);
    expect(result.aggregations).toBeDefined();
    for (const agg of result.aggregations!) {
      expect(agg.count).toBeDefined();
      expect(agg.count).toBeGreaterThan(0);
    }
  });

  it('projection.includeEntities returns both entities and aggregations', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Fluid' },
      returnMode: 'terminal',
      projection: { properties: ['viscosity'], distinct: true, includeEntities: true },
      limit: 50,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities.length).toBeGreaterThan(0);
    expect(result.aggregations).toBeDefined();
    expect(result.aggregations!.length).toBe(2);
  });

  it('projection works with traversal (post-hop aggregation)', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'terminal',
      projection: { properties: ['viscosity'], distinct: true },
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.entities).toEqual([]);
    expect(result.aggregations).toBeDefined();
    expect(result.aggregations!.length).toBe(2);
    const viscosities = result.aggregations!.map((a) => a.values['viscosity']).sort();
    expect(viscosities).toEqual([15, 46]);
  });
});
