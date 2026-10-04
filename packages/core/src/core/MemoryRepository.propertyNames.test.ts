// MemoryRepository — property and type names a provider could not store are
// refused at proposal time and on every write, whatever the provider.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepMemory } from './DeepMemory.js';
import type { MemoryRepository } from './MemoryRepository.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';

const REPO_ID = '71000000-0000-4000-a000-000000000001';

describe('MemoryRepository property and type names', () => {
  let storage: InMemoryStorageProvider;
  let repo: MemoryRepository;

  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    const memory = new DeepMemory({ storage, provenance: { actorId: 'tester', actorType: 'agent' } });
    await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Names',
      governance: { mode: 'open', deduplicationEnabled: false },
      vocabulary: {
        entityTypes: [
          { type: 'Event', description: 'An event', properties: [{ name: 'startDate', type: 'string', required: false }] },
        ],
        relationshipTypes: [
          { type: 'FOLLOWS', description: 'Comes after', allowedSourceTypes: ['Event'], allowedTargetTypes: ['Event'] },
        ],
      },
    });
    repo = await memory.openRepository(REPO_ID);
  });

  describe('proposals', () => {
    it.each(['start-date', 'label', 'createdInConversation', '_attempt', 'entityLabel'])(
      'rejects an entity type declaring property %j',
      async (name) => {
        const before = await storage.getVocabulary(REPO_ID);
        const result = await repo.proposeVocabularyChange({
          proposalType: 'entity_type',
          entityType: { type: 'Meeting', description: 'A meeting', properties: [{ name, type: 'string', required: false }] },
          justification: 'test',
        });
        expect(result.status).toBe('rejected');
        expect(result.reason).toContain(name);
        expect((await storage.getVocabulary(REPO_ID)).version).toBe(before.version);
      },
    );

    it.each(['start-date', 'label', 'sourceEntityId', 'bidirectional'])(
      'rejects a relationship type declaring property %j',
      async (name) => {
        const result = await repo.proposeVocabularyChange({
          proposalType: 'relationship_type',
          relationshipType: {
            type: 'PRECEDES',
            description: 'Comes before',
            allowedSourceTypes: ['Event'],
            allowedTargetTypes: ['Event'],
            properties: [{ name, type: 'string', required: false }],
          },
          justification: 'test',
        });
        expect(result.status).toBe('rejected');
        expect(result.reason).toContain(name);
      },
    );

    it('accepts a relationship property whose name is reserved only on entities', async () => {
      const result = await repo.proposeVocabularyChange({
        proposalType: 'relationship_type',
        relationshipType: {
          type: 'PRECEDES',
          description: 'Comes before',
          allowedSourceTypes: ['Event'],
          allowedTargetTypes: ['Event'],
          properties: [{ name: 'summary', type: 'string', required: false }],
        },
        justification: 'test',
      });
      expect(result.status).toBe('approved');
    });

    it('rejects an edit adding a reserved property', async () => {
      const result = await repo.proposeVocabularyChange({
        proposalType: 'edit_entity_type',
        editEntityType: { type: 'Event', addProperties: [{ name: 'slug', type: 'string', required: false }] },
        justification: 'test',
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('slug');
    });

    it('rejects a relationship type whose stored name would start with a digit', async () => {
      const result = await repo.proposeVocabularyChange({
        proposalType: 'relationship_type',
        relationshipType: {
          type: '2nd degree',
          description: 'Second-degree link',
          allowedSourceTypes: ['Event'],
          allowedTargetTypes: ['Event'],
        },
        justification: 'test',
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('2ND_DEGREE');
      const vocabulary = await storage.getVocabulary(REPO_ID);
      expect(vocabulary.relationshipTypes.map((rt) => rt.type)).toEqual(['FOLLOWS']);
    });

    it.each(['2ND_DEGREE', 'start-date', 'Board Meeting'])('rejects an entity type named %j', async (type) => {
      const result = await repo.proposeVocabularyChange({
        proposalType: 'entity_type',
        entityType: { type, description: 'A type' },
        justification: 'test',
      });
      expect(result.status).toBe('rejected');
      expect(result.reason).toMatch(/not a valid identifier/);
    });
  });

  describe('writes', () => {
    it.each(['start-date', 'label', 'createdBy', '_attempt'])(
      'refuses to create an entity with property %j and stores nothing',
      async (key) => {
        const createEntity = vi.spyOn(storage, 'createEntity');
        await expect(
          repo.createEntities([
            { entityType: 'Event', label: 'Good', properties: { startDate: '2026-10-02' } },
            { entityType: 'Event', label: 'Bad', properties: { [key]: 'x' } },
          ]),
        ).rejects.toMatchObject({ name: 'InvalidInputError', code: 'INVALID_INPUT', field: `properties.${key}` });
        expect(createEntity).not.toHaveBeenCalled();
      },
    );

    it('refuses an update setting a reserved property', async () => {
      const [event] = await repo.createEntities([{ entityType: 'Event', label: 'Launch' }]);
      const updateEntity = vi.spyOn(storage, 'updateEntity');
      await expect(repo.updateEntity(event!.id, { properties: { label: 'Renamed' } })).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        field: 'properties.label',
      });
      expect(updateEntity).not.toHaveBeenCalled();
    });

    it('allows an update removing a reserved property, leaving the system field alone', async () => {
      const [event] = await repo.createEntities([{ entityType: 'Event', label: 'Launch' }]);

      const updated = await repo.updateEntity(event!.id, { properties: { slug: null } });

      expect(updated.slug).toBe(event!.slug);
      expect(updated.properties).toEqual({});
    });

    it('refuses to create a relationship with a non-identifier or reserved property', async () => {
      const [a, b] = await repo.createEntities([
        { entityType: 'Event', label: 'A' },
        { entityType: 'Event', label: 'B' },
      ]);
      const createRelationship = vi.spyOn(storage, 'createRelationship');
      for (const key of ['start-date', 'sourceEntityId']) {
        await expect(
          repo.createRelationships([
            { relationshipType: 'FOLLOWS', sourceEntityId: b!.id, targetEntityId: a!.id, properties: { [key]: 'x' } },
          ]),
        ).rejects.toMatchObject({ code: 'INVALID_INPUT', field: `properties.${key}` });
      }
      expect(createRelationship).not.toHaveBeenCalled();
    });
  });

  describe('traversal projection', () => {
    it.each(['createdInConversation', 'createdBy', 'label', 'embedding', '_attempt'])(
      'refuses to project system field %j',
      async (name) => {
        await expect(
          repo.traverse({
            start: { entityType: 'Event' },
            returnMode: 'terminal',
            projection: { properties: [name] },
            limit: 10,
            includeProvenance: false,
          }),
        ).rejects.toMatchObject({ code: 'TRAVERSAL_VALIDATION_FAILED' });
      },
    );

    it('projects a user property', async () => {
      await repo.createEntities([{ entityType: 'Event', label: 'Launch', properties: { startDate: '2026-10-02' } }]);
      const result = await repo.traverse({
        start: { entityType: 'Event' },
        returnMode: 'terminal',
        projection: { properties: ['startDate'] },
        limit: 10,
      });
      expect(result.aggregations).toEqual([{ values: { startDate: '2026-10-02' } }]);
    });
  });
});
