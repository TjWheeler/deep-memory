// DeepMemory + MemoryRepository — end-to-end integration tests

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from './DeepMemory.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import { InMemorySearchProvider } from '../providers-builtin/InMemorySearchProvider.js';
import type { MemoryRepository } from './MemoryRepository.js';

describe('DeepMemory', () => {
  let memory: DeepMemory;

  beforeEach(() => {
    memory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });
  });

  // ─── Repository Lifecycle ─────────────────────────────────────

  describe('repository lifecycle', () => {
    it('creates and opens a repository', async () => {
      const repo = await memory.createRepository({
        repositoryId: '00000000-0000-4000-a000-000000000001',
        label: 'Test Repository',
        governance: { mode: 'open' },
      });
      expect(repo.repositoryId).toBe('00000000-0000-4000-a000-000000000001');

      const reopened = await memory.openRepository('00000000-0000-4000-a000-000000000001');
      expect(reopened.repositoryId).toBe('00000000-0000-4000-a000-000000000001');
    });

    it('lists repositories', async () => {
      await memory.createRepository({ repositoryId: '00000000-0000-4000-a000-000000000002', label: 'Repo 1' });
      await memory.createRepository({ repositoryId: '00000000-0000-4000-a000-000000000003', label: 'Repo 2' });

      const list = await memory.listRepositories();
      expect(list.items).toHaveLength(2);
    });

    it('deletes a repository', async () => {
      await memory.createRepository({ repositoryId: '00000000-0000-4000-a000-000000000004', label: 'Doomed' });
      await memory.deleteRepository('00000000-0000-4000-a000-000000000004');
      const list = await memory.listRepositories();
      expect(list.items).toHaveLength(0);
    });

    it('throws when opening non-existent repository', async () => {
      await expect(memory.openRepository('ffffffff-ffff-4fff-afff-ffffffffffff')).rejects.toThrow('not found');
    });

    it('rejects non-UUID repositoryId on open', async () => {
      await expect(memory.openRepository('nope')).rejects.toThrow('not a valid UUID');
    });

    it('emits repository lifecycle events', async () => {
      const events: string[] = [];
      memory.on('repository:created', (e) => { events.push('created'); });
      memory.on('repository:deleted', (e) => { events.push('deleted'); });

      await memory.createRepository({ repositoryId: '00000000-0000-4000-a000-000000000005', label: 'Evented' });
      await memory.deleteRepository('00000000-0000-4000-a000-000000000005');

      expect(events).toEqual(['created', 'deleted']);
    });

    it('rejects non-UUID repositoryId', async () => {
      await expect(
        memory.createRepository({ repositoryId: 'not-a-uuid', label: 'Bad' }),
      ).rejects.toThrow('not a valid UUID');
    });
  });

  // ─── Dispose ─────────────────────────────────────────────────

  it('disposes cleanly', async () => {
    await memory.createRepository({ repositoryId: '00000000-0000-4000-a000-000000000006', label: 'X' });
    await memory.dispose();
    // After dispose, storage is cleared — should fail to open
    await expect(memory.openRepository('00000000-0000-4000-a000-000000000006')).rejects.toThrow();
  });
});

describe('MemoryRepository', () => {
  let memory: DeepMemory;
  let repo: MemoryRepository;

  const vocabulary = {
    entityTypes: [
      { type: 'person', description: 'A person' },
      { type: 'company', description: 'A company' },
    ],
    relationshipTypes: [
      {
        type: 'works_at',
        description: 'Employment relationship',
        allowedSourceTypes: ['person'],
        allowedTargetTypes: ['company'],
      },
      {
        type: 'knows',
        description: 'Personal acquaintance',
        allowedSourceTypes: ['person'],
        allowedTargetTypes: ['person'],
        bidirectional: true,
      },
    ],
  };

  beforeEach(async () => {
    memory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });

    repo = await memory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000001',
      label: 'Test Repository',
      vocabulary,
      governance: { mode: 'open' },
    });
  });

  // ─── Vocabulary ───────────────────────────────────────────────

  describe('vocabulary', () => {
    it('returns the resolved vocabulary', async () => {
      const resolved = await repo.getVocabulary();
      expect(resolved.vocabulary.entityTypes).toHaveLength(2);
      expect(resolved.vocabulary.relationshipTypes).toHaveLength(2);
      expect(resolved.governanceMode).toBe('open');
    });
  });

  // ─── Entity CRUD ──────────────────────────────────────────────

  describe('entity CRUD', () => {
    it('creates an entity', async () => {
      const [entity] = await repo.createEntities([{
        entityType: 'person',
        label: 'John Smith',
        summary: 'Example person entity',
      }]);
      expect(entity.id).toBeTruthy();
      expect(entity.slug).toBe('person:john-smith');
      expect(entity.label).toBe('John Smith');
      expect(entity.provenance.createdBy).toBe('test-agent');
    });

    it('auto-generates deterministic slugs', async () => {
      const [e1] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      expect(e1.slug).toBe('person:alice');
      expect(e1.id).toBeTruthy();
    });

    it('handles slug collisions', async () => {
      await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [e2] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      expect(e2.slug).toBe('person:alice-2');
      expect(e2.id).not.toBe((await repo.findEntities({ searchTerm: 'Alice' })).items[0].id);
    });

    it('uses explicit entity IDs', async () => {
      const [entity] = await repo.createEntities([{
        id: 'my-custom-id',
        entityType: 'person',
        label: 'Custom',
      }]);
      expect(entity.id).toBe('my-custom-id');
    });

    it('updates an entity', async () => {
      const [created] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
      }]);

      const updated = await repo.updateEntity(created.id, {
        label: 'Timothy',
        summary: 'Updated summary',
      });
      expect(updated.label).toBe('Timothy');
      expect(updated.summary).toBe('Updated summary');
    });

    it('clears summary, data, and dataFormat when null is passed', async () => {
      const [created] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
        summary: 'Original summary',
        data: 'Raw bio text',
        dataFormat: 'text/plain',
      }]);

      const updated = await repo.updateEntity(created.id, {
        summary: null,
        data: null,
        dataFormat: null,
      });
      expect(updated.summary).toBeUndefined();
      expect(updated.data).toBeUndefined();
      expect(updated.dataFormat).toBeUndefined();
    });

    it('deletes property keys when their value is null (RFC 7396 merge)', async () => {
      const [created] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
        properties: { role: 'founder', city: 'Auckland', age: 42 },
      }]);

      const updated = await repo.updateEntity(created.id, {
        properties: { role: null, city: 'Wellington' },
      });
      expect(updated.properties).toEqual({ city: 'Wellington', age: 42 });
    });

    it('preserves summary/data/dataFormat when the field is omitted', async () => {
      const [created] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
        summary: 'Keep me',
        data: 'Keep me too',
        dataFormat: 'text/plain',
      }]);

      const updated = await repo.updateEntity(created.id, { label: 'Timothy' });
      expect(updated.summary).toBe('Keep me');
      expect(updated.data).toBe('Keep me too');
      expect(updated.dataFormat).toBe('text/plain');
    });

    it('regenerates slug when label changes', async () => {
      const [created] = await repo.createEntities([{ entityType: 'person', label: 'Tim' }]);
      expect(created.slug).toBe('person:tim');

      const updated = await repo.updateEntity(created.id, { label: 'Timothy' });
      expect(updated.slug).toBe('person:timothy');

      // Entity is lookupable by the new slug and no longer by the old one.
      expect(await repo.getBySlug('person:timothy')).not.toBeNull();
      expect(await repo.getBySlug('person:tim')).toBeNull();
    });

    it('changes entityType and regenerates slug with new prefix', async () => {
      const [created] = await repo.createEntities([{ entityType: 'person', label: 'Acme' }]);
      expect(created.slug).toBe('person:acme');

      const updated = await repo.updateEntity(created.id, { entityType: 'company' });
      expect(updated.entityType).toBe('company');
      expect(updated.slug).toBe('company:acme');

      // Slug index is updated
      expect(await repo.getBySlug('company:acme')).not.toBeNull();
      expect(await repo.getBySlug('person:acme')).toBeNull();

      // Persisted type is reflected in find-by-type
      const byType = await repo.findEntities({ entityTypes: ['company'] });
      expect(byType.items.some((e) => e.id === created.id)).toBe(true);
    });

    it('rejects an entityType change to a type not in the vocabulary', async () => {
      const [created] = await repo.createEntities([{ entityType: 'person', label: 'Tim' }]);
      await expect(
        repo.updateEntity(created.id, { entityType: 'spaceship' }),
      ).rejects.toThrow('Vocabulary validation failed');
    });

    it('handles slug collisions when changing entityType', async () => {
      // A company already at slug "company:acme"
      await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

      // A person with the same slugified label, at "person:acme"
      const [person] = await repo.createEntities([{ entityType: 'person', label: 'Acme' }]);
      expect(person.slug).toBe('person:acme');

      // Changing the person to a company must dedupe against the existing company slug.
      const updated = await repo.updateEntity(person.id, { entityType: 'company' });
      expect(updated.entityType).toBe('company');
      expect(updated.slug).toBe('company:acme-2');
    });

    it('gets entity at different detail levels', async () => {
      const [created] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
        data: 'Full biography...',
        dataFormat: 'text/plain',
      }]);

      const full = await repo.getEntity(created.id, 'full');
      expect(full).toHaveProperty('data', 'Full biography...');
      expect(full).toHaveProperty('provenance');

      const summary = await repo.getEntity(created.id, 'summary');
      expect(summary).toHaveProperty('properties');
      expect(summary).not.toHaveProperty('data');

      const brief = await repo.getEntity(created.id, 'brief');
      expect(brief).toHaveProperty('label');
      expect(brief).not.toHaveProperty('properties');
    });

    it('batch retrieves entities', async () => {
      const [a] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [b] = await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);

      const map = await repo.getEntities([a.id, b.id, 'missing']);
      expect(map.size).toBe(2);
    });

    it('finds entities', async () => {
      await repo.createEntities([{ entityType: 'person', label: 'Alice Smith' }]);
      await repo.createEntities([{ entityType: 'person', label: 'Bob Jones' }]);
      await repo.createEntities([{ entityType: 'company', label: 'Acme Corp' }]);

      const result = await repo.findEntities({ searchTerm: 'alice' });
      expect(result.items).toHaveLength(1);
      expect(result.items[0].label).toBe('Alice Smith');
    });

    it('deletes an entity', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Doomed' }]);
      await repo.deleteEntities([entity.id]);
      expect(await repo.getEntity(entity.id)).toBeNull();
    });

    it('rejects invalid entity types', async () => {
      await expect(
        repo.createEntities([{ entityType: 'spaceship', label: 'USS Enterprise' }]),
      ).rejects.toThrow('Vocabulary validation failed');
    });
  });

  // ─── Provenance ───────────────────────────────────────────────

  describe('provenance', () => {
    it('stamps creation provenance', async () => {
      const [entity] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
      }]);
      expect(entity.provenance.createdBy).toBe('test-agent');
      expect(entity.provenance.createdByType).toBe('agent');
      expect(entity.provenance.createdAt).toBeTruthy();
    });

    it('stamps update provenance', async () => {
      const [created] = await repo.createEntities([{
        entityType: 'person',
        label: 'Tim',
      }]);

      // Small delay to ensure timestamps differ
      await new Promise((r) => setTimeout(r, 5));

      const updated = await repo.updateEntity(created.id, { label: 'Timothy' });

      expect(updated.provenance.createdBy).toBe('test-agent');
      expect(updated.provenance.modifiedBy).toBe('test-agent');
      // modifiedAt should be later than createdAt
      expect(new Date(updated.provenance.modifiedAt).getTime())
        .toBeGreaterThan(new Date(updated.provenance.createdAt).getTime());
    });

    it('respects provenance context updates', async () => {
      memory.updateProvenance({ conversationId: 'conv-123' });

      const [entity] = await repo.createEntities([{
        entityType: 'person',
        label: 'Alice',
      }]);
      expect(entity.provenance.createdInConversation).toBe('conv-123');
    });
  });

  // ─── Events ───────────────────────────────────────────────────

  describe('events', () => {
    it('fires entity lifecycle events', async () => {
      const events: string[] = [];
      repo.on('entity:created', () => { events.push('created'); });
      repo.on('entity:updated', () => { events.push('updated'); });
      repo.on('entity:deleted', () => { events.push('deleted'); });

      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Tim' }]);
      await repo.updateEntity(entity.id, { label: 'Timothy' });
      await repo.deleteEntities([entity.id]);

      expect(events).toEqual(['created', 'updated', 'deleted']);
    });

    it('fires relationship lifecycle events', async () => {
      const events: string[] = [];
      repo.on('relationship:created', () => { events.push('created'); });
      repo.on('relationship:removed', () => { events.push('removed'); });

      const [a] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [b] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);
      const [rel] = await repo.createRelationships([{
        relationshipType: 'works_at',
        sourceEntityId: a.id,
        targetEntityId: b.id,
      }]);
      await repo.removeRelationships([rel.id]);

      expect(events).toEqual(['created', 'removed']);
    });

    it('unsubscribes from events', async () => {
      let count = 0;
      const unsub = repo.on('entity:created', () => { count++; });

      await repo.createEntities([{ entityType: 'person', label: 'A' }]);
      unsub();
      await repo.createEntities([{ entityType: 'person', label: 'B' }]);

      expect(count).toBe(1);
    });
  });

  // ─── Hooks ────────────────────────────────────────────────────

  describe('pre-mutation hooks', () => {
    it('cancels entity creation via hook', async () => {
      repo.onHook('entity:creating', () => ({
        cancel: true,
        reason: 'No new entities allowed',
      }));

      await expect(
        repo.createEntities([{ entityType: 'person', label: 'Blocked' }]),
      ).rejects.toThrow('No new entities allowed');
    });

    it('cancels entity update via hook', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Tim' }]);

      repo.onHook('entity:updating', () => ({
        cancel: true,
        reason: 'Read only',
      }));

      await expect(
        repo.updateEntity(entity.id, { label: 'Timothy' }),
      ).rejects.toThrow('Read only');
    });

    it('cancels entity deletion via hook', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Protected' }]);

      repo.onHook('entity:deleting', () => ({
        cancel: true,
        reason: 'Cannot delete',
      }));

      await expect(repo.deleteEntities([entity.id])).rejects.toThrow('Cannot delete');
      // Entity should still exist
      expect(await repo.getEntity(entity.id)).not.toBeNull();
    });

    it('cancels relationship creation via hook', async () => {
      const [a] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [b] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

      repo.onHook('relationship:creating', () => ({
        cancel: true,
        reason: 'No relationships',
      }));

      await expect(
        repo.createRelationships([{
          relationshipType: 'works_at',
          sourceEntityId: a.id,
          targetEntityId: b.id,
        }]),
      ).rejects.toThrow('No relationships');
    });
  });

  // ─── Relationships ────────────────────────────────────────────

  describe('relationships', () => {
    it('creates a relationship between entities', async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

      const [rel] = await repo.createRelationships([{
        relationshipType: 'works_at',
        sourceEntityId: alice.id,
        targetEntityId: acme.id,
      }]);

      expect(rel.relationshipType).toBe('WORKS_AT');
      expect(rel.sourceEntityId).toBe(alice.id);
      expect(rel.targetEntityId).toBe(acme.id);
    });

    it('rejects invalid relationship constraints', async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

      // works_at only allows person → company, not company → person
      await expect(
        repo.createRelationships([{
          relationshipType: 'works_at',
          sourceEntityId: acme.id,
          targetEntityId: alice.id,
        }]),
      ).rejects.toThrow('Vocabulary validation failed');
    });

    it('gets relationships for an entity', async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);
      await repo.createRelationships([{
        relationshipType: 'works_at',
        sourceEntityId: alice.id,
        targetEntityId: acme.id,
      }]);

      const rels = await repo.getRelationships(alice.id);
      expect(rels.items).toHaveLength(1);
    });

    it('removes relationships', async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);
      const [globex] = await repo.createEntities([{ entityType: 'company', label: 'Globex' }]);
      const [rel1] = await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: alice.id, targetEntityId: acme.id }]);
      const [rel2] = await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: alice.id, targetEntityId: globex.id }]);

      const result = await repo.removeRelationships([rel1.id, rel2.id]);
      expect(result.removed).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      const rels = await repo.getRelationships(alice.id);
      expect(rels.items).toHaveLength(0);
    });

    it('reports not-found ids in failed without throwing', async () => {
      const result = await repo.removeRelationships(['nonexistent-id']);
      expect(result.removed).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
    });
  });

  // ─── Relationship Summary ───────────────────────────────────

  describe('relationship summary', () => {
    it('returns aggregated relationship counts', async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [bob] = await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);
      const [globex] = await repo.createEntities([{ entityType: 'company', label: 'Globex' }]);

      await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: alice.id, targetEntityId: acme.id }]);
      await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: alice.id, targetEntityId: globex.id }]);
      await repo.createRelationships([{ relationshipType: 'knows', sourceEntityId: bob.id, targetEntityId: alice.id }]);

      const summary = await repo.getRelationshipSummary(alice.id);
      expect(summary.outbound['WORKS_AT']).toBe(2);
      // 'knows' is bidirectional so alice appears as target, counted as inbound
      expect(summary.inbound['KNOWS']).toBe(1);
    });

    it('returns empty summary for entity with no relationships', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Lonely' }]);
      const summary = await repo.getRelationshipSummary(entity.id);
      expect(summary.outbound).toEqual({});
      expect(summary.inbound).toEqual({});
    });
  });

  // ─── Batch Relationship Fetch ─────────────────────────────

  describe('getRelationshipsForEntities', () => {
    it('returns deduplicated relationships for multiple entities', async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [bob] = await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

      await repo.createRelationships([{ relationshipType: 'knows', sourceEntityId: alice.id, targetEntityId: bob.id }]);
      await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: alice.id, targetEntityId: acme.id }]);
      await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: bob.id, targetEntityId: acme.id }]);

      // Fetch for alice + bob — the knows relationship should appear once, not twice
      const rels = await repo.getRelationshipsForEntities([alice.id, bob.id]);
      expect(rels).toHaveLength(3);

      const ids = rels.map(r => r.id);
      expect(new Set(ids).size).toBe(3); // no duplicates
    });

    it('returns empty array for no entity IDs', async () => {
      const rels = await repo.getRelationshipsForEntities([]);
      expect(rels).toEqual([]);
    });
  });

  // ─── Graph Traversal ─────────────────────────────────────────

  describe('graph traversal', () => {
    let aliceId: string;
    let acmeId: string;

    beforeEach(async () => {
      const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      const [bob] = await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);
      const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme Corp' }]);
      aliceId = alice.id;
      acmeId = acme.id;

      await repo.createRelationships([{
        relationshipType: 'knows',
        sourceEntityId: alice.id,
        targetEntityId: bob.id,
      }]);
      await repo.createRelationships([{
        relationshipType: 'works_at',
        sourceEntityId: bob.id,
        targetEntityId: acme.id,
      }]);
    });

    it('explores neighborhood', async () => {
      const result = await repo.exploreNeighborhood(aliceId, { depth: 1 });
      expect(result.center.label).toBe('Alice');
      expect(result.layers).toHaveLength(1);
      expect(result.statistics.totalEntities).toBe(1);
    });

    it('explores deeper neighborhood', async () => {
      const result = await repo.exploreNeighborhood(aliceId, { depth: 2 });
      expect(result.layers.length).toBe(2);
    });

    it('finds paths between entities', async () => {
      const result = await repo.findPaths(aliceId, acmeId);
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0].length).toBe(2);
      expect(result.paths[0].entities).toHaveLength(3);
    });
  });

  // ─── Timeline ─────────────────────────────────────────────────

  describe('timeline', () => {
    it('returns timeline for an entity', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Tim' }]);
      const timeline = await repo.getTimeline(entity.id);
      expect(timeline.id).toBe(entity.id);
      expect(timeline.events.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── Stats ────────────────────────────────────────────────────

  describe('stats', () => {
    it('returns repository stats', async () => {
      await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
      await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);
      await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

      const stats = await repo.getStats();
      expect(stats.entityCount).toBe(3);
      expect(stats.entityTypeBreakdown['person']).toBe(2);
      expect(stats.entityTypeBreakdown['company']).toBe(1);
    });
  });
});

describe('DeepMemory with SearchProvider', () => {
  it('indexes entities for search', async () => {
    const search = new InMemorySearchProvider();
    const memory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      search,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });

    const repo = await memory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000007',
      label: 'Search Test',
      vocabulary: {
        entityTypes: [{ type: 'note', description: 'A note' }],
      },
      governance: { mode: 'open' },
    });

    await repo.createEntities([{
      entityType: 'note',
      label: 'Meeting Notes',
      summary: 'Discussed project timeline and deliverables',
    }]);
    await repo.createEntities([{
      entityType: 'note',
      label: 'Code Review',
      summary: 'Reviewed pull request for authentication module',
    }]);

    // Search via the search provider directly
    const results = await search.search('00000000-0000-4000-a000-000000000007', 'timeline deliverables');
    expect(results.items).toHaveLength(1);
    expect(results.items[0].id).toBeDefined();
  });
});
