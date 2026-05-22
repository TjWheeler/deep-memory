import { describe, it, expect } from 'vitest';
import { Consolidator } from './Consolidator.js';
import type { ExtractionOutput } from '../types/extraction.js';
import type { EntityRegistry } from '../types/registry.js';

const minimalVocabulary = JSON.stringify({
  version: '1.0.0',
  lastModified: '2026-04-03T00:00:00Z',
  modifiedBy: 'test',
  entityTypes: [],
  relationshipTypes: [],
});

const config = {
  endpoint: 'http://localhost:8020/v1',
  model: 'test-model',
};

describe('Consolidator', () => {
  it('deduplicates entities across extraction outputs', async () => {
    const extraction1: ExtractionOutput = {
      source: 'doc1.md',
      sourcePath: '/docs/doc1.md',
      extractedAt: '2026-04-03T10:00:00Z',
      extractedBy: 'worker-1',
      entities: [
        {
          entityType: 'Equipment',
          label: 'Komatsu 930E',
          summary: 'Electric drive truck from doc1',
          properties: { operatingWeight: '292 MT' },
          aliases: ['930E'],
          sourceRefs: [{ description: 'Spec listing', lineStart: 10, lineEnd: 20 }],
        },
        {
          entityType: 'Equipment',
          label: 'Cat 793F',
          summary: 'Mining truck',
          properties: { payload: '227 t' },
          aliases: ['793F'],
          sourceRefs: [{ description: 'Truck specs', lineStart: 50, lineEnd: 60 }],
        },
      ],
      relationships: [
        {
          type: 'COMPATIBLE_WITH',
          sourceLabel: 'Komatsu 930E',
          targetLabel: 'Cat 793F',
          properties: { matchType: 'truck-shovel' },
          sourceRefs: [{ description: 'Matching table', lineStart: 100, lineEnd: 110 }],
        },
      ],
    };

    const extraction2: ExtractionOutput = {
      source: 'doc2.md',
      sourcePath: '/docs/doc2.md',
      extractedAt: '2026-04-03T10:05:00Z',
      extractedBy: 'worker-2',
      entities: [
        {
          entityType: 'Equipment',
          label: 'Komatsu 930E-4',
          summary: 'Electric drive truck from doc2, more detail here',
          properties: { enginePower: '1864 kW' },
          aliases: ['930E', 'Komatsu 930E'],
          sourceRefs: [{ description: 'Performance data', lineStart: 200, lineEnd: 220 }],
        },
        {
          entityType: 'Fluid',
          label: 'SAE 15W-40',
          summary: 'Engine oil',
          properties: {},
          aliases: [],
          sourceRefs: [{ description: 'Fluid specs', lineStart: 300, lineEnd: 310 }],
        },
      ],
      relationships: [],
    };

    const consolidator = new Consolidator(config, minimalVocabulary);
    const result = await consolidator.consolidate([extraction1, extraction2], undefined, 'test-repo');

    // Should have 3 unique entities: Komatsu 930E (merged), Cat 793F, SAE 15W-40
    expect(result.archive.entities).toHaveLength(3);
    expect(result.registry.entities).toHaveLength(3);

    // The merged entity should have the longer summary (from doc2)
    const komatsu = result.archive.entities.find(e => e.label.includes('930E'));
    expect(komatsu).toBeDefined();
    expect(komatsu!.summary).toContain('more detail');

    // Relationship should be resolved
    expect(result.archive.relationships).toHaveLength(1);
    expect(result.archive.relationships[0]!.sourceEntityId).toBeDefined();
    expect(result.archive.relationships[0]!.targetEntityId).toBeDefined();

    // Report should show merges
    expect(result.report.entitiesMerged).toBeGreaterThan(0);
    expect(result.report.entitiesNew).toBe(3);
  });

  it('merges with an existing registry', async () => {
    const existingRegistry: EntityRegistry = {
      version: '1.0.0',
      repositoryId: 'test-repo',
      lastUpdated: '2026-04-03T09:00:00Z',
      entities: [
        {
          id: 'existing-uuid-1',
          slug: 'Equipment:komatsu-930e',
          entityType: 'Equipment',
          label: 'Komatsu 930E',
          status: 'imported',
          aliases: ['930E'],
          sourceDocuments: ['old-doc.md'],
        },
      ],
    };

    const extraction: ExtractionOutput = {
      source: 'new-doc.md',
      sourcePath: '/docs/new-doc.md',
      extractedAt: '2026-04-03T10:00:00Z',
      extractedBy: 'worker-1',
      entities: [
        {
          entityType: 'Equipment',
          label: 'Komatsu 930E',
          summary: 'Updated description',
          properties: { newProp: 'value' },
          aliases: [],
          sourceRefs: [],
        },
        {
          entityType: 'Equipment',
          label: 'Cat 797F',
          summary: 'New truck',
          properties: {},
          aliases: ['797F'],
          sourceRefs: [],
        },
      ],
      relationships: [],
    };

    const consolidator = new Consolidator(config, minimalVocabulary);
    const result = await consolidator.consolidate([extraction], existingRegistry, 'test-repo');

    // Should reuse existing UUID for Komatsu 930E
    const komatsuEntry = result.registry.entities.find(e => e.label === 'Komatsu 930E');
    expect(komatsuEntry).toBeDefined();
    expect(komatsuEntry!.id).toBe('existing-uuid-1');
    expect(komatsuEntry!.sourceDocuments).toContain('new-doc.md');

    // Cat 797F should get a new UUID
    const catEntry = result.registry.entities.find(e => e.label === 'Cat 797F');
    expect(catEntry).toBeDefined();
    expect(catEntry!.id).not.toBe('existing-uuid-1');

    // Total: 2 entities in registry (1 existing updated + 1 new)
    expect(result.registry.entities).toHaveLength(2);
  });

  it('skips relationships with unresolvable labels', async () => {
    const extraction: ExtractionOutput = {
      source: 'doc.md',
      sourcePath: '/docs/doc.md',
      extractedAt: '',
      extractedBy: 'worker',
      entities: [
        {
          entityType: 'Equipment',
          label: 'Cat 793F',
          properties: {},
          aliases: [],
          sourceRefs: [],
        },
      ],
      relationships: [
        {
          type: 'COMPATIBLE_WITH',
          sourceLabel: 'Cat 793F',
          targetLabel: 'Unknown Entity',
          properties: {},
          sourceRefs: [],
        },
      ],
    };

    const consolidator = new Consolidator(config, minimalVocabulary);
    const result = await consolidator.consolidate([extraction], undefined, 'test-repo');

    expect(result.archive.relationships).toHaveLength(0);
    expect(result.report.relationshipsSkipped).toBe(1);
  });

  it('generates valid provenance on all entities', async () => {
    const extraction: ExtractionOutput = {
      source: 'doc.md',
      sourcePath: '/docs/doc.md',
      extractedAt: '',
      extractedBy: 'worker',
      entities: [
        { entityType: 'Equipment', label: 'Test Equipment', properties: {}, aliases: [], sourceRefs: [] },
      ],
      relationships: [],
    };

    const consolidator = new Consolidator(config, minimalVocabulary);
    const result = await consolidator.consolidate([extraction], undefined, 'test-repo');

    const entity = result.archive.entities[0]!;
    expect(entity.provenance.createdBy).toBe('indexer-consolidator');
    expect(entity.provenance.createdByType).toBe('agent');
    expect(entity.provenance.createdAt).toBeTruthy();
  });
});
