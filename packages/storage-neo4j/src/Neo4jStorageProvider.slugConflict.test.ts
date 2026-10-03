// Concurrent writes that pick the same slug (live).
//
// The engine picks a free slug by reading the store, then writes. Writes
// racing through that window pick the same slug; the `dm_entity_slug_unique`
// constraint refuses all but one, the provider maps each violation to
// SlugConflictError, and the engine retries with the next free slug. Every
// write must therefore succeed with a distinct slug.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DeepMemory, SlugConflictError } from '@utaba/deep-memory';
import type { MemoryRepository } from '@utaba/deep-memory';
import type { EntityReadOptions } from '@utaba/deep-memory';
import type { StoredEntity } from '@utaba/deep-memory/types';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

/** Longest a barrier waits for the remaining racers before letting reads through. */
const BARRIER_TIMEOUT_MS = 5_000;

/**
 * Counts the slug clashes the store reports, and can hold reads of one slug
 * until a given number of readers have arrived — so concurrent writes are
 * guaranteed to see the slug as free together, and to race for it.
 */
class RacingNeo4jStorageProvider extends Neo4jStorageProvider {
  public slugConflicts = 0;
  private barrier: { slug: string; waiting: number; release: Promise<void>; open: () => void } | undefined;

  /** Hold the next `readers` reads of `slug` until all of them have completed. */
  public holdReadsOf(slug: string, readers: number): void {
    let open = (): void => {};
    const release = new Promise<void>((resolve) => {
      open = resolve;
    });
    this.barrier = { slug, waiting: readers, release, open };
    setTimeout(open, BARRIER_TIMEOUT_MS).unref();
  }

  public override async getEntityBySlug(
    repositoryId: string,
    slug: string,
    options?: EntityReadOptions,
  ): Promise<StoredEntity | null> {
    // Read first, then wait: every racer has observed the slug as free before
    // any of them goes on to write it.
    const result = await super.getEntityBySlug(repositoryId, slug, options);
    const barrier = this.barrier;
    if (barrier !== undefined && barrier.slug === slug && barrier.waiting > 0) {
      barrier.waiting--;
      if (barrier.waiting === 0) {
        this.barrier = undefined;
        barrier.open();
      }
      await barrier.release;
    }
    return result;
  }

  public override async createEntity(repositoryId: string, entity: StoredEntity): Promise<StoredEntity> {
    try {
      return await super.createEntity(repositoryId, entity);
    } catch (err) {
      if (err instanceof SlugConflictError) this.slugConflicts++;
      throw err;
    }
  }
}

if (NEO4J_URI) {
  describe('Neo4jStorageProvider — concurrent writes with the same slug (live)', () => {
    const repoId = randomUUID();
    let provider: RacingNeo4jStorageProvider | undefined;
    let memory: DeepMemory | undefined;
    let repo: MemoryRepository;

    beforeAll(async () => {
      provider = new RacingNeo4jStorageProvider({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      await provider.initialize();
      await provider.ensureSchema();
      memory = new DeepMemory({
        storage: provider,
        provenance: { actorId: 'slug-race-test', actorType: 'agent' },
      });
      repo = await memory.createRepository({
        repositoryId: repoId,
        label: 'Slug race',
        vocabulary: {
          entityTypes: [{ type: 'Person', description: 'A person' }],
          relationshipTypes: [],
        },
        governance: { mode: 'open' },
      });
    });

    afterAll(async () => {
      if (provider !== undefined && (await provider.getRepository(repoId)) !== null) {
        await provider.deleteRepository(repoId);
      }
      if (memory !== undefined) {
        await memory.dispose();
      } else if (provider !== undefined) {
        await provider.dispose();
      }
    });

    it('createEntity refuses a taken slug with SlugConflictError, keeping the driver error as cause', async () => {
      const [first] = await repo.createEntities([{ entityType: 'Person', label: 'Sam' }]);
      const now = new Date().toISOString();
      const clash: StoredEntity = {
        id: 'slug-clash-direct',
        slug: first!.slug,
        entityType: 'Person',
        label: 'Sam',
        properties: {},
        provenance: {
          createdBy: 'slug-race-test',
          createdByType: 'agent',
          createdAt: now,
          modifiedBy: 'slug-race-test',
          modifiedByType: 'agent',
          modifiedAt: now,
        },
      };

      const rejection = provider!.createEntity(repoId, clash);
      await expect(rejection).rejects.toBeInstanceOf(SlugConflictError);
      await expect(rejection).rejects.toMatchObject({
        code: 'SLUG_CONFLICT',
        slug: first!.slug,
        cause: { code: 'Neo.ClientError.Schema.ConstraintValidationFailed' },
      });
    });

    it('two parallel creates with the same type and label both succeed with distinct slugs', async () => {
      provider!.holdReadsOf('Person:alex', 2);
      const before = provider!.slugConflicts;

      const results = await Promise.all([
        repo.createEntities([{ entityType: 'Person', label: 'Alex' }]),
        repo.createEntities([{ entityType: 'Person', label: 'Alex' }]),
      ]);

      const slugs = results.map(([entity]) => entity!.slug);
      expect([...slugs].sort()).toEqual(['Person:alex', 'Person:alex-2']);
      // Both read the slug as free together, so the store refused one write.
      expect(provider!.slugConflicts - before).toBe(1);
    });

    it('a burst of four parallel creates with the same type and label all succeed with distinct slugs', async () => {
      provider!.holdReadsOf('Person:jordan', 4);
      const before = provider!.slugConflicts;

      const results = await Promise.all(
        Array.from({ length: 4 }, () => repo.createEntities([{ entityType: 'Person', label: 'Jordan' }])),
      );

      const slugs = results.map(([entity]) => entity!.slug);
      expect(new Set(slugs).size).toBe(4);
      for (const [entity] of results) {
        expect(await repo.getEntity(entity!.id)).not.toBeNull();
      }
      expect(provider!.slugConflicts - before).toBeGreaterThanOrEqual(3);
    });

    it('a label change that races another onto the same slug is retried with the next slug', async () => {
      const [a, b] = await repo.createEntities([
        { entityType: 'Person', label: 'Pat One' },
        { entityType: 'Person', label: 'Pat Two' },
      ]);
      provider!.holdReadsOf('Person:robin', 2);

      const [ua, ub] = await Promise.all([
        repo.updateEntity(a!.id, { label: 'Robin' }),
        repo.updateEntity(b!.id, { label: 'Robin' }),
      ]);

      expect([ua.slug, ub.slug].sort()).toEqual(['Person:robin', 'Person:robin-2']);
    });
  });
} else {
  describe('Neo4jStorageProvider — concurrent writes with the same slug', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
