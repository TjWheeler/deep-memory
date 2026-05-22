import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import type { MemoryRepository, EntityValidationPage } from '@utaba/deep-memory';
import { ValidateEntitiesTool } from './ValidateEntitiesTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';

const REPO_ID = '00000000-0000-4000-a000-000000000001';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('ValidateEntitiesTool', () => {
  let deepMemory: DeepMemory;
  let storage: InMemoryStorageProvider;
  let context: ToolContext;
  let tool: ValidateEntitiesTool;
  let repo: MemoryRepository;
  const repoCache = new Map<string, MemoryRepository>();

  beforeEach(async () => {
    repoCache.clear();
    storage = new InMemoryStorageProvider();
    deepMemory = new DeepMemory({
      storage,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });

    repo = await deepMemory.createRepository({
      repositoryId: REPO_ID,
      label: 'Test Repo',
      vocabulary: {
        entityTypes: [
          { type: 'person', description: 'A person', properties: [
            { name: 'role', type: 'string', required: true },
          ] },
        ],
        relationshipTypes: [],
      },
      governance: { mode: 'open' },
    });

    context = {
      deepMemory,
      getRepository: async (id: string) => {
        if (repoCache.has(id)) return repoCache.get(id)!;
        const r = await deepMemory.openRepository(id);
        repoCache.set(id, r);
        return r;
      },
      evictRepository: (id: string) => { repoCache.delete(id); },
      exportDir: './exports',
      storage: {} as any,
    };

    tool = new ValidateEntitiesTool(context, logger);
  });

  it('returns done=true on an empty repository', async () => {
    const result = await tool.execute({ repositoryId: REPO_ID }) as EntityValidationPage;
    expect(result.issues).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(result.nextOffset).toBe(0);
    expect(result.done).toBe(true);
  });

  it('returns issues for invalid entities and done=true when the whole repo fits', async () => {
    await repo.createEntities([
      { entityType: 'person', label: 'Alice', properties: { role: 'engineer' } },
    ]);
    // Bypass validation to inject a bad entity.
    await storage.createEntity(REPO_ID, {
      id: '10000000-0000-4000-a000-000000000001',
      entityType: 'person',
      label: 'Missing Role',
      slug: 'person:missing-role',
      properties: {},
      provenance: {
        createdBy: 'test-agent',
        createdByType: 'agent',
        createdAt: '2026-04-19T00:00:00.000Z',
        modifiedBy: 'test-agent',
        modifiedByType: 'agent',
        modifiedAt: '2026-04-19T00:00:00.000Z',
      },
    });

    const result = await tool.execute({ repositoryId: REPO_ID }) as EntityValidationPage;
    expect(result.done).toBe(true);
    expect(result.scanned).toBe(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.label).toBe('Missing Role');
  });

  it('respects offset and take', async () => {
    for (let i = 0; i < 5; i++) {
      await storage.createEntity(REPO_ID, {
        id: `10000000-0000-4000-a000-00000000001${i}`,
        entityType: 'not-in-vocab',
        label: `Bad ${i}`,
        slug: `not-in-vocab:bad-${i}`,
        properties: {},
        provenance: {
          createdBy: 'test-agent',
          createdByType: 'agent',
          createdAt: '2026-04-19T00:00:00.000Z',
          modifiedBy: 'test-agent',
          modifiedByType: 'agent',
          modifiedAt: '2026-04-19T00:00:00.000Z',
        },
      });
    }

    const page1 = await tool.execute({ repositoryId: REPO_ID, offset: 0, take: 2 }) as EntityValidationPage;
    expect(page1.scanned).toBe(2);
    expect(page1.nextOffset).toBe(2);
    expect(page1.done).toBe(false);

    const page2 = await tool.execute({ repositoryId: REPO_ID, offset: page1.nextOffset, take: 2 }) as EntityValidationPage;
    expect(page2.scanned).toBe(4); // rescans from start: 2 skipped + 2 returned
    expect(page2.done).toBe(false);

    const page3 = await tool.execute({ repositoryId: REPO_ID, offset: page2.nextOffset, take: 2 }) as EntityValidationPage;
    expect(page3.scanned).toBe(5); // rescans from start: 4 skipped + 1 returned
    expect(page3.done).toBe(true);
  });
});
