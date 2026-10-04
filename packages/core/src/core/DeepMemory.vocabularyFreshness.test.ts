// DeepMemory — write validation against a vocabulary another process changed

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeepMemory } from './DeepMemory.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { StorageProvider, VocabularyReadOptions } from '../providers/StorageProvider.js';
import type { MemoryVocabulary, VocabularyChangeRecord } from '../types/vocabulary.js';
import { RepositoryNotFoundError, VocabularyValidationError } from './errors.js';

const REPO_ID = '70000000-0000-4000-a000-000000000001';
const CACHE_TTL_MS = 60_000;

/**
 * One process's view of a shared store, with a vocabulary cache that behaves
 * like the Neo4j and CosmosDB providers' caches: a read within the TTL is
 * answered from the cache, `{ fresh: true }` bypasses it, and this view's own
 * `saveVocabulary` refreshes it. A write through another view is not seen
 * until the entry expires.
 */
function cachingView(shared: InMemoryStorageProvider, ttlMs: number): StorageProvider {
  const cache = new Map<string, { vocabulary: MemoryVocabulary; expiresAt: number }>();
  const getVocabulary = async (
    repositoryId: string,
    options?: VocabularyReadOptions,
  ): Promise<MemoryVocabulary> => {
    const cached = cache.get(repositoryId);
    if (options?.fresh !== true && cached !== undefined && cached.expiresAt > Date.now()) {
      return cached.vocabulary;
    }
    const vocabulary = await shared.getVocabulary(repositoryId);
    cache.set(repositoryId, { vocabulary, expiresAt: Date.now() + ttlMs });
    return vocabulary;
  };
  const saveVocabulary = async (
    repositoryId: string,
    vocabulary: MemoryVocabulary,
    expectedVersion: string,
    changeRecord?: VocabularyChangeRecord,
  ): Promise<void> => {
    await shared.saveVocabulary(repositoryId, vocabulary, expectedVersion, changeRecord);
    cache.set(repositoryId, { vocabulary, expiresAt: Date.now() + ttlMs });
  };
  return new Proxy(shared, {
    get(target, property, receiver) {
      if (property === 'getVocabulary') return getVocabulary;
      if (property === 'saveVocabulary') return saveVocabulary;
      const value: unknown = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function processOn(storage: StorageProvider, actorId: string): DeepMemory {
  return new DeepMemory({ storage, provenance: { actorId, actorType: 'agent' } });
}

async function createSharedRepository(memory: DeepMemory): Promise<void> {
  await memory.createRepository({
    repositoryId: REPO_ID,
    label: 'Shared',
    governance: { mode: 'open' },
    vocabulary: {
      entityTypes: [
        { type: 'person', description: 'A person' },
        { type: 'project', description: 'A project' },
      ],
      relationshipTypes: [],
    },
  });
}

async function deleteProjectType(memory: DeepMemory): Promise<void> {
  const repo = await memory.openRepository(REPO_ID);
  const result = await repo.proposeVocabularyChange({
    proposalType: 'delete_entity_type',
    deleteEntityType: { type: 'project' },
    justification: 'Projects are no longer tracked',
  });
  expect(result.status).toBe('approved');
}

function entityTypes(vocabulary: MemoryVocabulary): string[] {
  return vocabulary.entityTypes.map((et) => et.type);
}

describe('DeepMemory vocabulary freshness across processes', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a handle opened with freshVocabulary refuses a type another process deleted at once', async () => {
    const shared = new InMemoryStorageProvider();
    const processA = processOn(cachingView(shared, CACHE_TTL_MS), 'process-a');
    const processB = processOn(cachingView(shared, CACHE_TTL_MS), 'process-b');
    await createSharedRepository(processA);

    const cachedB = await processB.openRepository(REPO_ID);
    const freshB = await processB.openRepository(REPO_ID, { freshVocabulary: true });
    // Warm process B's vocabulary cache while `project` is still declared.
    await cachedB.createEntities([{ entityType: 'project', label: 'Apollo' }]);

    await deleteProjectType(processA);

    await expect(
      freshB.createEntities([{ entityType: 'project', label: 'Gemini' }]),
    ).rejects.toBeInstanceOf(VocabularyValidationError);
    expect(entityTypes((await freshB.getVocabulary()).vocabulary)).toEqual(['person']);
  });

  it('a default handle sees another process\'s change once the provider cache expires', async () => {
    const shared = new InMemoryStorageProvider();
    const processA = processOn(cachingView(shared, CACHE_TTL_MS), 'process-a');
    const processB = processOn(cachingView(shared, CACHE_TTL_MS), 'process-b');
    await createSharedRepository(processA);

    const cachedB = await processB.openRepository(REPO_ID);
    await cachedB.createEntities([{ entityType: 'project', label: 'Apollo' }]);

    await deleteProjectType(processA);

    // Within the cache lifetime process B still answers from its cache.
    vi.advanceTimersByTime(CACHE_TTL_MS - 1);
    expect(entityTypes((await cachedB.getVocabulary()).vocabulary)).toEqual(['person', 'project']);

    vi.advanceTimersByTime(2);
    await expect(
      cachedB.createEntities([{ entityType: 'project', label: 'Gemini' }]),
    ).rejects.toBeInstanceOf(VocabularyValidationError);
    expect(entityTypes((await cachedB.getVocabulary()).vocabulary)).toEqual(['person']);
  });

  it('a handle on a provider without a cache sees another process\'s change at once', async () => {
    const shared = new InMemoryStorageProvider();
    const processA = processOn(shared, 'process-a');
    const processB = processOn(shared, 'process-b');
    await createSharedRepository(processA);

    const handleB = await processB.openRepository(REPO_ID);
    await handleB.createEntities([{ entityType: 'project', label: 'Apollo' }]);

    await deleteProjectType(processA);

    await expect(
      handleB.createEntities([{ entityType: 'project', label: 'Gemini' }]),
    ).rejects.toBeInstanceOf(VocabularyValidationError);
  });

  it('a handle sees its own vocabulary change at once', async () => {
    const shared = new InMemoryStorageProvider();
    const processA = processOn(cachingView(shared, CACHE_TTL_MS), 'process-a');
    await createSharedRepository(processA);
    const repo = await processA.openRepository(REPO_ID);
    await repo.getVocabulary();

    const result = await repo.proposeVocabularyChange({
      proposalType: 'entity_type',
      entityType: { type: 'milestone', description: 'A dated checkpoint in a plan' },
      justification: 'Track milestones',
    });
    expect(result.status).toBe('approved');

    const [created] = await repo.createEntities([{ entityType: 'milestone', label: 'Launch' }]);
    expect(created?.entityType).toBe('milestone');
  });

  it('an open handle\'s getVocabulary throws RepositoryNotFoundError once the repository is deleted', async () => {
    const shared = new InMemoryStorageProvider();
    const processA = processOn(shared, 'process-a');
    const processB = processOn(shared, 'process-b');
    await createSharedRepository(processA);
    const handleA = await processA.openRepository(REPO_ID);
    const handleB = await processB.openRepository(REPO_ID);
    await handleA.getVocabulary();
    await handleB.getVocabulary();

    await processA.deleteRepository(REPO_ID);

    await expect(handleA.getVocabulary()).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(handleB.getVocabulary()).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });
});
