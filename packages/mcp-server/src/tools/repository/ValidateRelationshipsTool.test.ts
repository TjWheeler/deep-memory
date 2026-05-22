import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';
import type { MemoryRepository, RelationshipValidationPage } from '@utaba/deep-memory';
import { ValidateRelationshipsTool } from './ValidateRelationshipsTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';

const REPO_ID = '00000000-0000-4000-a000-000000000001';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const provenance = () => ({
  createdBy: 'test-agent',
  createdByType: 'agent' as const,
  createdAt: '2026-04-19T00:00:00.000Z',
  modifiedBy: 'test-agent',
  modifiedByType: 'agent' as const,
  modifiedAt: '2026-04-19T00:00:00.000Z',
});

describe('ValidateRelationshipsTool', () => {
  let deepMemory: DeepMemory;
  let storage: InMemoryStorageProvider;
  let context: ToolContext;
  let tool: ValidateRelationshipsTool;
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
          { type: 'person', description: 'A person' },
          { type: 'project', description: 'A project' },
        ],
        relationshipTypes: [
          {
            type: 'works_on',
            description: 'Person works on project',
            allowedSourceTypes: ['person'],
            allowedTargetTypes: ['project'],
          },
        ],
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

    tool = new ValidateRelationshipsTool(context, logger);
  });

  it('returns done=true on an empty repository', async () => {
    const result = await tool.execute({ repositoryId: REPO_ID }) as RelationshipValidationPage;
    expect(result.issues).toHaveLength(0);
    expect(result.scanned).toBe(0);
    expect(result.done).toBe(true);
    expect(result.entitiesInMap).toBe(0);
  });

  it('reports entitiesInMap and pages over relationship issues', async () => {
    const [alice] = await repo.createEntities([
      { entityType: 'person', label: 'Alice' },
    ]);
    const [proj] = await repo.createEntities([
      { entityType: 'project', label: 'Apollo' },
    ]);

    for (let i = 0; i < 5; i++) {
      await storage.createRelationship(REPO_ID, {
        id: `20000000-0000-4000-a000-00000000001${i}`,
        relationshipType: 'MADE_UP_TYPE',
        sourceEntityId: alice!.id,
        targetEntityId: proj!.id,
        properties: {},
        bidirectional: false,
        provenance: provenance(),
      });
    }

    const page1 = await tool.execute({ repositoryId: REPO_ID, offset: 0, take: 2 }) as RelationshipValidationPage;
    expect(page1.scanned).toBe(2);
    expect(page1.nextOffset).toBe(2);
    expect(page1.done).toBe(false);
    expect(page1.entitiesInMap).toBe(2);

    const page2 = await tool.execute({ repositoryId: REPO_ID, offset: page1.nextOffset, take: 2 }) as RelationshipValidationPage;
    expect(page2.scanned).toBe(4); // rescans from start: 2 skipped + 2 returned
    expect(page2.done).toBe(false);

    const page3 = await tool.execute({ repositoryId: REPO_ID, offset: page2.nextOffset, take: 2 }) as RelationshipValidationPage;
    expect(page3.scanned).toBe(5); // rescans from start: 4 skipped + 1 returned
    expect(page3.done).toBe(true);

    const total = page1.issues.length + page2.issues.length + page3.issues.length;
    expect(total).toBe(5);
  });
});
