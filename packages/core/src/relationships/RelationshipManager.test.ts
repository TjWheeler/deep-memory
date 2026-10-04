// RelationshipManager — which error a create reports when an endpoint is missing, and batch create outcomes

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeepMemory } from '../core/DeepMemory.js';
import { VocabularyEngine } from '../core/VocabularyEngine.js';
import { ProvenanceTracker } from '../core/ProvenanceTracker.js';
import { EventBus } from '../core/EventBus.js';
import { RelationshipManager } from './RelationshipManager.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import type { RelationshipCreateOptions } from '../providers/StorageProvider.js';
import type { MemoryRepository } from '../core/MemoryRepository.js';
import { BatchPartialFailureError, ProviderError, VocabularyValidationError } from '../core/errors.js';

const REPO_ID = '00000000-0000-4000-a000-0000000000f1';

describe('RelationshipManager.create on a missing endpoint', () => {
  let storage: InMemoryStorageProvider;
  let sourceId: string;
  let targetId: string;

  function relationshipManager(): RelationshipManager {
    const provenance = { actorId: 'test-agent', actorType: 'agent' as const };
    return new RelationshipManager(
      REPO_ID,
      new VocabularyEngine({ repositoryId: REPO_ID, storageProvider: storage, governanceConfig: { mode: 'open' } }),
      new ProvenanceTracker(provenance),
      new EventBus(provenance, REPO_ID),
      storage,
    );
  }

  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    const memory = new DeepMemory({ storage, provenance: { actorId: 'test-agent', actorType: 'agent' } });
    const repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Endpoint miss',
      vocabulary: {
        entityTypes: [{ type: 'person', description: 'A person' }],
        relationshipTypes: [
          {
            type: 'KNOWS',
            description: 'Knows another person',
            allowedSourceTypes: ['person'],
            allowedTargetTypes: ['person'],
          },
        ],
      },
      governance: { mode: 'open' },
    });
    const [source, target] = await repo.createEntities([
      { entityType: 'person', label: 'Alex' },
      { entityType: 'person', label: 'Sam' },
    ]);
    sourceId = source!.id;
    targetId = target!.id;
  });

  it('reports a deleted repository ahead of a missing source', async () => {
    await storage.deleteRepository(REPO_ID);

    await expect(
      relationshipManager().create([{ relationshipType: 'KNOWS', sourceEntityId: sourceId, targetEntityId: targetId }]),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
  });

  it('reports a deleted repository ahead of a missing target', async () => {
    // The repository is deleted between the source read and the target read:
    // the source read is served from before the delete, the target read
    // reaches the store.
    const source = await storage.getEntity(REPO_ID, sourceId);
    const readEntity = storage.getEntity.bind(storage);
    await storage.deleteRepository(REPO_ID);
    storage.getEntity = async (repositoryId: string, entityId: string): Promise<StoredEntity | null> =>
      entityId === sourceId ? source : readEntity(repositoryId, entityId);

    await expect(
      relationshipManager().create([{ relationshipType: 'KNOWS', sourceEntityId: sourceId, targetEntityId: targetId }]),
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_FOUND' });
  });

  it('reports the missing endpoint when the repository exists', async () => {
    await expect(
      relationshipManager().create([{ relationshipType: 'KNOWS', sourceEntityId: 'missing-source', targetEntityId: targetId }]),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', id: 'missing-source' });
    await expect(
      relationshipManager().create([{ relationshipType: 'KNOWS', sourceEntityId: sourceId, targetEntityId: 'missing-target' }]),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', id: 'missing-target' });
  });
});

/** Storage that refuses the `failOnCall`-th relationship create (1-based) with `failure`. */
class FailingRelationshipStorage extends InMemoryStorageProvider {
  public failOnCall = 0;
  public failure: Error = new ProviderError('store unavailable');
  private calls = 0;

  public override async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
    options?: RelationshipCreateOptions,
  ): Promise<StoredRelationship> {
    this.calls++;
    if (this.calls === this.failOnCall) throw this.failure;
    return super.createRelationship(repositoryId, relationship, options);
  }
}

describe('RelationshipManager.create batch outcome', () => {
  let storage: FailingRelationshipStorage;
  let repo: MemoryRepository;
  let alex: string;
  let sam: string;
  let kim: string;

  beforeEach(async () => {
    storage = new FailingRelationshipStorage();
    const memory = new DeepMemory({ storage, provenance: { actorId: 'test-agent', actorType: 'agent' } });
    repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Batch outcome',
      vocabulary: {
        entityTypes: [{ type: 'person', description: 'A person' }],
        relationshipTypes: [
          {
            type: 'KNOWS',
            description: 'Knows another person',
            allowedSourceTypes: ['person'],
            allowedTargetTypes: ['person'],
          },
        ],
      },
      governance: { mode: 'open' },
    });
    const [a, s, k] = await repo.createEntities([
      { entityType: 'person', label: 'Alex' },
      { entityType: 'person', label: 'Sam' },
      { entityType: 'person', label: 'Kim' },
    ]);
    alex = a!.id;
    sam = s!.id;
    kim = k!.id;
  });

  async function storedCount(): Promise<number> {
    return (await repo.getRelationshipsForEntities([alex, sam, kim])).length;
  }

  it('writes nothing when a later member fails vocabulary validation', async () => {
    await expect(
      repo.createRelationships([
        { relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam },
        { relationshipType: 'NOT_DECLARED', sourceEntityId: sam, targetEntityId: kim },
      ]),
    ).rejects.toBeInstanceOf(VocabularyValidationError);

    expect(await storedCount()).toBe(0);
  });

  it('writes nothing when a later member names a missing endpoint', async () => {
    await expect(
      repo.createRelationships([
        { relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam },
        { relationshipType: 'KNOWS', sourceEntityId: sam, targetEntityId: 'missing-target' },
      ]),
    ).rejects.toMatchObject({ code: 'ENTITY_NOT_FOUND', id: 'missing-target' });

    expect(await storedCount()).toBe(0);
  });

  it('reports the stored members and the failed index when a later member fails to store', async () => {
    storage.failOnCall = 2;

    const err = await repo
      .createRelationships([
        { relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam },
        { relationshipType: 'KNOWS', sourceEntityId: sam, targetEntityId: kim },
        { relationshipType: 'KNOWS', sourceEntityId: kim, targetEntityId: alex },
      ])
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BatchPartialFailureError);
    const failure = err as BatchPartialFailureError;
    expect(failure.code).toBe('BATCH_PARTIAL_FAILURE');
    expect(failure.failedIndex).toBe(1);
    expect(failure.created).toHaveLength(1);
    expect(failure.created[0]).toMatchObject({ relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam });
    expect(failure.cause).toBe(storage.failure);
    expect(await storedCount()).toBe(1);
  });

  it('throws the original error when the first member fails to store', async () => {
    storage.failOnCall = 1;

    await expect(
      repo.createRelationships([
        { relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam },
        { relationshipType: 'KNOWS', sourceEntityId: sam, targetEntityId: kim },
      ]),
    ).rejects.toBe(storage.failure);
    expect(await storedCount()).toBe(0);
  });

  it('reads the vocabulary once for the whole batch', async () => {
    const getVocabulary = vi.spyOn(storage, 'getVocabulary');

    const created = await repo.createRelationships([
      { relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam },
      { relationshipType: 'KNOWS', sourceEntityId: sam, targetEntityId: kim },
      { relationshipType: 'KNOWS', sourceEntityId: kim, targetEntityId: alex },
    ]);

    expect(created).toHaveLength(3);
    expect(getVocabulary).toHaveBeenCalledTimes(1);
  });
});
