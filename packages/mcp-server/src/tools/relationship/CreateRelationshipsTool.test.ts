import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory, InMemoryStorageProvider, ProviderError } from '@utaba/deep-memory';
import type { MemoryRepository, StoredRelationship } from '@utaba/deep-memory';
import type { RelationshipCreateOptions } from '@utaba/deep-memory/providers';
import { CreateRelationshipsTool } from './CreateRelationshipsTool.js';
import type { ToolContext } from '../base/BaseToolController.js';
import type { ILogger } from '../../interfaces/ILogger.js';

const logger: ILogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const repoId = '00000000-0000-4000-a000-0000000000b1';

/** Storage that refuses the second relationship create while `failSecondCreate` is set. */
class SecondCreateFailsStorage extends InMemoryStorageProvider {
  public failSecondCreate = false;
  private calls = 0;

  public override async createRelationship(
    repositoryId: string,
    relationship: StoredRelationship,
    options?: RelationshipCreateOptions,
  ): Promise<StoredRelationship> {
    if (this.failSecondCreate && ++this.calls === 2) throw new ProviderError('store unavailable');
    return super.createRelationship(repositoryId, relationship, options);
  }
}

interface ToolErrorResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

describe('CreateRelationshipsTool', () => {
  let storage: SecondCreateFailsStorage;
  let repo: MemoryRepository;
  let tool: CreateRelationshipsTool;
  let ids: string[];

  beforeEach(async () => {
    storage = new SecondCreateFailsStorage();
    const deepMemory = new DeepMemory({
      storage,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });
    repo = await deepMemory.createRepository({
      repositoryId: repoId,
      label: 'Test Repo',
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
    const people = await repo.createEntities([
      { entityType: 'person', label: 'Alex' },
      { entityType: 'person', label: 'Sam' },
      { entityType: 'person', label: 'Kim' },
    ]);
    ids = people.map((p) => p.id);
    const context: ToolContext = {
      deepMemory,
      storage,
      getRepository: async () => repo,
      evictRepository: () => {},
      exportDir: './exports',
    };
    tool = new CreateRelationshipsTool(context, logger);
  });

  it('answers a part-way store failure with the stored members and the failed index', async () => {
    storage.failSecondCreate = true;
    const [alex, sam, kim] = ids;

    const result = (await tool.execute({
      repositoryId: repoId,
      relationships: [
        { relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam },
        { relationshipType: 'KNOWS', sourceEntityId: sam, targetEntityId: kim },
      ],
    })) as ToolErrorResult;

    expect(result.isError).toBe(true);
    const text = result.content[0]!.text;
    expect(text.startsWith('Error: ')).toBe(true);
    const details = JSON.parse(text.slice(text.indexOf('\n') + 1)) as {
      code: string;
      failedIndex: number;
      created: Array<{ relationshipType: string; sourceEntityId: string; targetEntityId: string }>;
    };
    expect(details.code).toBe('BATCH_PARTIAL_FAILURE');
    expect(details.failedIndex).toBe(1);
    expect(details.created).toHaveLength(1);
    expect(details.created[0]).toMatchObject({ relationshipType: 'KNOWS', sourceEntityId: alex, targetEntityId: sam });
  });
});
