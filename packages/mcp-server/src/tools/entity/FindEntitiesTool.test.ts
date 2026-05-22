import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import { FindEntitiesTool } from './FindEntitiesTool.js';
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

describe('FindEntitiesTool', () => {
  let deepMemory: DeepMemory;
  let context: ToolContext;
  let tool: FindEntitiesTool;
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

    tool = new FindEntitiesTool(context, logger);
  });

  it('returns entities without relationship summary by default', async () => {
    await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);

    const result = await tool.execute({ repositoryId: repoId }) as any;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].relationshipSummary).toBeUndefined();
  });

  it('includes relationship summary when requested', async () => {
    const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
    const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);
    await repo.createRelationships([{
      relationshipType: 'works_at',
      sourceEntityId: alice!.id,
      targetEntityId: acme!.id,
    }]);

    const result = await tool.execute({ repositoryId: repoId, includeRelationshipSummary: true }) as any;
    const aliceResult = result.items.find((e: any) => e.label === 'Alice');
    expect(aliceResult.relationshipSummary).toBeDefined();
    expect(aliceResult.relationshipSummary.outbound['WORKS_AT']).toBe(1);
  });

  it('filters by singular entityType param', async () => {
    await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
    await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

    const result = await tool.execute({ repositoryId: repoId, entityType: 'person' }) as any;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].label).toBe('Alice');
  });

  it('prefers entityTypes over entityType when both provided', async () => {
    await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
    await repo.createEntities([{ entityType: 'company', label: 'Acme' }]);

    const result = await tool.execute({ repositoryId: repoId, entityType: 'person', entityTypes: ['company'] }) as any;
    expect(result.items).toHaveLength(1);
    expect(result.items[0].label).toBe('Acme');
  });

  it('returns empty summary for entity with no relationships', async () => {
    await repo.createEntities([{ entityType: 'person', label: 'Lonely' }]);

    const result = await tool.execute({ repositoryId: repoId, includeRelationshipSummary: true }) as any;
    expect(result.items[0].relationshipSummary).toEqual({ outbound: {}, inbound: {} });
  });
});
