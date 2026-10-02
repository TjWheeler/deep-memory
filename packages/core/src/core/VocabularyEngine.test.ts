import { describe, it, expect, beforeEach } from 'vitest';
import { VocabularyEngine } from './VocabularyEngine.js';
import {
  buildVocabulary,
  createEntityTypeDefinition,
  incrementVersion,
} from '../vocabulary/VocabularySchema.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { StorageProvider, VocabularyReadOptions } from '../providers/StorageProvider.js';
import { InvalidInputError, VocabularyVersionConflictError } from './errors.js';

interface MockStorageHooks {
  /** Ordered log of storage method names, for asserting call order and attempt counts */
  calls?: string[];
  /**
   * Simulates another process writing between this engine's read and its write.
   * Called after each `getVocabulary` snapshot is taken, with the 1-based read
   * number and the stored vocabulary; a returned vocabulary replaces the stored one.
   */
  concurrentWrite?: (readNumber: number, stored: MemoryVocabulary) => MemoryVocabulary | undefined;
}

/** Minimal mock StorageProvider — only implements vocabulary methods, with compare-and-set saves */
function createMockStorage(
  initialVocab: MemoryVocabulary,
  hooks: MockStorageHooks = {},
): Partial<StorageProvider> {
  let vocab = initialVocab;
  let reads = 0;
  const calls = hooks.calls;
  return {
    async getVocabulary(_repositoryId: string, _options?: VocabularyReadOptions) {
      calls?.push('getVocabulary');
      reads++;
      // Return a copy to simulate a real storage provider
      const snapshot = { ...vocab };
      const injected = hooks.concurrentWrite?.(reads, vocab);
      if (injected) vocab = injected;
      return snapshot;
    },
    async saveVocabulary(repositoryId: string, vocabulary: MemoryVocabulary, expectedVersion: string) {
      calls?.push('saveVocabulary');
      if (vocab.version !== expectedVersion) {
        throw new VocabularyVersionConflictError(repositoryId, expectedVersion, vocab.version);
      }
      vocab = vocabulary;
    },
    async deleteEntitiesByType(_repositoryId: string, _entityType: string) {
      calls?.push('deleteEntitiesByType');
      return { deletedEntities: 3, deletedRelationships: 5 };
    },
    async deleteRelationshipsByType(_repositoryId: string, _relationshipType: string) {
      calls?.push('deleteRelationshipsByType');
      return { deletedRelationships: 2 };
    },
  };
}

/** A concurrent writer's change: bumps the version and optionally adds an entity type */
function concurrentChange(stored: MemoryVocabulary, addType?: { type: string; description: string }): MemoryVocabulary {
  return {
    ...stored,
    version: incrementVersion(stored.version, 'patch'),
    entityTypes: addType
      ? [...stored.entityTypes, createEntityTypeDefinition(addType, 'other-process')]
      : stored.entityTypes,
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

  describe('proposeChange — concurrent writers', () => {
    const repositoryId = '20000000-0000-4000-a000-000000000001';

    function engineOn(sharedStorage: Partial<StorageProvider>): VocabularyEngine {
      return new VocabularyEngine({
        repositoryId,
        storageProvider: sharedStorage as StorageProvider,
        governanceConfig: { mode: 'open' },
      });
    }

    function countOf(calls: string[], name: string): number {
      return calls.filter((c) => c === name).length;
    }

    it('two engines on the same storage both get their type in', async () => {
      const shared = createMockStorage(testVocab);
      const engineA = engineOn(shared);
      const engineB = engineOn(shared);

      // Prime B's cache before A writes, so B's cached copy is stale.
      await engineB.getVocabulary();

      const resultA = await engineA.proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'alpha', description: 'First concurrently proposed type' }, justification: 'A' },
        'agent-a',
      );
      const resultB = await engineB.proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'beta', description: 'Second concurrently proposed type' }, justification: 'B' },
        'agent-b',
      );

      expect(resultA.status).toBe('approved');
      expect(resultB.status).toBe('approved');
      expect(resultA.vocabularyVersion).toBeDefined();
      expect(resultB.vocabularyVersion).not.toBe(resultA.vocabularyVersion);

      const stored = await shared.getVocabulary!(repositoryId, { fresh: true });
      const types = stored.entityTypes.map((et) => et.type);
      expect(types).toContain('alpha');
      expect(types).toContain('beta');
    });

    it('retries once after a conflict injected between read and write', async () => {
      const calls: string[] = [];
      const shared = createMockStorage(testVocab, {
        calls,
        concurrentWrite: (readNumber, stored) =>
          readNumber === 1
            ? concurrentChange(stored, { type: 'gamma', description: 'Type written by another process' })
            : undefined,
      });

      const result = await engineOn(shared).proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team of people' }, justification: 'Need teams' },
        'agent',
      );

      expect(result.status).toBe('approved');
      expect(countOf(calls, 'saveVocabulary')).toBe(2);

      const stored = await shared.getVocabulary!(repositoryId, { fresh: true });
      const types = stored.entityTypes.map((et) => et.type);
      expect(types).toContain('gamma');
      expect(types).toContain('team');
    });

    it('gives up after three conflicts', async () => {
      const calls: string[] = [];
      const shared = createMockStorage(testVocab, {
        calls,
        concurrentWrite: (_readNumber, stored) => concurrentChange(stored),
      });

      await expect(
        engineOn(shared).proposeChange(
          { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team of people' }, justification: 'Need teams' },
          'agent',
        ),
      ).rejects.toThrow(VocabularyVersionConflictError);
      expect(countOf(calls, 'saveVocabulary')).toBe(3);
    });

    it('re-evaluates dedup on retry', async () => {
      const shared = createMockStorage(testVocab, {
        concurrentWrite: (readNumber, stored) =>
          readNumber === 1
            ? concurrentChange(stored, { type: 'alpha', description: 'An alpha grouping' })
            : undefined,
      });

      const result = await engineOn(shared).proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'alpha', description: 'An alpha grouping' }, justification: 'Need alpha' },
        'agent',
      );

      expect(result.status).toBe('rejected');
      expect(result.duplicates).toBeDefined();
      expect(result.duplicates!.map((d) => d.type)).toContain('alpha');
    });

    it('delete proposal writes the vocabulary before cascading', async () => {
      const calls: string[] = [];
      const shared = createMockStorage(testVocab, { calls });

      const result = await engineOn(shared).proposeChange(
        { proposalType: 'delete_entity_type', deleteEntityType: { type: 'project' }, justification: 'No longer needed' },
        'agent',
      );

      expect(result.status).toBe('approved');
      const saveIndex = calls.indexOf('saveVocabulary');
      const cascadeIndex = calls.indexOf('deleteEntitiesByType');
      expect(saveIndex).toBeGreaterThanOrEqual(0);
      expect(cascadeIndex).toBeGreaterThan(saveIndex);
    });

    it('a failed CAS does not cascade-delete', async () => {
      const calls: string[] = [];
      const shared = createMockStorage(testVocab, {
        calls,
        concurrentWrite: (_readNumber, stored) => concurrentChange(stored),
      });

      await expect(
        engineOn(shared).proposeChange(
          { proposalType: 'delete_entity_type', deleteEntityType: { type: 'project' }, justification: 'No longer needed' },
          'agent',
        ),
      ).rejects.toThrow(VocabularyVersionConflictError);
      expect(calls).not.toContain('deleteEntitiesByType');
    });

    /** Stands in for a conflict error thrown by a different copy of this package. */
    class ForeignCodedError extends Error {
      public readonly code: string;
      constructor(code: string) {
        super(`foreign ${code}`);
        this.code = code;
      }
    }

    function storageFailingFirstSaveWith(error: Error, calls: string[]): Partial<StorageProvider> {
      const inner = createMockStorage(testVocab, { calls });
      let saves = 0;
      return {
        ...inner,
        async saveVocabulary(repoId: string, vocabulary: MemoryVocabulary, expectedVersion: string) {
          saves++;
          if (saves === 1) {
            calls.push('saveVocabulary');
            throw error;
          }
          return inner.saveVocabulary!(repoId, vocabulary, expectedVersion);
        },
      };
    }

    it('retries a conflict that is not an instance of this copy of the error class', async () => {
      const calls: string[] = [];
      const shared = storageFailingFirstSaveWith(new ForeignCodedError('VOCABULARY_VERSION_CONFLICT'), calls);

      const result = await engineOn(shared).proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team of people' }, justification: 'Need teams' },
        'agent',
      );

      expect(result.status).toBe('approved');
      expect(countOf(calls, 'saveVocabulary')).toBe(2);
    });

    it('does not retry errors with other codes', async () => {
      const calls: string[] = [];
      const failure = new ForeignCodedError('PROVIDER_ERROR');
      const shared = storageFailingFirstSaveWith(failure, calls);

      await expect(
        engineOn(shared).proposeChange(
          { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team of people' }, justification: 'Need teams' },
          'agent',
        ),
      ).rejects.toBe(failure);
      expect(countOf(calls, 'saveVocabulary')).toBe(1);
    });

    it('refuses to write when the stored version cannot be advanced', async () => {
      const calls: string[] = [];
      const shared = createMockStorage({ ...testVocab, version: '1.x.0' }, { calls });

      await expect(
        engineOn(shared).proposeChange(
          { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team of people' }, justification: 'Need teams' },
          'agent',
        ),
      ).rejects.toThrow(InvalidInputError);
      expect(calls).not.toContain('saveVocabulary');
    });
  });
});
