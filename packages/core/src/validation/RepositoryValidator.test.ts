// RepositoryValidator — unit tests

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from '../core/DeepMemory.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { MemoryRepository } from '../core/MemoryRepository.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import type { Provenance } from '../types/provenance.js';
import type {
  EntityValidationIssue,
  RelationshipValidationIssue,
} from '../types/results.js';

const REPO_ID = '00000000-0000-4000-a000-000000000001';
const ACTOR = 'test-agent';

const provenance = (): Provenance => ({
  createdBy: ACTOR,
  createdByType: 'agent',
  createdAt: '2026-04-19T00:00:00.000Z',
  modifiedBy: ACTOR,
  modifiedByType: 'agent',
  modifiedAt: '2026-04-19T00:00:00.000Z',
});

const vocabulary = {
  entityTypes: [
    {
      type: 'person',
      description: 'A person',
      properties: [
        { name: 'role', type: 'string' as const, required: true },
        { name: 'age', type: 'number' as const, required: false },
      ],
    },
    { type: 'project', description: 'A project' },
    { type: 'company', description: 'A company' },
    {
      type: 'event',
      description: 'A scheduled event',
      properties: [
        { name: 'eventType', type: 'string' as const, required: true },
      ],
    },
  ],
  relationshipTypes: [
    {
      type: 'works_on',
      description: 'A person working on a project',
      allowedSourceTypes: ['person'],
      allowedTargetTypes: ['project'],
    },
    {
      type: 'INVOLVED_IN',
      description: 'A person involved in an event',
      allowedSourceTypes: ['person'],
      allowedTargetTypes: ['event'],
    },
  ],
};

/** Drain all entity pages from validateEntities and return the concatenated issue list. */
async function drainEntityIssues(
  repo: MemoryRepository,
  take = 200,
): Promise<{ issues: EntityValidationIssue[]; totalScanned: number }> {
  const issues: EntityValidationIssue[] = [];
  let offset = 0;
  let totalScanned = 0;
  while (true) {
    const page = await repo.validateEntities({ offset, take });
    issues.push(...page.issues);
    totalScanned += page.scanned;
    offset = page.nextOffset;
    if (page.done) break;
  }
  return { issues, totalScanned };
}

async function drainRelationshipIssues(
  repo: MemoryRepository,
  take = 200,
): Promise<{ issues: RelationshipValidationIssue[]; totalScanned: number }> {
  const issues: RelationshipValidationIssue[] = [];
  let offset = 0;
  let totalScanned = 0;
  while (true) {
    const page = await repo.validateRelationships({ offset, take });
    issues.push(...page.issues);
    totalScanned += page.scanned;
    offset = page.nextOffset;
    if (page.done) break;
  }
  return { issues, totalScanned };
}

describe('RepositoryValidator', () => {
  let memory: DeepMemory;
  let storage: InMemoryStorageProvider;
  let repo: MemoryRepository;

  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    memory = new DeepMemory({
      storage,
      provenance: { actorId: ACTOR, actorType: 'agent' },
    });
    repo = await memory.createRepository({
      repositoryId: REPO_ID,
      label: 'Validation Test Repo',
      vocabulary,
      governance: { mode: 'open' },
    });
  });

  /**
   * Insert a StoredEntity straight into the storage provider, bypassing the
   * write-path vocabulary validation. This is how we manufacture the kinds of
   * corrupt data this validator is meant to detect.
   */
  async function directWriteEntity(entity: Partial<StoredEntity> & { id: string; entityType: string; label: string; slug: string }): Promise<StoredEntity> {
    const full: StoredEntity = {
      properties: {},
      provenance: provenance(),
      ...entity,
    };
    await storage.createEntity(REPO_ID, full);
    return full;
  }

  async function directWriteRelationship(rel: Partial<StoredRelationship> & { id: string; relationshipType: string; sourceEntityId: string; targetEntityId: string }): Promise<StoredRelationship> {
    const full: StoredRelationship = {
      properties: {},
      bidirectional: false,
      provenance: provenance(),
      ...rel,
    };
    await storage.createRelationship(REPO_ID, full);
    return full;
  }

  describe('validateEntities', () => {
    it('returns done=true immediately on an empty repository', async () => {
      const page = await repo.validateEntities();
      expect(page.issues).toHaveLength(0);
      expect(page.scanned).toBe(0);
      expect(page.nextOffset).toBe(0);
      expect(page.done).toBe(true);
    });

    it('returns no issues when everything was created through the normal API', async () => {
      await repo.createEntities([
        { entityType: 'person', label: 'Alice', properties: { role: 'engineer' } },
        { entityType: 'person', label: 'Bob', properties: { role: 'designer' } },
        { entityType: 'project', label: 'Apollo' },
      ]);

      const { issues, totalScanned } = await drainEntityIssues(repo);
      expect(issues).toHaveLength(0);
      expect(totalScanned).toBe(3);
    });

    it('flags an entity with an unknown type', async () => {
      await directWriteEntity({
        id: '10000000-0000-4000-a000-000000000001',
        entityType: 'not-in-vocab',
        label: 'Mystery',
        slug: 'not-in-vocab:mystery',
      });

      const { issues } = await drainEntityIssues(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.entityType).toBe('not-in-vocab');
      expect(issues[0]!.errors.some((e) => e.field === 'entityType')).toBe(true);
    });

    it('flags an entity missing a required property', async () => {
      await directWriteEntity({
        id: '10000000-0000-4000-a000-000000000002',
        entityType: 'person',
        label: 'Missing Role',
        slug: 'person:missing-role',
        properties: {},
      });

      const { issues } = await drainEntityIssues(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.errors.some((e) => e.field === 'properties.role')).toBe(true);
    });

    it('flags an entity with an unknown property', async () => {
      await directWriteEntity({
        id: '10000000-0000-4000-a000-000000000003',
        entityType: 'person',
        label: 'Weird Props',
        slug: 'person:weird-props',
        properties: { role: 'engineer', favouriteColour: 'blue' },
      });

      const { issues } = await drainEntityIssues(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.errors.some((e) => e.field === 'properties.favouriteColour')).toBe(true);
    });

    it('flags an entity with a wrong-typed property value', async () => {
      await directWriteEntity({
        id: '10000000-0000-4000-a000-000000000004',
        entityType: 'person',
        label: 'Wrong Types',
        slug: 'person:wrong-types',
        properties: { role: 'engineer', age: 'not-a-number' },
      });

      const { issues } = await drainEntityIssues(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.errors.some((e) => e.field === 'properties.age')).toBe(true);
    });

    it('pages through entity issues using offset/take and returns done=false mid-stream', async () => {
      for (let i = 0; i < 7; i++) {
        await directWriteEntity({
          id: `10000000-0000-4000-a000-00000000001${i}`,
          entityType: 'not-in-vocab',
          label: `Bad ${i}`,
          slug: `not-in-vocab:bad-${i}`,
        });
      }

      const page1 = await repo.validateEntities({ offset: 0, take: 3 });
      expect(page1.scanned).toBe(3);
      expect(page1.nextOffset).toBe(3);
      expect(page1.done).toBe(false);
      expect(page1.issues).toHaveLength(3);

      // Under issue-space paging, page 2 rescans from the start of the export
      // stream and skips the first 3 issues before collecting the next window.
      const page2 = await repo.validateEntities({ offset: page1.nextOffset, take: 3 });
      expect(page2.scanned).toBe(6);
      expect(page2.nextOffset).toBe(6);
      expect(page2.done).toBe(false);
      expect(page2.issues).toHaveLength(3);

      const page3 = await repo.validateEntities({ offset: page2.nextOffset, take: 3 });
      expect(page3.scanned).toBe(7);
      expect(page3.nextOffset).toBe(7);
      expect(page3.done).toBe(true);
      expect(page3.issues).toHaveLength(1);
    });

    it('surfaces every issue even when they are sparsely distributed across valid entities', async () => {
      // 5 valid + 3 invalid. With a small issue-take of 2, the first page
      // has to scan past all the valid entities before finding its two issues.
      for (let i = 0; i < 5; i++) {
        await repo.createEntities([
          { entityType: 'person', label: `Good ${i}`, properties: { role: 'engineer' } },
        ]);
      }
      for (let i = 0; i < 3; i++) {
        await directWriteEntity({
          id: `10000000-0000-4000-a000-00000000002${i}`,
          entityType: 'not-in-vocab',
          label: `Bad ${i}`,
          slug: `not-in-vocab:bad-${i}`,
        });
      }

      const { issues } = await drainEntityIssues(repo, 2);
      expect(issues).toHaveLength(3);
    });
  });

  describe('validateRelationships', () => {
    it('returns done=true immediately on an empty repository', async () => {
      const page = await repo.validateRelationships();
      expect(page.issues).toHaveLength(0);
      expect(page.scanned).toBe(0);
      expect(page.nextOffset).toBe(0);
      expect(page.done).toBe(true);
      expect(page.entitiesInMap).toBe(0);
    });

    it('returns no issues when everything was created through the normal API', async () => {
      const [alice, bob] = await repo.createEntities([
        { entityType: 'person', label: 'Alice', properties: { role: 'engineer' } },
        { entityType: 'person', label: 'Bob', properties: { role: 'designer' } },
      ]);
      const [proj] = await repo.createEntities([
        { entityType: 'project', label: 'Apollo' },
      ]);
      await repo.createRelationships([
        { relationshipType: 'works_on', sourceEntityId: alice!.id, targetEntityId: proj!.id },
        { relationshipType: 'works_on', sourceEntityId: bob!.id, targetEntityId: proj!.id },
      ]);

      const { issues, totalScanned } = await drainRelationshipIssues(repo);
      expect(issues).toHaveLength(0);
      expect(totalScanned).toBe(2);
    });

    it('flags a relationship with an unknown type', async () => {
      const [alice] = await repo.createEntities([
        { entityType: 'person', label: 'Alice', properties: { role: 'engineer' } },
      ]);
      const [proj] = await repo.createEntities([
        { entityType: 'project', label: 'Apollo' },
      ]);
      await directWriteRelationship({
        id: '20000000-0000-4000-a000-000000000001',
        relationshipType: 'MADE_UP_TYPE',
        sourceEntityId: alice!.id,
        targetEntityId: proj!.id,
      });

      const { issues } = await drainRelationshipIssues(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.errors.some((e) => e.field === 'relationshipType')).toBe(true);
    });

    it('flags a relationship with a disallowed source type', async () => {
      const [proj1] = await repo.createEntities([{ entityType: 'project', label: 'Apollo' }]);
      const [proj2] = await repo.createEntities([{ entityType: 'project', label: 'Gemini' }]);
      await directWriteRelationship({
        id: '20000000-0000-4000-a000-000000000002',
        relationshipType: 'works_on',
        sourceEntityId: proj1!.id,
        targetEntityId: proj2!.id,
      });

      const { issues } = await drainRelationshipIssues(repo);
      expect(issues).toHaveLength(1);
      expect(issues[0]!.errors.some((e) => e.field === 'sourceEntityId')).toBe(true);
    });

    it('flags a relationship with a disallowed target type (EuroTech-style)', async () => {
      const [alice] = await repo.createEntities([
        { entityType: 'person', label: 'Alice', properties: { role: 'attendee' } },
      ]);
      const [summit] = await repo.createEntities([
        { entityType: 'company', label: 'EuroTech Summit' },
      ]);
      await directWriteRelationship({
        id: '20000000-0000-4000-a000-000000000003',
        relationshipType: 'INVOLVED_IN',
        sourceEntityId: alice!.id,
        targetEntityId: summit!.id,
      });

      const { issues } = await drainRelationshipIssues(repo);
      expect(issues).toHaveLength(1);
      const issue = issues[0]!;
      expect(issue.errors.some((e) => e.field === 'targetEntityId')).toBe(true);
      expect(issue.sourceEntityType).toBe('person');
      expect(issue.targetEntityType).toBe('company');
      expect(issue.targetLabel).toBe('EuroTech Summit');
    });

    it('flags orphaned relationships where the source is missing', async () => {
      const [proj] = await repo.createEntities([{ entityType: 'project', label: 'Apollo' }]);
      await directWriteRelationship({
        id: '20000000-0000-4000-a000-000000000004',
        relationshipType: 'works_on',
        sourceEntityId: 'ffffffff-ffff-4fff-afff-000000000001',
        targetEntityId: proj!.id,
      });

      const { issues } = await drainRelationshipIssues(repo);
      expect(issues).toHaveLength(1);
      const issue = issues[0]!;
      expect(issue.errors.some((e) => e.field === 'sourceEntityId' && /does not exist/.test(e.message))).toBe(true);
      expect(issue.sourceEntityType).toBeUndefined();
    });

    it('flags fully-orphaned relationships with no type-mismatch noise', async () => {
      await directWriteRelationship({
        id: '20000000-0000-4000-a000-000000000005',
        relationshipType: 'works_on',
        sourceEntityId: 'ffffffff-ffff-4fff-afff-000000000002',
        targetEntityId: 'ffffffff-ffff-4fff-afff-000000000003',
      });

      const { issues } = await drainRelationshipIssues(repo);
      expect(issues).toHaveLength(1);
      const issue = issues[0]!;
      expect(issue.errors).toHaveLength(2);
      expect(issue.errors.some((e) => e.field === 'sourceEntityId')).toBe(true);
      expect(issue.errors.some((e) => e.field === 'targetEntityId')).toBe(true);
    });

    it('pages through relationship issues using offset/take', async () => {
      const [alice] = await repo.createEntities([
        { entityType: 'person', label: 'Alice', properties: { role: 'engineer' } },
      ]);
      const [proj] = await repo.createEntities([
        { entityType: 'project', label: 'Apollo' },
      ]);

      for (let i = 0; i < 7; i++) {
        await directWriteRelationship({
          id: `20000000-0000-4000-a000-00000000010${i}`,
          relationshipType: 'MADE_UP_TYPE',
          sourceEntityId: alice!.id,
          targetEntityId: proj!.id,
        });
      }

      const page1 = await repo.validateRelationships({ offset: 0, take: 3 });
      expect(page1.scanned).toBe(3);
      expect(page1.nextOffset).toBe(3);
      expect(page1.done).toBe(false);
      expect(page1.issues).toHaveLength(3);
      expect(page1.entitiesInMap).toBe(2);

      // Issue-space paging rescans from the start each call.
      const page2 = await repo.validateRelationships({ offset: page1.nextOffset, take: 3 });
      expect(page2.scanned).toBe(6);
      expect(page2.nextOffset).toBe(6);
      expect(page2.done).toBe(false);
      expect(page2.issues).toHaveLength(3);

      const page3 = await repo.validateRelationships({ offset: page2.nextOffset, take: 3 });
      expect(page3.scanned).toBe(7);
      expect(page3.nextOffset).toBe(7);
      expect(page3.done).toBe(true);
      expect(page3.issues).toHaveLength(1);

      const total = page1.issues.length + page2.issues.length + page3.issues.length;
      expect(total).toBe(7);
    });
  });
});
