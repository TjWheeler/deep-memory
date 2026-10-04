import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider, ProviderError } from '@utaba/deep-memory';
import type { MemoryRepository, StoredEntity } from '@utaba/deep-memory';
import { CreateEntitiesTool } from './CreateEntitiesTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const repoId = '00000000-0000-4000-a000-0000000000a1';

/** Storage that refuses the second entity create while `failSecondCreate` is set. */
class SecondCreateFailsStorage extends InMemoryStorageProvider {
  public failSecondCreate = false;
  private calls = 0;

  public override async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    if (this.failSecondCreate && ++this.calls === 2) throw new ProviderError('store unavailable');
    return super.createEntity(repositoryId, entity);
  }
}

interface ToolErrorResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('CreateEntitiesTool', () => {
  let storage: SecondCreateFailsStorage;
  let repo: MemoryRepository;
  let tool: CreateEntitiesTool;

  beforeEach(async () => {
    storage = new SecondCreateFailsStorage();
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
    tool = new CreateEntitiesTool(context, logger);
  });

  it('returns the created entities when the whole batch stores', async () => {
    const result = await tool.execute({
      repositoryId: repoId,
      entities: [
        { entityType: 'person', label: 'Alex' },
        { entityType: 'person', label: 'Sam' },
      ],
    });

    expect(Array.isArray(result)).toBe(true);
    expect((result as Array<{ label: string }>).map((e) => e.label)).toEqual(['Alex', 'Sam']);
  });

  it('answers a part-way store failure with the stored members and the failed index', async () => {
    storage.failSecondCreate = true;

    const result = (await tool.execute({
      repositoryId: repoId,
      entities: [
        { entityType: 'person', label: 'Alex' },
        { entityType: 'person', label: 'Sam' },
        { entityType: 'person', label: 'Kim' },
      ],
    })) as ToolErrorResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text.startsWith('Error: ')).toBe(true);
    const details = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
      code: string;
      failedIndex: number;
      created: Array<{ id: string; label: string }>;
    };
    expect(details.code).toBe('BATCH_PARTIAL_FAILURE');
    expect(details.failedIndex).toBe(1);
    expect(details.created.map((e) => e.label)).toEqual(['Alex']);
    expect(await repo.getEntity(details.created[0]!.id)).not.toBeNull();
    expect(text).not.toMatch(/requestCharge|resourceCost|"ru"/i);
  });

  it('rejects with the original error when nothing was stored', async () => {
    await expect(
      tool.execute({ repositoryId: repoId, entities: [{ entityType: 'undeclared', label: 'Alex' }] }),
    ).rejects.toMatchObject({ code: 'VOCABULARY_VALIDATION_FAILED' });
  });
});
