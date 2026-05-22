// SearchOrchestrator — tests for entity finding and concept search

import { describe, it, expect, beforeEach } from 'vitest';
import { SearchOrchestrator } from './SearchOrchestrator.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import { InMemorySearchProvider } from '../providers-builtin/InMemorySearchProvider.js';
import { EventBus } from '../core/EventBus.js';
import { buildVocabulary } from '../vocabulary/VocabularySchema.js';
import type { StoredEntity } from '../types/entities.js';
import type { Provenance } from '../types/provenance.js';
import type { EmbeddingProvider } from '../providers/EmbeddingProvider.js';

function makeProvenance(): Provenance {
  const now = new Date().toISOString();
  return {
    createdBy: 'test', createdByType: 'agent', createdAt: now,
    modifiedBy: 'test', modifiedByType: 'agent', modifiedAt: now,
  };
}

function makeEntity(id: string, type: string, label: string, summary?: string): StoredEntity {
  return { id, slug: id, entityType: type, label, summary, properties: {}, provenance: makeProvenance() };
}

/** Fake embedding provider that creates simple hash-based "embeddings" for testing */
function createFakeEmbeddingProvider(): EmbeddingProvider {
  const dim = 8;

  function simpleHash(text: string): number[] {
    const vec = new Array(dim).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % dim] += text.charCodeAt(i) / 256;
    }
    // Normalise
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return mag > 0 ? vec.map((v: number) => v / mag) : vec;
  }

  return {
    async embed(text: string) { return simpleHash(text); },
    async embedBatch(texts: string[]) { return texts.map(simpleHash); },
    dimensions() { return dim; },
    modelId() { return 'fake-test-model'; },
  };
}

describe('SearchOrchestrator', () => {
  let storage: InMemoryStorageProvider;
  const repoId = '50000000-0000-4000-a000-000000000001';

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
        { type: 'note', description: 'A note' },
        { type: 'person', description: 'A person' },
      ],
    }, 'test'));

    await storage.createEntity(repoId, makeEntity('note:meeting', 'note', 'Meeting Notes', 'Discussed project timeline and deliverables'));
    await storage.createEntity(repoId, makeEntity('note:code-review', 'note', 'Code Review', 'Reviewed pull request for auth module'));
    await storage.createEntity(repoId, makeEntity('person:alice', 'person', 'Alice Smith', 'Senior engineer'));
  });

  // ─── findEntities (storage only) ────────────────────────────

  describe('findEntities without SearchProvider', () => {
    it('finds by search term', async () => {
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage });
      const result = await orch.findEntities({ searchTerm: 'meeting' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe('note:meeting');
    });

    it('finds by entity type', async () => {
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage });
      const result = await orch.findEntities({ entityTypes: ['person'] });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].entityType).toBe('person');
    });

    it('returns empty for no matches', async () => {
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage });
      const result = await orch.findEntities({ searchTerm: 'nonexistent' });
      expect(result.items).toHaveLength(0);
    });

    it('paginates results', async () => {
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage });
      const page1 = await orch.findEntities({ limit: 1, offset: 0 });
      expect(page1.items).toHaveLength(1);
      expect(page1.hasMore).toBe(true);

      const page2 = await orch.findEntities({ limit: 1, offset: 1 });
      expect(page2.items).toHaveLength(1);
      expect(page2.items[0].id).not.toBe(page1.items[0].id);
    });
  });

  // ─── findEntities (with SearchProvider) ─────────────────────

  describe('findEntities with SearchProvider', () => {
    it('merges search and storage results', async () => {
      const search = new InMemorySearchProvider();
      // Index entities in search provider
      await search.indexEntity(repoId, { entityId: 'note:meeting', entityType: 'note', label: 'Meeting Notes', summary: 'Discussed project timeline' });
      await search.indexEntity(repoId, { entityId: 'note:code-review', entityType: 'note', label: 'Code Review', summary: 'Reviewed PR' });

      const orch = new SearchOrchestrator({ repositoryId: repoId, storage, search });
      const result = await orch.findEntities({ searchTerm: 'project timeline' });

      // Meeting Notes should rank higher (matches the search term better)
      expect(result.items.length).toBeGreaterThanOrEqual(1);
      expect(result.items[0].id).toBe('note:meeting');
    });
  });

  // ─── searchByConcept ────────────────────────────────────────

  describe('searchByConcept', () => {
    it('throws when no embedding provider', async () => {
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage });
      await expect(orch.searchByConcept('anything')).rejects.toThrow('EmbeddingProvider required');
    });

    it('returns scored entities with embedding provider', async () => {
      const embedding = createFakeEmbeddingProvider();
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage, embedding });

      // Our fake embeddings won't produce great similarity scores,
      // but with threshold 0 we can verify the mechanism works
      const result = await orch.searchByConcept('meeting notes', {
        similarityThreshold: 0,
      });

      expect(result.items.length).toBeGreaterThanOrEqual(1);
      for (const item of result.items) {
        expect(item.score).toBeGreaterThanOrEqual(0);
        expect(item.id).toBeTruthy();
      }
    });

    it('filters by entity type', async () => {
      const embedding = createFakeEmbeddingProvider();
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage, embedding });

      const result = await orch.searchByConcept('something', {
        entityTypes: ['person'],
        similarityThreshold: 0,
      });

      for (const item of result.items) {
        expect(item.entityType).toBe('person');
      }
    });

    it('respects similarity threshold', async () => {
      const embedding = createFakeEmbeddingProvider();
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage, embedding });

      const highThreshold = await orch.searchByConcept('meeting', {
        similarityThreshold: 0.999,
      });

      const lowThreshold = await orch.searchByConcept('meeting', {
        similarityThreshold: 0,
      });

      expect(lowThreshold.items.length).toBeGreaterThanOrEqual(highThreshold.items.length);
    });
  });

  // ─── Events ──────────────────────────────────────────────────

  describe('search events', () => {
    it('emits search:executed event', async () => {
      const eventBus = new EventBus({ actorId: 'test', actorType: 'agent' }, repoId);
      const events: string[] = [];
      eventBus.on('search:executed', (e) => { events.push(e.payload.query); });

      const orch = new SearchOrchestrator({ repositoryId: repoId, storage, eventBus });
      await orch.findEntities({ searchTerm: 'meeting' });

      expect(events).toEqual(['meeting']);
    });

    it('emits event for concept search', async () => {
      const eventBus = new EventBus({ actorId: 'test', actorType: 'agent' }, repoId);
      const events: string[] = [];
      eventBus.on('search:executed', (e) => { events.push(e.payload.query); });

      const embedding = createFakeEmbeddingProvider();
      const orch = new SearchOrchestrator({ repositoryId: repoId, storage, embedding, eventBus });
      await orch.searchByConcept('hello', { similarityThreshold: 0 });

      expect(events).toEqual(['hello']);
    });
  });
});
