import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import { GetRepositoryTool } from './GetRepositoryTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';
import type { MemoryRepository } from '@utaba/deep-memory';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

describe('GetRepositoryTool', () => {
  let deepMemory: DeepMemory;
  let context: ToolContext;
  let tool: GetRepositoryTool;
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

    tool = new GetRepositoryTool(context, logger);
  });

  it('returns the full stored repository record by id', async () => {
    const created = await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000010',
      label: 'Metadata Repo',
      description: 'Repository with rich metadata',
      type: 'knowledge',
      legal: 'Apache-2.0 — internal use only',
      owner: 'platform-team',
      governance: { mode: 'managed', defaultSimilarityThreshold: 0.62 },
      metadata: {
        embeddingModelId: 'Qwen/Qwen3-Embedding-8B',
        embeddingDimensions: 4096,
      },
    });

    const result = await tool.execute({ repositoryId: created.repositoryId }) as any;

    expect(result.repositoryId).toBe(created.repositoryId);
    expect(result.label).toBe('Metadata Repo');
    expect(result.description).toBe('Repository with rich metadata');
    expect(result.type).toBe('knowledge');
    expect(result.legal).toBe('Apache-2.0 — internal use only');
    expect(result.owner).toBe('platform-team');
    expect(result.governanceConfig.mode).toBe('managed');
    expect(result.governanceConfig.defaultSimilarityThreshold).toBe(0.62);
    expect(result.metadata.embeddingModelId).toBe('Qwen/Qwen3-Embedding-8B');
    expect(result.metadata.embeddingDimensions).toBe(4096);
    expect(result.createdAt).toBeDefined();
    expect(result.createdBy).toBeDefined();
  });

  it('resolves by label (case-insensitive)', async () => {
    const created = await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000011',
      label: 'Label Lookup',
      governance: { mode: 'open' },
    });

    const result = await tool.execute({ label: 'label lookup' }) as any;
    expect(result.repositoryId).toBe(created.repositoryId);
  });

  it('returns ambiguous_label when multiple repositories share the label', async () => {
    await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000012',
      label: 'Duplicate',
      governance: { mode: 'open' },
    });
    await deepMemory.createRepository({
      repositoryId: '00000000-0000-4000-a000-000000000013',
      label: 'Duplicate',
      governance: { mode: 'open' },
    });

    const result = await tool.execute({ label: 'Duplicate' }) as any;
    expect(result.error).toBe('ambiguous_label');
    expect(result.candidates).toHaveLength(2);
  });

  it('throws when label has no match', async () => {
    await expect(tool.execute({ label: 'Nope' })).rejects.toThrow('No repository found');
  });

  it('throws when neither repositoryId nor label provided', async () => {
    await expect(tool.execute({})).rejects.toThrow('Provide either repositoryId or label');
  });
});
