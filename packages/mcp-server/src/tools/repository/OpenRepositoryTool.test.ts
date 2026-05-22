import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import { OpenRepositoryTool } from './OpenRepositoryTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';
import type { MemoryRepository } from '@utaba/deep-memory';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('OpenRepositoryTool', () => {
  let deepMemory: DeepMemory;
  let context: ToolContext;
  let tool: OpenRepositoryTool;
  const repoCache = new Map<string, MemoryRepository>();

  beforeEach(async () => {
    repoCache.clear();
    deepMemory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });

    context = {
      deepMemory,
      getRepository: async (id: string) => {
        if (repoCache.has(id)) return repoCache.get(id)!;
        const repo = await deepMemory.openRepository(id);
        repoCache.set(id, repo);
        return repo;
      },
      evictRepository: (id: string) => { repoCache.delete(id); },
      exportDir: './exports',
      storage: {} as any,
    };

    tool = new OpenRepositoryTool(context, logger);
  });

  it('opens by repositoryId (existing flow)', async () => {
    const repo = await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000001',
      label: 'Test Repo',
      governance: { mode: 'open' },
    });

    const result = await tool.execute({ repositoryId: repo.repositoryId }) as any;
    expect(result.repositoryId).toBe(repo.repositoryId);
    expect(result.message).toContain('opened');
  });

  it('opens by label (case-insensitive)', async () => {
    const repo = await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000002',
      label: 'Personal Knowledge',
      governance: { mode: 'open' },
    });

    const result = await tool.execute({ label: 'personal knowledge' }) as any;
    expect(result.repositoryId).toBe(repo.repositoryId);
  });

  it('returns vocabulary and stats on open', async () => {
    await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000003',
      label: 'With Vocab',
      vocabulary: {
        entityTypes: [{ type: 'person', description: 'A person' }],
        relationshipTypes: [],
      },
      governance: { mode: 'open' },
    });

    const result = await tool.execute({ label: 'With Vocab' }) as any;
    expect(result.vocabulary).toBeDefined();
    expect(result.vocabulary.entityTypes).toHaveLength(1);
    // Audit fields should be stripped
    expect(result.vocabulary.entityTypes[0].createdAt).toBeUndefined();
    expect(result.vocabulary.entityTypes[0].createdBy).toBeUndefined();
    expect(result.vocabulary.entityTypes[0].modifiedAt).toBeUndefined();
    expect(result.vocabulary.entityTypes[0].modifiedBy).toBeUndefined();
    expect(result.vocabulary.entityTypes[0].version).toBeUndefined();
    expect(result.stats).toBeDefined();
    expect(result.stats.entityCount).toBe(0);
  });

  it('returns error when no match for label', async () => {
    await expect(tool.execute({ label: 'Nonexistent' })).rejects.toThrow('No repository found');
  });

  it('returns candidates when label is ambiguous', async () => {
    await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000004',
      label: 'Shared Name',
      governance: { mode: 'open' },
    });
    await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000005',
      label: 'Shared Name',
      governance: { mode: 'open' },
    });

    const result = await tool.execute({ label: 'Shared Name' }) as any;
    expect(result.error).toBe('ambiguous_label');
    expect(result.candidates).toHaveLength(2);
  });

  it('throws when neither repositoryId nor label provided', async () => {
    await expect(tool.execute({})).rejects.toThrow('Provide either repositoryId or label');
  });
});
