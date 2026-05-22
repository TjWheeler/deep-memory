import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import { GetGraphTool } from './GetGraphTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';
import type { MemoryRepository } from '@utaba/deep-memory';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const vocabulary = {
  entityTypes: [
    { type: 'person', description: 'A person' },
    { type: 'company', description: 'A company' },
  ],
  relationshipTypes: [
    {
      type: 'works_at',
      description: 'Employment',
      allowedSourceTypes: ['person'],
      allowedTargetTypes: ['company'],
    },
  ],
};

describe('GetGraphTool', () => {
  let deepMemory: DeepMemory;
  let context: ToolContext;
  let tool: GetGraphTool;
  let repo: MemoryRepository;
  const repoId = '00000000-0000-4000-a000-000000000001';
  const repoCache = new Map<string, MemoryRepository>();

  beforeEach(async () => {
    repoCache.clear();
    deepMemory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });

    repo = await deepMemory.createRepository({
      repositoryId: repoId,
      label: 'Test Repo',
      vocabulary,
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

    tool = new GetGraphTool(context, logger);
  });

  it('returns complete graph for small repo', async () => {
    const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
    const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);
    await repo.createRelationships([{
      relationshipType: 'works_at',
      sourceEntityId: alice!.id,
      targetEntityId: acme!.id,
    }]);

    const result = await tool.execute({ repositoryId: repoId }) as any;

    expect(result.entities).toHaveLength(2);
    expect(result.relationships).toHaveLength(1);
    expect(result.vocabulary).toBeDefined();
    expect(result.stats.entityCount).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toBeUndefined();
  });

  it('returns empty arrays for empty repo', async () => {
    const result = await tool.execute({ repositoryId: repoId }) as any;

    expect(result.entities).toHaveLength(0);
    expect(result.relationships).toHaveLength(0);
    expect(result.stats.entityCount).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it('returns vocabulary and stats on every page', async () => {
    const result = await tool.execute({ repositoryId: repoId }) as any;
    expect(result.vocabulary).toBeDefined();
    expect(result.vocabulary.vocabulary.entityTypes).toHaveLength(2);
    expect(result.stats).toBeDefined();
  });

  it('has no duplicate relationships in a single page', async () => {
    const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
    const [bob] = await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);
    const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

    await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: alice!.id, targetEntityId: acme!.id }]);
    await repo.createRelationships([{ relationshipType: 'works_at', sourceEntityId: bob!.id, targetEntityId: acme!.id }]);

    const result = await tool.execute({ repositoryId: repoId }) as any;

    const relIds = result.relationships.map((r: any) => r.id);
    expect(new Set(relIds).size).toBe(relIds.length);
  });
});
