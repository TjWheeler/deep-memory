// RelationshipManager — which error a create reports when an endpoint is missing

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from '../core/DeepMemory.js';
import { VocabularyEngine } from '../core/VocabularyEngine.js';
import { ProvenanceTracker } from '../core/ProvenanceTracker.js';
import { EventBus } from '../core/EventBus.js';
import { RelationshipManager } from './RelationshipManager.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { StoredEntity } from '../types/entities.js';

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
