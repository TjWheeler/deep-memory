import { describe, it, expect, beforeEach } from 'vitest';
import { VocabularyEngine } from './VocabularyEngine.js';
import { buildVocabulary, createEmptyVocabulary } from '../vocabulary/VocabularySchema.js';
import type { MemoryVocabulary, GovernanceConfig } from '../types/vocabulary.js';
import type { StorageProvider } from '../providers/StorageProvider.js';

/** Minimal mock StorageProvider — only implements vocabulary methods */
function createMockStorage(initialVocab: MemoryVocabulary): Partial<StorageProvider> {
  let vocab = initialVocab;
  return {
    async getVocabulary(_repositoryId: string) {
      // Return a copy to simulate a real storage provider
      return { ...vocab };
    },
    async saveVocabulary(_repositoryId: string, vocabulary: MemoryVocabulary) {
      vocab = vocabulary;
    },
    async deleteEntitiesByType(_repositoryId: string, _entityType: string) {
      return { deletedEntities: 3, deletedRelationships: 5 };
    },
    async deleteRelationshipsByType(_repositoryId: string, _relationshipType: string) {
      return { deletedRelationships: 2 };
    },
  };
}

describe('VocabularyEngine', () => {
  const testVocab = buildVocabulary(
    {
      entityTypes: [
        {
          type: 'person',
          description: 'A human person',
          properties: [
            { name: 'role', type: 'string', required: true },
            { name: 'age', type: 'number', required: false },
          ],
        },
        { type: 'project', description: 'A work project' },
      ],
      relationshipTypes: [
        {
          type: 'works_on',
          description: 'Person works on a project',
          allowedSourceTypes: ['person'],
          allowedTargetTypes: ['project'],
        },
      ],
    },
    'admin',
  );

  let engine: VocabularyEngine;
  let storage: Partial<StorageProvider>;

  beforeEach(() => {
    storage = createMockStorage(testVocab);
    engine = new VocabularyEngine({
      repositoryId: '20000000-0000-4000-a000-000000000001',
      storageProvider: storage as StorageProvider,
      governanceConfig: { mode: 'open' },
    });
  });

  describe('getVocabulary', () => {
    it('returns vocabulary from storage', async () => {
      const vocab = await engine.getVocabulary();
      expect(vocab.entityTypes).toHaveLength(2);
      expect(vocab.relationshipTypes).toHaveLength(1);
    });

    it('caches vocabulary', async () => {
      const v1 = await engine.getVocabulary();
      const v2 = await engine.getVocabulary();
      expect(v1).toBe(v2); // same reference — cached
    });

    it('invalidates cache', async () => {
      const v1 = await engine.getVocabulary();
      engine.invalidateCache();
      const v2 = await engine.getVocabulary();
      expect(v1).not.toBe(v2); // different reference — refetched
    });
  });

  describe('getResolvedVocabulary', () => {
    it('includes governance info', async () => {
      const resolved = await engine.getResolvedVocabulary();
      expect(resolved.governanceMode).toBe('open');
      expect(resolved.vocabulary.entityTypes).toHaveLength(2);
    });
  });

  describe('validateEntity', () => {
    it('passes valid entity', async () => {
      const result = await engine.validateEntity({
        entityType: 'person',
        label: 'Tim',
        properties: { role: 'engineer' },
      });
      expect(result.valid).toBe(true);
    });

    it('fails invalid entity type', async () => {
      const result = await engine.validateEntity({
        entityType: 'vehicle',
        label: 'Car',
      });
      expect(result.valid).toBe(false);
    });

    it('fails missing required property', async () => {
      const result = await engine.validateEntity({
        entityType: 'person',
        label: 'Tim',
        properties: {},
      });
      expect(result.valid).toBe(false);
    });
  });

  describe('validateEntityUpdate', () => {
    it('passes valid update', async () => {
      const result = await engine.validateEntityUpdate(
        { properties: { role: 'manager' } },
        'person',
      );
      expect(result.valid).toBe(true);
    });

    it('fails for unknown entity type', async () => {
      const result = await engine.validateEntityUpdate({ label: 'New' }, 'vehicle');
      expect(result.valid).toBe(false);
    });
  });

  describe('validateRelationship', () => {
    it('passes valid relationship', async () => {
      const result = await engine.validateRelationship(
        { relationshipType: 'works_on', sourceEntityId: 'p1', targetEntityId: 'p2' },
        'person',
        'project',
      );
      expect(result.valid).toBe(true);
    });

    it('fails invalid source type', async () => {
      const result = await engine.validateRelationship(
        { relationshipType: 'works_on', sourceEntityId: 'p1', targetEntityId: 'p2' },
        'project',
        'project',
      );
      expect(result.valid).toBe(false);
    });
  });

  describe('proposeExtension', () => {
    it('approves new entity type in open mode', async () => {
      const result = await engine.proposeExtension(
        {
          proposalType: 'entity_type',
          entityType: { type: 'team', description: 'A team of people' },
          justification: 'Need team support',
        },
        'agent',
      );
      expect(result.status).toBe('approved');
      expect(result.type).toBe('team');

      // Vocabulary should now contain the new type
      const vocab = await engine.getVocabulary();
      expect(vocab.entityTypes.find((et) => et.type === 'team')).toBeDefined();
    });

    it('rejects duplicate entity type', async () => {
      const result = await engine.proposeExtension(
        {
          proposalType: 'entity_type',
          entityType: { type: 'person', description: 'Another person type' },
          justification: 'Redundant',
        },
        'agent',
      );
      expect(result.status).toBe('rejected');
      expect(result.duplicates).toBeDefined();
      expect(result.duplicates!.length).toBeGreaterThan(0);
    });

    it('rejects all proposals in locked mode', async () => {
      const lockedEngine = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: storage as StorageProvider,
        governanceConfig: { mode: 'locked' },
      });

      const result = await lockedEngine.proposeExtension(
        {
          proposalType: 'entity_type',
          entityType: { type: 'team', description: 'A team' },
          justification: 'Need teams',
        },
        'agent',
      );
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('locked');
    });

    it('queues for approval in managed mode with requireApproval', async () => {
      const managedEngine = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: storage as StorageProvider,
        governanceConfig: { mode: 'managed', requireApproval: true },
      });

      const result = await managedEngine.proposeExtension(
        {
          proposalType: 'entity_type',
          entityType: { type: 'team', description: 'A team' },
          justification: 'Need teams',
        },
        'agent',
      );
      expect(result.status).toBe('pending_approval');
    });

    it('approves new relationship type', async () => {
      const result = await engine.proposeExtension(
        {
          proposalType: 'relationship_type',
          relationshipType: {
            type: 'mentors',
            description: 'Person mentors another person',
            allowedSourceTypes: ['person'],
            allowedTargetTypes: ['person'],
          },
          justification: 'Track mentoring relationships',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      expect(vocab.relationshipTypes.find((rt) => rt.type === 'MENTORS')).toBeDefined();
    });

    it('skips deduplication when disabled in open mode', async () => {
      const noDedupEngine = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: createMockStorage(testVocab) as StorageProvider,
        governanceConfig: { mode: 'open', deduplicationEnabled: false },
      });

      // This would normally be caught as duplicate
      const result = await noDedupEngine.proposeExtension(
        {
          proposalType: 'entity_type',
          entityType: { type: 'person', description: 'A person duplicate' },
          justification: 'Testing dedup off',
        },
        'agent',
      );
      // With dedup disabled, the exact-match still happens in the governor...
      // Actually the deduplicator is skipped entirely, so it goes straight through
      expect(result.status).toBe('approved');
    });
  });

  describe('proposeChange — edit', () => {
    it('edits entity type description', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'edit_entity_type',
          editEntityType: { type: 'person', description: 'An individual human being' },
          justification: 'Improve description',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      const person = vocab.entityTypes.find((et) => et.type === 'person');
      expect(person?.description).toBe('An individual human being');
    });

    it('adds properties to entity type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'edit_entity_type',
          editEntityType: {
            type: 'person',
            addProperties: [{ name: 'email', type: 'string', required: false }],
          },
          justification: 'Need email tracking',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      const person = vocab.entityTypes.find((et) => et.type === 'person');
      expect(person?.properties.find((p) => p.name === 'email')).toBeDefined();
      // Original properties still present
      expect(person?.properties.find((p) => p.name === 'role')).toBeDefined();
    });

    it('removes properties from entity type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'edit_entity_type',
          editEntityType: {
            type: 'person',
            removeProperties: ['age'],
          },
          justification: 'Age no longer tracked',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      const person = vocab.entityTypes.find((et) => et.type === 'person');
      expect(person?.properties.find((p) => p.name === 'age')).toBeUndefined();
      expect(person?.properties.find((p) => p.name === 'role')).toBeDefined();
    });

    it('updates properties on entity type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'edit_entity_type',
          editEntityType: {
            type: 'person',
            updateProperties: [{ name: 'role', type: 'string', required: false }],
          },
          justification: 'Role no longer required',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      const person = vocab.entityTypes.find((et) => et.type === 'person');
      const role = person?.properties.find((p) => p.name === 'role');
      expect(role?.required).toBe(false);
    });

    it('edits relationship type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'edit_relationship_type',
          editRelationshipType: {
            type: 'WORKS_ON',
            description: 'Updated description',
            bidirectional: true,
          },
          justification: 'Make bidirectional',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      const worksOn = vocab.relationshipTypes.find((rt) => rt.type === 'WORKS_ON');
      expect(worksOn?.description).toBe('Updated description');
      expect(worksOn?.bidirectional).toBe(true);
    });

    it('rejects edit for non-existent entity type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'edit_entity_type',
          editEntityType: { type: 'vehicle', description: 'A vehicle' },
          justification: 'Does not exist',
        },
        'agent',
      );
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('not found');
    });

    it('rejects edit in locked mode', async () => {
      const lockedEngine = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: storage as StorageProvider,
        governanceConfig: { mode: 'locked' },
      });

      const result = await lockedEngine.proposeChange(
        {
          proposalType: 'edit_entity_type',
          editEntityType: { type: 'person', description: 'Updated' },
          justification: 'Should fail',
        },
        'agent',
      );
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('locked');
    });
  });

  describe('proposeChange — delete', () => {
    it('deletes entity type and cascades', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'delete_entity_type',
          deleteEntityType: { type: 'project' },
          justification: 'No longer needed',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      expect(vocab.entityTypes.find((et) => et.type === 'project')).toBeUndefined();
      // person should still exist
      expect(vocab.entityTypes.find((et) => et.type === 'person')).toBeDefined();
    });

    it('deletes relationship type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'delete_relationship_type',
          deleteRelationshipType: { type: 'WORKS_ON' },
          justification: 'Replacing with different type',
        },
        'agent',
      );
      expect(result.status).toBe('approved');

      const vocab = await engine.getVocabulary();
      expect(vocab.relationshipTypes.find((rt) => rt.type === 'WORKS_ON')).toBeUndefined();
    });

    it('bumps major version on delete', async () => {
      const vocabBefore = await engine.getVocabulary();
      const majorBefore = parseInt(vocabBefore.version.split('.')[0]!, 10);

      await engine.proposeChange(
        {
          proposalType: 'delete_entity_type',
          deleteEntityType: { type: 'project' },
          justification: 'Testing version bump',
        },
        'agent',
      );

      const vocabAfter = await engine.getVocabulary();
      const majorAfter = parseInt(vocabAfter.version.split('.')[0]!, 10);
      expect(majorAfter).toBe(majorBefore + 1);
    });

    it('rejects delete for non-existent type', async () => {
      const result = await engine.proposeChange(
        {
          proposalType: 'delete_entity_type',
          deleteEntityType: { type: 'nonexistent' },
          justification: 'Does not exist',
        },
        'agent',
      );
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('not found');
    });

    it('rejects delete in locked mode', async () => {
      const lockedEngine = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: storage as StorageProvider,
        governanceConfig: { mode: 'locked' },
      });

      const result = await lockedEngine.proposeChange(
        {
          proposalType: 'delete_entity_type',
          deleteEntityType: { type: 'person' },
          justification: 'Should fail',
        },
        'agent',
      );
      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('locked');
    });
  });
});
