// Note: this suite is the canonical coverage for the application-level traversal
// path. Both the SQL Server provider (which lacks a native GraphTraversalProvider)
// and the in-memory provider route through executeFallbackTraversal, so changes
// here ripple to SQL Server's traversal behavior without separate test setup.
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

  // ─── Path-mode entity chain (issue A regression) ───────────────

  it('path mode populates entities[] with the full walked sequence (issue A)', async () => {
    const spec: TraversalSpec = {
      start: { entityId: 'equip-1' },
      steps: [
        { direction: 'out', relationshipTypes: ['HAS_COMPONENT'] },
        { direction: 'out', relationshipTypes: ['REQUIRES_FLUID'] },
      ],
      returnMode: 'path',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.paths).toBeDefined();
    expect(result.paths!.length).toBe(2);

    // Each path is a 2-hop walk: start + intermediate + terminal = 3 entities.
    for (const path of result.paths!) {
      expect(path.entities.length).toBe(path.length + 1);
      expect(path.length).toBe(2);
      expect(path.entities.length).toBe(3);
      // Walk order: Equipment → Component → Fluid
      expect(path.entities[0]!.id).toBe('equip-1');
      expect((path.entities[1]! as { entityType: string }).entityType).toBe('Component');
      expect((path.entities[2]! as { entityType: string }).entityType).toBe('Fluid');
    }
  });

  // ─── Relationship direction in 'path' / 'all' modes ───

  it('path mode: inbound step reports direction=inbound', async () => {
    // Edge stored as comp-1 → REQUIRES_FLUID → fluid-1. Walking inbound from
    // fluid-1 crosses the edge target → source, so direction must be 'in'.
    const spec: TraversalSpec = {
      start: { entityId: 'fluid-1' },
      steps: [{ direction: 'in', relationshipTypes: ['REQUIRES_FLUID'] }],
      returnMode: 'path',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.paths).toBeDefined();
    expect(result.paths!.length).toBe(1);
    expect(result.paths![0]!.relationships).toHaveLength(1);
    expect(result.paths![0]!.relationships[0]!.direction).toBe('in');
    // Outer rels mirror walk direction (first-writer-wins).
    expect(result.relationships).toBeDefined();
    expect(result.relationships![0]!.direction).toBe('in');
  });

  it('path mode: both-direction step assigns direction per-walk', async () => {
    // From comp-1 with direction:'both' two walks fan out:
    //   outbound: comp-1 -REQUIRES_FLUID→ fluid-1   (crosses source → target)
    //   inbound : equip-1 -HAS_COMPONENT→ comp-1    (crosses target → source)
    const spec: TraversalSpec = {
      start: { entityId: 'comp-1' },
      steps: [{ direction: 'both' }],
      returnMode: 'path',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.paths).toBeDefined();
    expect(result.paths!.length).toBe(2);

    const directionByTerminal = new Map<string, 'out' | 'in'>();
    for (const p of result.paths!) {
      directionByTerminal.set(p.entities[1]!.id, p.relationships[0]!.direction);
    }
    expect(directionByTerminal.get('fluid-1')).toBe('out');
    expect(directionByTerminal.get('equip-1')).toBe('in');
  });

  it("all mode: every relationship has direction='out' regardless of walk direction", async () => {
    // Same both-direction fanout from comp-1; in 'all' mode direction
    // reflects stored topology (always 'out'), not walk direction.
    const spec: TraversalSpec = {
      start: { entityId: 'comp-1' },
      steps: [{ direction: 'both' }],
      returnMode: 'all',
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.relationships).toBeDefined();
    expect(result.relationships!.length).toBeGreaterThan(0);
    for (const rel of result.relationships!) {
      expect(rel.direction).toBe('out');
    }
  });
});

// ─── Nexus/Orion regression — issue B (path-mode dedup) + 'all'-mode dedup ──

describe('FallbackTraversalExecutor — Nexus/Orion shared-target regression', () => {
  let storage: InMemoryStorageProvider;
  const repoId = 'nexus-orion-repo';

  // Scenario: 4 Persons WORKS_AT Nexus, 2 Persons WORKS_AT Orion.
  // 6 distinct WORKS_AT edges; 6 unique Persons; 2 unique Organizations.
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

    await storage.saveVocabulary(repoId, {
      version: '1.0.0',
      lastModified: new Date().toISOString(),
      modifiedBy: 'test',
      entityTypes: [
        { type: 'Person', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
        { type: 'Organization', description: '', version: '1.0', properties: [], createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
      ],
      relationshipTypes: [
        { type: 'WORKS_AT', description: '', version: '1.0', allowedSourceTypes: ['Person'], allowedTargetTypes: ['Organization'], bidirectional: false, createdAt: '', createdBy: '', modifiedAt: '', modifiedBy: '' },
      ],
    });

    const provenance = { actorId: 'test', timestamp: new Date().toISOString(), conversationId: 'test' };

    for (let i = 1; i <= 6; i++) {
      await storage.createEntity(repoId, { id: `p-${i}`, slug: `Person:p${i}`, entityType: 'Person', label: `P${i}`, properties: {}, provenance });
    }
    await storage.createEntity(repoId, { id: 'org-nexus', slug: 'Organization:nexus', entityType: 'Organization', label: 'Nexus', properties: {}, provenance });
    await storage.createEntity(repoId, { id: 'org-orion', slug: 'Organization:orion', entityType: 'Organization', label: 'Orion', properties: {}, provenance });

    // 4 → Nexus
    for (let i = 1; i <= 4; i++) {
      await storage.createRelationship(repoId, { id: `w-${i}`, relationshipType: 'WORKS_AT', sourceEntityId: `p-${i}`, targetEntityId: 'org-nexus', properties: {}, bidirectional: false, provenance });
    }
    // 2 → Orion
    for (let i = 5; i <= 6; i++) {
      await storage.createRelationship(repoId, { id: `w-${i}`, relationshipType: 'WORKS_AT', sourceEntityId: `p-${i}`, targetEntityId: 'org-orion', properties: {}, bidirectional: false, provenance });
    }
  });

  it('path mode + dedup:true returns one path per WORKS_AT edge (issue B)', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'path',
      dedup: true,
      limit: 200,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    expect(result.paths).toBeDefined();
    // 6 distinct walks (4 to Nexus + 2 to Orion). Pre-fix this returned 2.
    expect(result.paths!.length).toBe(6);
    // Outer rels mirror the walks: 6 unique WORKS_AT edges.
    expect(result.relationships).toBeDefined();
    expect(result.relationships!.length).toBe(6);
  });

  it('path mode ignores spec.dedup — dedup:false yields the same result', async () => {
    const baseSpec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'path',
      limit: 200,
    };

    const withDedup = await executeFallbackTraversal(repoId, storage, { ...baseSpec, dedup: true });
    const withoutDedup = await executeFallbackTraversal(repoId, storage, { ...baseSpec, dedup: false });

    expect(withoutDedup.paths!.length).toBe(withDedup.paths!.length);
    expect(withoutDedup.paths!.length).toBe(6);
  });

  it('all mode dedups entities by id always, preserves every distinct edge', async () => {
    const spec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
      dedup: false,
      limit: 200,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    // 6 unique Persons + 2 unique Organizations — 'all' is inherently deduped
    // by id, so spec.dedup:false is ignored.
    expect(result.entities.length).toBe(8);
    const entityTypes = result.entities.map((e) => (e as { entityType: string }).entityType).sort();
    expect(entityTypes.filter((t) => t === 'Person').length).toBe(6);
    expect(entityTypes.filter((t) => t === 'Organization').length).toBe(2);

    // All 6 WORKS_AT edges must survive even though only 2 distinct targets.
    expect(result.relationships).toBeDefined();
    expect(result.relationships!.length).toBe(6);
    expect(new Set(result.relationships!.map((r) => r.id)).size).toBe(6);
  });

  it('all mode + dedup:true matches dedup:false (spec.dedup ignored for all)', async () => {
    const baseSpec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
      limit: 200,
    };

    const withDedup = await executeFallbackTraversal(repoId, storage, { ...baseSpec, dedup: true });
    const withoutDedup = await executeFallbackTraversal(repoId, storage, { ...baseSpec, dedup: false });

    expect(withDedup.entities.length).toBe(withoutDedup.entities.length);
    expect(withDedup.relationships!.length).toBe(withoutDedup.relationships!.length);
  });

  // ─── 'all'-mode pagination over interleaved entity+edge union ─

  it('all mode paginates the entity+edge union together (page 1: start-frontier persons)', async () => {
    // Union layout for this scenario (6 Persons → WORKS_AT → 2 Orgs):
    //   positions 0-5  : 6 Person entities (depth-0 vertices)
    //   positions 6-7  : 2 Organization entities (depth-1 vertices)
    //   positions 8-13 : 6 WORKS_AT edges (depth-1 edges)
    // Vertices precede edges at each depth so edges in any prefix have their
    // endpoints present. Total: 14 union elements.
    const spec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
      limit: 4,
      offset: 0,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    // First 4 union elements are start-frontier Persons — no edges yet.
    expect(result.entities.length).toBe(4);
    expect(result.relationships).toBeDefined();
    expect(result.relationships!.length).toBe(0);
    expect(result.total).toBe(4);
    expect(result.returned).toBe(4);
    expect(result.hasMore).toBe(true);
    expect(result.entities.every((e) => (e as { entityType: string }).entityType === 'Person')).toBe(true);
  });

  it('all mode pagination spans entities and edges across pages with greedy endpoint expansion', async () => {
    // Page through the same 14-element union in chunks of 10. Page 2 holds
    // only edges by union ordering; greedy-expand pulls their endpoint
    // vertices into the page so it remains referentially self-contained.
    // The pulled-in vertices are duplicates of page 1's entities (the
    // documented soft-limit / cross-page-duplicate cost).
    const baseSpec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
      limit: 10,
    };

    const page1 = await executeFallbackTraversal(repoId, storage, { ...baseSpec, offset: 0 });
    const page2 = await executeFallbackTraversal(repoId, storage, { ...baseSpec, offset: 10 });

    // Page 1: positions 0-9 — 6 Persons + 2 Orgs + 2 WORKS_AT edges.
    // No greedy-expand needed; every edge's endpoints already in the page.
    expect(page1.entities.length).toBe(8);
    expect(page1.relationships!.length).toBe(2);
    expect(page1.total).toBe(10);
    expect(page1.returned).toBe(10);
    expect(page1.hasMore).toBe(true);

    // Page 2: positions 10-13 — 4 WORKS_AT edges by union ordering.
    // Greedy-expand pulls in each edge's endpoint vertices (already emitted
    // in page 1, re-appearing here for self-contained referential integrity).
    expect(page2.relationships!.length).toBe(4);
    expect(page2.entities.length).toBeGreaterThan(0);
    expect(page2.hasMore).toBe(false);
    // Every relationship endpoint must be in the page's entities array.
    const page2EntityIds = new Set(page2.entities.map((e) => e.id));
    for (const rel of page2.relationships!) {
      expect(page2EntityIds.has(rel.sourceEntityId)).toBe(true);
      expect(page2EntityIds.has(rel.targetEntityId)).toBe(true);
    }

    // Relationship ids do not overlap across pages.
    const allRelIds = [...page1.relationships!, ...page2.relationships!].map((r) => r.id);
    expect(new Set(allRelIds).size).toBe(allRelIds.length);
    expect(allRelIds.length).toBe(6);

    // Entity ids may overlap (greedy-expand re-includes endpoints). Combined
    // unique set covers all 8 distinct entities.
    const uniqueEntityIds = new Set([...page1.entities, ...page2.entities].map((e) => e.id));
    expect(uniqueEntityIds.size).toBe(8);
  });

  // ─── Referential integrity at small limits — Council bug regression ──

  it('all mode at limit=2 returns a referentially self-contained page (one provision → one structure)', async () => {
    // Mirrors the Council bug repro: a single start vertex with multiple
    // inbound edges, queried at limit=2. Pre-fix the response contained a
    // relationship whose source entity sat past the slice and was dropped,
    // breaking referential integrity. Post-fix the slice is closed.
    const spec: TraversalSpec = {
      start: { entityId: 'org-nexus' },
      steps: [{ direction: 'in', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
      limit: 2,
      offset: 0,
    };

    const result = await executeFallbackTraversal(repoId, storage, spec);
    const pageEntityIds = new Set(result.entities.map((e) => e.id));
    for (const rel of result.relationships ?? []) {
      expect(pageEntityIds.has(rel.sourceEntityId)).toBe(true);
      expect(pageEntityIds.has(rel.targetEntityId)).toBe(true);
    }
  });

  it('all mode referential integrity holds across the full limit-sweep', async () => {
    // Run the same query at every limit from 1 through the full union size
    // and assert that, on every page, every relationship's endpoints are
    // present in the page's entities array.
    const baseSpec: TraversalSpec = {
      start: { entityType: 'Person' },
      steps: [{ direction: 'out', relationshipTypes: ['WORKS_AT'] }],
      returnMode: 'all',
    };

    for (const limit of [1, 2, 3, 5, 7, 8, 10, 14]) {
      const result = await executeFallbackTraversal(repoId, storage, { ...baseSpec, limit });
      const pageEntityIds = new Set(result.entities.map((e) => e.id));
      for (const rel of result.relationships ?? []) {
        expect(pageEntityIds.has(rel.sourceEntityId), `limit=${limit} sourceEntityId=${rel.sourceEntityId}`).toBe(true);
        expect(pageEntityIds.has(rel.targetEntityId), `limit=${limit} targetEntityId=${rel.targetEntityId}`).toBe(true);
      }
    }
  });
});
