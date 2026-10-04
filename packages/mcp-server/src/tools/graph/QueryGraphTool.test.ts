import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import type { MemoryRepository, TraversalResult } from '@utaba/deep-memory';
import { QueryGraphTool } from './QueryGraphTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const repoId = '00000000-0000-4000-a000-0000000000d1';

describe('QueryGraphTool', () => {
  let repo: MemoryRepository;
  let tool: QueryGraphTool;

  beforeEach(async () => {
    const storage = new InMemoryStorageProvider();
    const deepMemory = new DeepMemory({
      storage,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });
    repo = await deepMemory.createRepository({
      repositoryId: repoId,
      label: 'Test Repo',
      vocabulary: { entityTypes: [{ type: 'person', description: 'A person' }], relationshipTypes: [] },
      governance: { mode: 'open' },
    });
    const context: ToolContext = {
      deepMemory,
      storage,
      getRepository: async () => repo,
      evictRepository: () => {},
      exportDir: './exports',
    };
    tool = new QueryGraphTool(context, logger);
  });

  it('leaves the compiled query and resource cost out of the response metadata', async () => {
    const traversal: TraversalResult = {
      entities: [],
      total: 0,
      returned: 0,
      hasMore: false,
      queryMetadata: {
        executionTimeMs: 12,
        resourceCost: { units: 'RU', value: 42.3 },
        compiledQuery: "g.V().has('repositoryId', 'r')",
        compiledQueryLanguage: 'gremlin',
        appliedLimits: { maxResults: 50, maxDepth: 3 },
        truncated: true,
        truncationReason: 'result_limit',
      },
    };
    vi.spyOn(repo, 'traverse').mockResolvedValue(traversal);

    const result = (await tool.execute({
      repositoryId: repoId,
      start: { entityType: 'person' },
      limit: 50,
    })) as TraversalResult;

    expect(result.queryMetadata).toEqual({
      executionTimeMs: 12,
      appliedLimits: { maxResults: 50, maxDepth: 3 },
      truncated: true,
      truncationReason: 'result_limit',
    });
  });

  it('keeps the traversal result itself', async () => {
    await repo.createEntities([{ entityType: 'person', label: 'Alex' }]);

    const result = (await tool.execute({
      repositoryId: repoId,
      start: { entityType: 'person' },
      limit: 50,
    })) as TraversalResult;

    expect(result.entities.map((e) => e.label)).toEqual(['Alex']);
    expect(result.queryMetadata.truncated).toBe(false);
    expect(result.queryMetadata).not.toHaveProperty('compiledQuery');
    expect(result.queryMetadata).not.toHaveProperty('compiledQueryLanguage');
    expect(result.queryMetadata).not.toHaveProperty('resourceCost');
  });
});
