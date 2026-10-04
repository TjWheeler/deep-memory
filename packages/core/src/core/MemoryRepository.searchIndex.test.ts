// MemoryRepository — search indexing after a committed write is best-effort

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from './DeepMemory.js';
import type { MemoryRepository } from './MemoryRepository.js';
import { BatchPartialFailureError, ProviderError } from './errors.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import { InMemorySearchProvider } from '../providers-builtin/InMemorySearchProvider.js';
import type { SearchableEntity } from '../providers/SearchProvider.js';
import type { StoredEntity } from '../types/entities.js';

const REPO_ID = '00000000-0000-4000-a000-0000000000c1';

/** Search provider whose index writes fail while `failing` is set, recording what it indexed. */
class FlakySearchProvider extends InMemorySearchProvider {
  public failing = false;
  public readonly indexed: string[] = [];

  public override async indexEntity(repositoryId: string, entity: SearchableEntity): Promise<void> {
    if (this.failing) throw new ProviderError('search index unavailable');
    this.indexed.push(entity.entityId);
    return super.indexEntity(repositoryId, entity);
  }

  public override async removeEntity(repositoryId: string, entityId: string): Promise<void> {
    if (this.failing) throw new ProviderError('search index unavailable');
    return super.removeEntity(repositoryId, entityId);
  }
}

/** Storage that refuses the second entity create. */
class SecondCreateFailsStorage extends InMemoryStorageProvider {
  public failSecondCreate = false;
  private calls = 0;

  public override async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    if (this.failSecondCreate && ++this.calls === 2) throw new ProviderError('store unavailable');
    return super.createEntity(repositoryId, entity);
  }
}

describe('MemoryRepository search indexing', () => {
  let storage: SecondCreateFailsStorage;
  let search: FlakySearchProvider;
  let repo: MemoryRepository;
  let indexFailures: Array<{ entityId: string; error: string }>;

  beforeEach(async () => {
    storage = new SecondCreateFailsStorage();
    search = new FlakySearchProvider();
    const memory = new DeepMemory({
      storage,
      search,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });
    repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Search indexing',
      vocabulary: { entityTypes: [{ type: 'person', description: 'A person' }], relationshipTypes: [] },
      governance: { mode: 'open' },
    });
    indexFailures = [];
    repo.on('search:index_failed', (event) => {
      indexFailures.push(event.payload);
    });
  });

  it('resolves a create with the stored entity when indexing fails, and announces the failure', async () => {
    search.failing = true;

    const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

    expect(entity).toMatchObject({ entityType: 'person', label: 'Alex' });
    expect(await repo.getEntity(entity!.id)).not.toBeNull();
    expect(indexFailures).toEqual([{ entityId: entity!.id, error: 'search index unavailable' }]);
  });

  it('resolves an update when re-indexing fails, and announces the failure', async () => {
    const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
    search.failing = true;

    const updated = await repo.updateEntity(entity!.id, { summary: 'Updated' });

    expect(updated.summary).toBe('Updated');
    expect(indexFailures).toEqual([{ entityId: entity!.id, error: 'search index unavailable' }]);
  });

  it('resolves a delete when removal from the index fails, and announces the failure', async () => {
    const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
    search.failing = true;

    const result = await repo.deleteEntities([entity!.id]);

    expect(result.deleted).toEqual([entity!.id]);
    expect(indexFailures).toEqual([{ entityId: entity!.id, error: 'search index unavailable' }]);
  });

  it('indexes the stored members of a batch that fails part-way', async () => {
    storage.failSecondCreate = true;

    const err = await repo
      .createEntities([
        { entityType: 'person', label: 'Alex' },
        { entityType: 'person', label: 'Sam' },
      ])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BatchPartialFailureError);
    const stored = (err as BatchPartialFailureError).created.map((m) => m.id);
    expect(stored).toHaveLength(1);
    expect(search.indexed).toEqual(stored);
    expect(indexFailures).toEqual([]);
  });

  describe('when a search:index_failed handler throws', () => {
    beforeEach(() => {
      repo.on('search:index_failed', () => {
        throw new ProviderError('handler failed');
      });
      search.failing = true;
    });

    it('still resolves a create with the stored entity', async () => {
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

      expect(await repo.getEntity(entity!.id)).not.toBeNull();
      expect(indexFailures).toEqual([{ entityId: entity!.id, error: 'search index unavailable' }]);
    });

    it('still resolves an update and a delete', async () => {
      search.failing = false;
      const [entity] = await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);
      search.failing = true;

      const updated = await repo.updateEntity(entity!.id, { summary: 'Updated' });
      const result = await repo.deleteEntities([entity!.id]);

      expect(updated.summary).toBe('Updated');
      expect(result.deleted).toEqual([entity!.id]);
      expect(indexFailures).toHaveLength(2);
    });

    it('keeps BatchPartialFailureError as the outcome of a batch that fails part-way', async () => {
      storage.failSecondCreate = true;

      const err = await repo
        .createEntities([
          { entityType: 'person', label: 'Alex' },
          { entityType: 'person', label: 'Sam' },
        ])
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BatchPartialFailureError);
      expect((err as BatchPartialFailureError).created).toHaveLength(1);
      expect(indexFailures).toHaveLength(1);
    });
  });
});
