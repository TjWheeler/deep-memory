// EntityManager — slug-conflict retry on create and update

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from '../core/DeepMemory.js';
import type { MemoryRepository } from '../core/MemoryRepository.js';
import { VocabularyEngine } from '../core/VocabularyEngine.js';
import { ProvenanceTracker } from '../core/ProvenanceTracker.js';
import { EventBus } from '../core/EventBus.js';
import { EntityManager } from './EntityManager.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import { DuplicateEntityError, ProviderError, SlugConflictError } from '../core/errors.js';
import type { StoredEntity, StoredEntityUpdate } from '../types/entities.js';

const REPO_ID = '00000000-0000-4000-a000-0000000000e1';

/**
 * Storage whose next `pendingConflicts` slug-carrying writes are refused as
 * slug clashes, the way the store refuses the loser of a concurrent write.
 * With `competitorCommits`, a competing entity holding the refused slug is
 * written first, so the clash is visible to a later read; without it, the
 * competing write is not yet visible.
 */
class SlugClashStorage extends InMemoryStorageProvider {
  public pendingConflicts = 0;
  public competitorCommits = true;
  public failUpdateWith: Error | undefined;
  public readonly attemptedSlugs: string[] = [];
  private competitorSeq = 0;

  public override async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    this.attemptedSlugs.push(entity.slug);
    await this.maybeClash(repositoryId, entity.slug, entity.entityType, entity.label);
    return super.createEntity(repositoryId, entity);
  }

  public override async updateEntity(
    repositoryId: string,
    entityId: string,
    updates: StoredEntityUpdate,
  ): Promise<StoredEntity> {
    if (updates.slug !== undefined) {
      this.attemptedSlugs.push(updates.slug);
      if (this.failUpdateWith !== undefined) throw this.failUpdateWith;
      await this.maybeClash(repositoryId, updates.slug, updates.entityType ?? 'person', updates.label ?? '');
    }
    return super.updateEntity(repositoryId, entityId, updates);
  }

  private async maybeClash(repositoryId: string, slug: string, entityType: string, label: string): Promise<void> {
    if (this.pendingConflicts === 0) return;
    this.pendingConflicts--;
    if (this.competitorCommits) {
      const now = new Date().toISOString();
      await super.createEntity(repositoryId, {
        id: `competitor-${++this.competitorSeq}`,
        slug,
        entityType,
        label,
        properties: {},
        provenance: {
          createdBy: 'competitor',
          createdByType: 'agent',
          createdAt: now,
          modifiedBy: 'competitor',
          modifiedByType: 'agent',
          modifiedAt: now,
        },
      });
    }
    throw new SlugConflictError(slug, { entityType, label });
  }
}

describe('EntityManager slug-conflict retry', () => {
  let storage: SlugClashStorage;
  let repo: MemoryRepository;

  beforeEach(async () => {
    storage = new SlugClashStorage();
    const memory = new DeepMemory({
      storage,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });
    repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Slug retry',
      vocabulary: { entityTypes: [{ type: 'person', description: 'A person' }], relationshipTypes: [] },
      governance: { mode: 'open' },
    });
  });

  describe('create', () => {
    it('retries a slug clash with the next free slug and succeeds', async () => {
      storage.pendingConflicts = 1;

      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      expect(entity!.slug).toBe('person:alex-2');
      expect(storage.attemptedSlugs).toEqual(['person:alex', 'person:alex-2']);
      expect(await repo.getEntity(entity!.id)).not.toBeNull();
    });

    it('moves past a refused slug even when the competing write is not yet readable', async () => {
      storage.pendingConflicts = 1;
      storage.competitorCommits = false;

      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      expect(entity!.slug).toBe('person:alex-2');
      expect(storage.attemptedSlugs).toEqual(['person:alex', 'person:alex-2']);
    });

    it('succeeds when the third retry is the first to land', async () => {
      storage.pendingConflicts = 3;

      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      expect(entity!.slug).toBe('person:alex-4');
      expect(storage.attemptedSlugs).toHaveLength(4);
    });

    it('propagates SlugConflictError on the fourth consecutive clash', async () => {
      storage.pendingConflicts = 4;

      const rejection = repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      await expect(rejection).rejects.toBeInstanceOf(SlugConflictError);
      await expect(rejection).rejects.toMatchObject({
        code: 'SLUG_CONFLICT',
        slug: 'person:alex-4',
        entityType: 'person',
        label: 'Alex',
      });
      expect(storage.attemptedSlugs).toEqual([
        'person:alex',
        'person:alex-2',
        'person:alex-3',
        'person:alex-4',
      ]);
    });

    it('does not retry an id clash', async () => {
      const [first] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      storage.attemptedSlugs.length = 0;

      await expect(
        repo.createEntities([{ id: first!.id, entityType: 'person', label: 'Someone Else' }]),
      ).rejects.toBeInstanceOf(DuplicateEntityError);
      expect(storage.attemptedSlugs).toHaveLength(1);
    });

    it('retries a clash raised from another copy of the error classes', async () => {
      // A provider may resolve its own copy of this package; its error is
      // recognised by code, not by class identity.
      const foreign = Object.assign(new Error('slug taken'), { code: 'SLUG_CONFLICT' });
      let thrown = false;
      const original = storage.createEntity.bind(storage);
      storage.createEntity = async (repositoryId, entity) => {
        if (!thrown) {
          thrown = true;
          throw foreign;
        }
        return original(repositoryId, entity);
      };

      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      expect(entity!.slug).toBe('person:alex-2');
    });
  });

  describe('update', () => {
    it('retries a slug clash on a label change with the next free slug', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      storage.attemptedSlugs.length = 0;
      storage.pendingConflicts = 1;

      const updated = await repo.updateEntity(entity!.id, { label: 'Sam' });

      expect(updated.slug).toBe('person:sam-2');
      expect(storage.attemptedSlugs).toEqual(['person:sam', 'person:sam-2']);
    });

    it('propagates SlugConflictError on the fourth consecutive clash', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      storage.attemptedSlugs.length = 0;
      storage.pendingConflicts = 4;

      await expect(repo.updateEntity(entity!.id, { label: 'Sam' })).rejects.toMatchObject({
        code: 'SLUG_CONFLICT',
        slug: 'person:sam-4',
      });
      expect(storage.attemptedSlugs).toHaveLength(4);
      expect((await repo.getEntity(entity!.id))!.slug).toBe('person:alex');
    });

    it('reports a deleted repository ahead of a missing entity', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      await storage.deleteRepository(repo.repositoryId);
      // Database-backed stores answer an entity read on a deleted repository
      // with no row rather than an error.
      storage.getEntity = async () => null;

      await expect(repo.updateEntity(entity!.id, { label: 'Sam' })).rejects.toMatchObject({
        code: 'REPOSITORY_NOT_FOUND',
      });
    });

    it('reports a missing entity when the repository exists', async () => {
      await expect(repo.updateEntity('missing-entity', { label: 'Sam' })).rejects.toMatchObject({
        code: 'ENTITY_NOT_FOUND',
      });
    });

    it('does not retry an error that is not a slug conflict', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      storage.attemptedSlugs.length = 0;
      storage.failUpdateWith = new ProviderError('store unavailable');

      await expect(repo.updateEntity(entity!.id, { label: 'Sam' })).rejects.toBeInstanceOf(ProviderError);
      expect(storage.attemptedSlugs).toHaveLength(1);
    });

    it('treats the entity\'s own slug as free when the label slugifies the same', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      const updated = await repo.updateEntity(entity!.id, { label: 'ALEX' });

      expect(updated.slug).toBe('person:alex');
    });
  });

  describe('delete', () => {
    function entityManager(): EntityManager {
      const provenance = { actorId: 'test-agent', actorType: 'agent' as const };
      return new EntityManager(
        REPO_ID,
        new VocabularyEngine({ repositoryId: REPO_ID, storageProvider: storage, governanceConfig: { mode: 'open' } }),
        new ProvenanceTracker(provenance),
        new EventBus(provenance, REPO_ID),
        storage,
      );
    }

    it('reports a deleted repository ahead of a missing entity', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      await storage.deleteRepository(REPO_ID);
      // Database-backed stores answer an entity read on a deleted repository
      // with no row rather than an error.
      storage.getEntity = async () => null;

      await expect(entityManager().delete(entity!.id)).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
    });

    it('reports a missing entity when the repository exists', async () => {
      await expect(entityManager().delete('missing-entity')).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND' });
    });
  });
});

describe('EntityManager concurrent creates on the in-memory provider', () => {
  it('two parallel creates with the same type and label both succeed with distinct slugs', async () => {
    const memory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });
    const repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Slug race',
      vocabulary: { entityTypes: [{ type: 'person', description: 'A person' }], relationshipTypes: [] },
      governance: { mode: 'open' },
    });

    const [[a], [b]] = await Promise.all([
      repo.createEntities([{ entityType: 'person', label: 'Alex' }]),
      repo.createEntities([{ entityType: 'person', label: 'Alex' }]),
    ]);

    expect([a!.slug, b!.slug].sort()).toEqual(['person:alex', 'person:alex-2']);
    expect(await repo.getEntity(a!.id)).not.toBeNull();
    expect(await repo.getEntity(b!.id)).not.toBeNull();
  });
});
