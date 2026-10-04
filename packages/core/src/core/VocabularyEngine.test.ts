import { describe, it, expect, beforeEach } from 'vitest';
import { VocabularyEngine } from './VocabularyEngine.js';
import {
  buildVocabulary,
  createEntityTypeDefinition,
  incrementVersion,
} from '../vocabulary/VocabularySchema.js';
import type { MemoryVocabulary, VocabularyProposal } from '../types/vocabulary.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { StorageProvider, VocabularyReadOptions } from '../providers/StorageProvider.js';
import { InvalidInputError, ProviderError, VocabularyVersionConflictError } from './errors.js';

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

/**
 * Minimal mock StorageProvider — only implements vocabulary methods, with
 * compare-and-set saves. Each type the initial vocabulary declares starts
 * with a few entities or relationships, which a by-type delete removes, so a
 * second delete of the same type reports nothing removed.
 */
function createMockStorage(
  initialVocab: MemoryVocabulary,
  hooks: MockStorageHooks = {},
): Partial<StorageProvider> {
  let vocab = initialVocab;
  let reads = 0;
  const calls = hooks.calls;
  const entitiesByType = new Map(initialVocab.entityTypes.map((t) => [t.type, 3]));
  const relationshipsByType = new Map(initialVocab.relationshipTypes.map((t) => [t.type, 2]));
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
    async deleteEntitiesByType(_repositoryId: string, entityType: string) {
      calls?.push('deleteEntitiesByType');
      const deletedEntities = entitiesByType.get(entityType) ?? 0;
      entitiesByType.delete(entityType);
      return { deletedEntities, deletedRelationships: deletedEntities > 0 ? 5 : 0 };
    },
    async deleteRelationshipsByType(_repositoryId: string, relationshipType: string) {
      calls?.push('deleteRelationshipsByType');
      const deletedRelationships = relationshipsByType.get(relationshipType) ?? 0;
      relationshipsByType.delete(relationshipType);
      return { deletedRelationships };
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

    it('reads through storage on every call, holding no copy of its own', async () => {
      const reads: Array<VocabularyReadOptions | undefined> = [];
      const inner = createMockStorage(testVocab);
      const counting: Partial<StorageProvider> = {
        ...inner,
        async getVocabulary(repositoryId: string, options?: VocabularyReadOptions) {
          reads.push(options);
          return inner.getVocabulary!(repositoryId, options);
        },
      };
      const reading = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: counting as StorageProvider,
        governanceConfig: { mode: 'open' },
      });

      await reading.getVocabulary();
      await reading.validateEntity({ entityType: 'project', label: 'P' });
      await reading.getResolvedVocabulary();

      // Default reads go through the provider's cache: no `fresh` option.
      expect(reads).toEqual([undefined, undefined, undefined]);
    });

    it('reads fresh from the store on every call when opened with freshVocabulary', async () => {
      const reads: Array<VocabularyReadOptions | undefined> = [];
      const inner = createMockStorage(testVocab);
      const counting: Partial<StorageProvider> = {
        ...inner,
        async getVocabulary(repositoryId: string, options?: VocabularyReadOptions) {
          reads.push(options);
          return inner.getVocabulary!(repositoryId, options);
        },
      };
      const reading = new VocabularyEngine({
        repositoryId: '20000000-0000-4000-a000-000000000001',
        storageProvider: counting as StorageProvider,
        governanceConfig: { mode: 'open' },
        freshVocabulary: true,
      });

      await reading.getVocabulary();
      await reading.validateEntity({ entityType: 'project', label: 'P' });

      expect(reads).toEqual([{ fresh: true }, { fresh: true }]);
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

  describe('proposeChange — change log and resumable type deletion', () => {
    const repositoryId = '20000000-0000-4000-a000-000000000002';

    /**
     * In-memory storage whose next by-type delete can be made to fail, the way
     * a server timeout fails the data step of a type deletion after the
     * vocabulary write has landed. With `looseTypeMatch` it compares type
     * names the way a case-insensitive store does: an entity type in lower
     * case, a relationship type in upper case, both trimmed.
     */
    class CascadeFailingStorage extends InMemoryStorageProvider {
      public readonly calls: string[] = [];
      public failNextCascade = false;
      public looseTypeMatch = false;
      /** Runs inside a by-type delete, before it deletes anything */
      public duringCascade: (() => Promise<void>) | undefined;

      public override async saveVocabulary(
        ...args: Parameters<InMemoryStorageProvider['saveVocabulary']>
      ): Promise<void> {
        this.calls.push('saveVocabulary');
        return super.saveVocabulary(...args);
      }

      public override async deleteEntitiesByType(
        repoId: string,
        entityType: string,
      ): Promise<{ deletedEntities: number; deletedRelationships: number }> {
        this.calls.push('deleteEntitiesByType');
        this.throwIfFailing();
        await this.duringCascade?.();
        return super.deleteEntitiesByType(
          repoId,
          this.looseTypeMatch ? entityType.trim().toLowerCase() : entityType,
        );
      }

      public override async deleteRelationshipsByType(
        repoId: string,
        relationshipType: string,
      ): Promise<{ deletedRelationships: number }> {
        this.calls.push('deleteRelationshipsByType');
        this.throwIfFailing();
        await this.duringCascade?.();
        return super.deleteRelationshipsByType(
          repoId,
          this.looseTypeMatch ? relationshipType.trim().toUpperCase() : relationshipType,
        );
      }

      private throwIfFailing(): void {
        if (this.failNextCascade) {
          this.failNextCascade = false;
          throw new ProviderError('The transaction timed out');
        }
      }
    }

    function storedEntity(id: string, entityType: string): StoredEntity {
      const now = new Date().toISOString();
      return {
        id,
        slug: `${entityType}:${id}`,
        entityType,
        label: id,
        properties: {},
        provenance: {
          createdBy: 'test',
          createdByType: 'agent',
          createdAt: now,
          modifiedBy: 'test',
          modifiedByType: 'agent',
          modifiedAt: now,
        },
      };
    }

    function storedRelationship(id: string, sourceId: string, targetId: string): StoredRelationship {
      const { provenance } = storedEntity(id, 'unused');
      return {
        id,
        relationshipType: 'WORKS_ON',
        sourceEntityId: sourceId,
        targetEntityId: targetId,
        properties: {},
        bidirectional: false,
        provenance,
      };
    }

    let storage: CascadeFailingStorage;
    let engine: VocabularyEngine;

    beforeEach(async () => {
      storage = new CascadeFailingStorage();
      await storage.createRepository({
        repositoryId,
        label: 'Resumable deletion',
        governanceConfig: { mode: 'open' },
        vocabulary: testVocab,
        createdAt: new Date().toISOString(),
        createdBy: 'admin',
      });
      await storage.createEntity(repositoryId, storedEntity('ada', 'person'));
      await storage.createEntity(repositoryId, storedEntity('apollo', 'project'));
      await storage.createEntity(repositoryId, storedEntity('gemini', 'project'));
      await storage.createRelationship(repositoryId, storedRelationship('r1', 'ada', 'apollo'));
      await storage.createRelationship(repositoryId, storedRelationship('r2', 'ada', 'gemini'));
      engine = new VocabularyEngine({
        repositoryId,
        storageProvider: storage,
        governanceConfig: { mode: 'open' },
      });
    });

    it('an approved proposal stores its change record with the vocabulary', async () => {
      const before = await storage.getVocabulary(repositoryId);

      const result = await engine.proposeChange(
        { proposalType: 'entity_type', entityType: { type: 'team', description: 'A team of people' }, justification: 'Need teams' },
        'agent-x',
      );

      expect(result.status).toBe('approved');
      const log = await storage.getVocabularyChangeLog(repositoryId);
      expect(log.total).toBe(1);
      expect(log.items[0]).toMatchObject({
        changeType: 'entity_type_added',
        typeName: 'team',
        proposedBy: 'agent-x',
        previousVersion: before.version,
        newVersion: result.vocabularyVersion,
        reason: 'Need teams',
      });
    });

    it('a rejected proposal stores no change record', async () => {
      const result = await engine.proposeChange(
        { proposalType: 'edit_entity_type', editEntityType: { type: 'nonexistent', description: 'x' }, justification: 'No such type' },
        'agent',
      );

      expect(result.status).toBe('rejected');
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(0);
    });

    it('a resend completes an entity type deletion whose data step failed', async () => {
      const proposal: VocabularyProposal = {
        proposalType: 'delete_entity_type',
        deleteEntityType: { type: 'project' },
        justification: 'No longer needed',
      };
      storage.failNextCascade = true;
      await expect(engine.proposeChange(proposal, 'agent')).rejects.toThrow(ProviderError);

      // The vocabulary change landed with its record; the data did not go.
      const afterFailure = await storage.getVocabulary(repositoryId);
      expect(afterFailure.entityTypes.map((t) => t.type)).not.toContain('project');
      expect(await storage.getEntity(repositoryId, 'apollo')).not.toBeNull();
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(1);

      storage.calls.length = 0;
      const result = await engine.proposeChange(proposal, 'agent');

      expect(result).toEqual({ status: 'approved', type: 'project', vocabularyVersion: afterFailure.version });
      expect(storage.calls).toEqual(['deleteEntitiesByType']);
      expect(await storage.getEntity(repositoryId, 'apollo')).toBeNull();
      expect(await storage.getEntity(repositoryId, 'gemini')).toBeNull();
      expect(await storage.getRelationship(repositoryId, 'r1')).toBeNull();
      expect(await storage.getEntity(repositoryId, 'ada')).not.toBeNull();
      expect((await storage.getVocabulary(repositoryId)).version).toBe(afterFailure.version);

      const log = await storage.getVocabularyChangeLog(repositoryId);
      expect(log.total).toBe(1);
      expect(log.items[0]).toMatchObject({ changeType: 'entity_type_removed', typeName: 'project' });
    });

    it('a resend completes a relationship type deletion whose data step failed', async () => {
      const proposal: VocabularyProposal = {
        proposalType: 'delete_relationship_type',
        deleteRelationshipType: { type: 'WORKS_ON' },
        justification: 'Replacing with a different type',
      };
      storage.failNextCascade = true;
      await expect(engine.proposeChange(proposal, 'agent')).rejects.toThrow(ProviderError);
      const afterFailure = await storage.getVocabulary(repositoryId);
      expect(await storage.getRelationship(repositoryId, 'r1')).not.toBeNull();

      storage.calls.length = 0;
      const result = await engine.proposeChange(proposal, 'agent');

      expect(result).toEqual({ status: 'approved', type: 'WORKS_ON', vocabularyVersion: afterFailure.version });
      expect(storage.calls).toEqual(['deleteRelationshipsByType']);
      expect(await storage.getRelationship(repositoryId, 'r1')).toBeNull();
      expect(await storage.getRelationship(repositoryId, 'r2')).toBeNull();
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(1);
    });

    it('a resend for a type with nothing left answers rejected "not found"', async () => {
      const proposal: VocabularyProposal = {
        proposalType: 'delete_entity_type',
        deleteEntityType: { type: 'project' },
        justification: 'No longer needed',
      };
      expect((await engine.proposeChange(proposal, 'agent')).status).toBe('approved');
      const afterDelete = await storage.getVocabulary(repositoryId);

      storage.calls.length = 0;
      const result = await engine.proposeChange(proposal, 'agent');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('not found');
      expect(storage.calls).toEqual(['deleteEntitiesByType']);
      expect((await storage.getVocabulary(repositoryId)).version).toBe(afterDelete.version);
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(1);
    });

    it('a delete of a type that never existed changes nothing', async () => {
      const result = await engine.proposeChange(
        { proposalType: 'delete_entity_type', deleteEntityType: { type: 'nonexistent' }, justification: 'Does not exist' },
        'agent',
      );

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('not found');
      expect(storage.calls).not.toContain('saveVocabulary');
      expect(await storage.getEntity(repositoryId, 'apollo')).not.toBeNull();
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(0);
    });

    it('a resend answers with the vocabulary version as it stands after the data step', async () => {
      const proposal: VocabularyProposal = {
        proposalType: 'delete_entity_type',
        deleteEntityType: { type: 'project' },
        justification: 'No longer needed',
      };
      storage.failNextCascade = true;
      await expect(engine.proposeChange(proposal, 'agent')).rejects.toThrow(ProviderError);
      const afterFailure = await storage.getVocabulary(repositoryId);

      // Another writer changes the vocabulary while the resend's data step runs.
      const concurrentVersion = incrementVersion(afterFailure.version, 'minor');
      storage.duringCascade = async () => {
        storage.duringCascade = undefined;
        const stored = await storage.getVocabulary(repositoryId);
        await storage.saveVocabulary(repositoryId, { ...stored, version: concurrentVersion }, stored.version);
      };

      const result = await engine.proposeChange(proposal, 'agent');

      expect(result).toEqual({ status: 'approved', type: 'project', vocabularyVersion: concurrentVersion });
    });

    it('a resend whose data step fails again propagates the failure, and a further resend completes it', async () => {
      const proposal: VocabularyProposal = {
        proposalType: 'delete_entity_type',
        deleteEntityType: { type: 'project' },
        justification: 'No longer needed',
      };
      storage.failNextCascade = true;
      await expect(engine.proposeChange(proposal, 'agent')).rejects.toThrow(ProviderError);
      const afterFailure = await storage.getVocabulary(repositoryId);

      storage.failNextCascade = true;
      await expect(engine.proposeChange(proposal, 'agent')).rejects.toThrow('The transaction timed out');
      expect(await storage.getEntity(repositoryId, 'apollo')).not.toBeNull();
      expect((await storage.getVocabulary(repositoryId)).version).toBe(afterFailure.version);

      const result = await engine.proposeChange(proposal, 'agent');

      expect(result.status).toBe('approved');
      expect(await storage.getEntity(repositoryId, 'apollo')).toBeNull();
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(1);
    });

    it('a resend under a locked vocabulary is rejected without deleting data', async () => {
      const proposal: VocabularyProposal = {
        proposalType: 'delete_entity_type',
        deleteEntityType: { type: 'project' },
        justification: 'No longer needed',
      };
      storage.failNextCascade = true;
      await expect(engine.proposeChange(proposal, 'agent')).rejects.toThrow(ProviderError);

      const locked = new VocabularyEngine({
        repositoryId,
        storageProvider: storage,
        governanceConfig: { mode: 'locked' },
      });
      storage.calls.length = 0;
      const result = await locked.proposeChange(proposal, 'agent');

      expect(result.status).toBe('rejected');
      expect(result.reason).toContain('locked');
      expect(storage.calls).toEqual([]);
      expect(await storage.getEntity(repositoryId, 'apollo')).not.toBeNull();
    });

    it('a delete differing from a declared entity type only by case or whitespace deletes nothing', async () => {
      storage.looseTypeMatch = true;
      const before = await storage.getVocabulary(repositoryId);

      for (const type of ['Project', ' project ', 'PROJECT']) {
        const result = await engine.proposeChange(
          { proposalType: 'delete_entity_type', deleteEntityType: { type }, justification: 'Near miss' },
          'agent',
        );
        expect(result.status).toBe('rejected');
        expect(result.reason).toContain('not found');
      }

      expect(storage.calls).toEqual([]);
      expect(await storage.getEntity(repositoryId, 'apollo')).not.toBeNull();
      expect(await storage.getEntity(repositoryId, 'gemini')).not.toBeNull();
      expect((await storage.getVocabulary(repositoryId)).version).toBe(before.version);
      expect((await storage.getVocabularyChangeLog(repositoryId)).total).toBe(0);
    });

    it('a delete matching a declared relationship type only once case is ignored deletes nothing', async () => {
      // A vocabulary written before relationship type names were normalised
      // can declare one in lower case.
      const stored = await storage.getVocabulary(repositoryId);
      await storage.saveVocabulary(
        repositoryId,
        {
          ...stored,
          version: incrementVersion(stored.version, 'patch'),
          relationshipTypes: stored.relationshipTypes.map((rt) => ({ ...rt, type: 'works_on' })),
        },
        stored.version,
      );
      storage.looseTypeMatch = true;
      storage.calls.length = 0;

      const result = await engine.proposeChange(
        { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'Works_On' }, justification: 'Near miss' },
        'agent',
      );

      expect(result).toMatchObject({ status: 'rejected', type: 'WORKS_ON' });
      expect(result.reason).toContain('not found');
      expect(storage.calls).toEqual([]);
      expect(await storage.getRelationship(repositoryId, 'r1')).not.toBeNull();
    });

    it('a delete naming a declared relationship type exactly deletes it, even when its name is not normalised', async () => {
      // A vocabulary written before relationship type names were normalised
      // can declare one in lower case; the exact name is matched first.
      const stored = await storage.getVocabulary(repositoryId);
      await storage.saveVocabulary(
        repositoryId,
        {
          ...stored,
          version: incrementVersion(stored.version, 'patch'),
          relationshipTypes: stored.relationshipTypes.map((rt) => ({ ...rt, type: 'works_on' })),
        },
        stored.version,
      );
      storage.calls.length = 0;

      const result = await engine.proposeChange(
        { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'works_on' }, justification: 'Legacy name' },
        'agent',
      );

      expect(result).toMatchObject({ status: 'approved', type: 'works_on' });
      expect(storage.calls).toEqual(['saveVocabulary', 'deleteRelationshipsByType']);
      expect((await storage.getVocabulary(repositoryId)).relationshipTypes).toEqual([]);
    });

    it('a relationship type proposed in another case deletes the normalised type it names', async () => {
      const before = await storage.getVocabulary(repositoryId);

      const result = await engine.proposeChange(
        { proposalType: 'delete_relationship_type', deleteRelationshipType: { type: 'works_on' }, justification: 'Replacing it' },
        'agent',
      );

      expect(result).toEqual({
        status: 'approved',
        type: 'WORKS_ON',
        vocabularyVersion: incrementVersion(before.version, 'major'),
      });
      expect(storage.calls).toEqual(['saveVocabulary', 'deleteRelationshipsByType']);
      expect((await storage.getVocabulary(repositoryId)).relationshipTypes).toEqual([]);
      expect(await storage.getRelationship(repositoryId, 'r1')).toBeNull();
      expect(await storage.getRelationship(repositoryId, 'r2')).toBeNull();
      const log = await storage.getVocabularyChangeLog(repositoryId);
      expect(log.items[0]).toMatchObject({ changeType: 'relationship_type_removed', typeName: 'WORKS_ON' });
    });
  });
});
