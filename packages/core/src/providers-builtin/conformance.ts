// Provider Conformance Test Suite
// Any StorageProvider implementer can import and run these tests to verify conformance.
//
// Usage:
//   import { runStorageProviderConformanceTests } from '@utaba/deep-memory';
//   runStorageProviderConformanceTests(() => new MyStorageProvider());

import { describe, it, expect, beforeEach } from 'vitest';
import type { StorageProvider } from '../providers/StorageProvider.js';
import type { GraphTraversalProvider } from '../providers/GraphTraversalProvider.js';
import type { StoredEntity } from '../types/entities.js';
import type { StoredRelationship } from '../types/relationships.js';
import type { Provenance } from '../types/provenance.js';
import type { MemoryVocabulary } from '../types/vocabulary.js';
import type { DeepMemoryErrorCode } from '../core/errors.js';

/**
 * Error shape asserted for typed provider errors.
 *
 * The suite is published as its own bundle (`@utaba/deep-memory/testing`),
 * which carries a separate copy of the error classes from the one a provider
 * imports from `@utaba/deep-memory`. `instanceof` therefore cannot be relied
 * on across that boundary; `name` and `code` are the stable contract.
 */
/**
 * Timeout for a case that makes many sequential round trips. Against a
 * remote store each round trip can take hundreds of milliseconds (a CosmosDB
 * emulator in particular), so these outrun vitest's 5 s default without
 * anything being wrong.
 */
const MULTI_STEP_TEST_TIMEOUT_MS = 30_000;

function typedError(
  name: string,
  code: DeepMemoryErrorCode,
  fields: Record<string, string> = {},
): Record<string, string> {
  return { name, code, ...fields };
}

/** Whether the provider under test also serves native traversal. */
function isGraphTraversalProvider(
  provider: StorageProvider,
): provider is StorageProvider & GraphTraversalProvider {
  return 'traverse' in provider && typeof provider.traverse === 'function';
}

function makeProvenance(): Provenance {
  const now = new Date().toISOString();
  return {
    createdBy: 'conformance-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'conformance-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function makeEntity(id: string, type = 'test-type', label?: string): StoredEntity {
  return {
    id,
    slug: `${type}:${(label ?? id).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    entityType: type,
    label: label ?? id,
    summary: `Summary for ${id}`,
    properties: { key: 'value' },
    provenance: makeProvenance(),
  };
}

function makeRelationship(
  id: string,
  type: string,
  sourceId: string,
  targetId: string,
  bidirectional = false,
): StoredRelationship {
  return {
    id,
    relationshipType: type,
    sourceEntityId: sourceId,
    targetEntityId: targetId,
    properties: {},
    bidirectional,
    provenance: makeProvenance(),
  };
}

/**
 * Run the full StorageProvider conformance test suite.
 *
 * @param factory - A function that creates a fresh, empty StorageProvider instance.
 *                  Called before each test to ensure isolation.
 */
export function runStorageProviderConformanceTests(
  factory: () => StorageProvider | Promise<StorageProvider>,
): void {
  // Use a stable GUID so external cleanup scripts can target it
  const repoId = '40000000-0000-4000-a000-000000000001';

  let provider: StorageProvider;

  async function createConformanceRepository(): Promise<void> {
    await provider.createRepository({
      repositoryId: repoId,
      label: 'Conformance Test',
      governanceConfig: { mode: 'open' },
      createdAt: new Date().toISOString(),
      createdBy: 'conformance-test',
    });
  }

  async function setup(): Promise<void> {
    provider = await factory();
    if (provider.initialize) await provider.initialize();
    await createConformanceRepository();
  }

  describe('StorageProvider Conformance Tests', () => {
    beforeEach(async () => {
      await setup();
    });

    // ─── Repository ─────────────────────────────────────────

    describe('repository operations', () => {
      it('creates a repository', async () => {
        const repo = await provider.getRepository(repoId);
        expect(repo).not.toBeNull();
        expect(repo!.repositoryId).toBe(repoId);
        expect(repo!.label).toBe('Conformance Test');
      });

      it('returns null for non-existent repository', async () => {
        const repo = await provider.getRepository('ffffffff-ffff-4fff-afff-ffffffffffff');
        expect(repo).toBeNull();
      });

      it('lists repositories', async () => {
        const list = await provider.listRepositories();
        expect(list.items.length).toBeGreaterThanOrEqual(1);
        expect(list.items.some((r) => r.repositoryId === repoId)).toBe(true);
      });

      it('updates a repository', async () => {
        const updated = await provider.updateRepository(repoId, {
          label: 'Updated Label',
          description: 'Updated description',
          governanceConfig: { mode: 'open', defaultSimilarityThreshold: 0.4 },
        });
        expect(updated.label).toBe('Updated Label');
        expect(updated.description).toBe('Updated description');
        expect(updated.governanceConfig.defaultSimilarityThreshold).toBe(0.4);

        // Verify persistence
        const fetched = await provider.getRepository(repoId);
        expect(fetched!.label).toBe('Updated Label');
        expect(fetched!.governanceConfig.defaultSimilarityThreshold).toBe(0.4);
      });

      it('deletes a repository', async () => {
        await expect(provider.deleteRepository(repoId)).resolves.toEqual({
          deletedEntities: 0,
          deletedRelationships: 0,
        });
        expect(await provider.getRepository(repoId)).toBeNull();
      });

      it('deleteRepository throws RepositoryNotFoundError for an unknown repository', async () => {
        await expect(
          provider.deleteRepository('ffffffff-ffff-4fff-afff-ffffffffffff'),
        ).rejects.toMatchObject(typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'));
      });

      it('createRepository seeds the provided vocabulary', async () => {
        // Recreate the stable repository so per-test cleanup by id still covers it.
        await provider.deleteRepository(repoId);
        const now = new Date().toISOString();
        const seeded: MemoryVocabulary = {
          version: '2.0.0',
          lastModified: now,
          modifiedBy: 'conformance-test',
          entityTypes: [
            {
              type: 'seeded-type',
              description: 'Entity type supplied at repository creation',
              version: '1.0.0',
              properties: [],
              createdAt: now,
              createdBy: 'conformance-test',
              modifiedAt: now,
              modifiedBy: 'conformance-test',
            },
          ],
          relationshipTypes: [],
        };
        await provider.createRepository({
          repositoryId: repoId,
          label: 'Conformance Test',
          governanceConfig: { mode: 'open' },
          vocabulary: seeded,
          createdAt: now,
          createdBy: 'conformance-test',
        });

        const vocab = await provider.getVocabulary(repoId);
        expect(vocab.version).toBe('2.0.0');
        expect(vocab.entityTypes.map((t) => t.type)).toEqual(['seeded-type']);
      });

      it('createRepository seeds an empty vocabulary when omitted', async () => {
        const vocab = await provider.getVocabulary(repoId);
        expect(typeof vocab.version).toBe('string');
        expect(vocab.entityTypes).toEqual([]);
      });

      it('returns repository stats', async () => {
        const stats = await provider.getRepositoryStats(repoId);
        expect(stats.entityCount).toBe(0);
        expect(stats.relationshipCount).toBe(0);
        expect(typeof stats.vocabularyVersion).toBe('string');
      });
    });

    // ─── Vocabulary ─────────────────────────────────────────

    describe('vocabulary operations', () => {
      it('gets and saves vocabulary', async () => {
        const vocab = await provider.getVocabulary(repoId);
        expect(vocab).toBeDefined();
        expect(typeof vocab.version).toBe('string');

        const updated = { ...vocab, version: '1.0.0' };
        await provider.saveVocabulary(repoId, updated, vocab.version);

        const fetched = await provider.getVocabulary(repoId);
        expect(fetched.version).toBe('1.0.0');
      });

      it('saveVocabulary rejects a stale version', async () => {
        const v0 = await provider.getVocabulary(repoId);
        await provider.saveVocabulary(repoId, { ...v0, version: '1.0.0' }, v0.version);

        // A second writer that also read v0 must not overwrite the first write.
        const stale = provider.saveVocabulary(repoId, { ...v0, version: '1.0.1' }, v0.version);
        await expect(stale).rejects.toMatchObject(
          typedError('VocabularyVersionConflictError', 'VOCABULARY_VERSION_CONFLICT', {
            repositoryId: repoId,
            expectedVersion: v0.version,
            actualVersion: '1.0.0',
          }),
        );

        const fetched = await provider.getVocabulary(repoId, { fresh: true });
        expect(fetched.version).toBe('1.0.0');
      });

      it('saveVocabulary throws RepositoryNotFoundError for a deleted repository', async () => {
        const vocab = await provider.getVocabulary(repoId);
        await provider.deleteRepository(repoId);

        await expect(
          provider.saveVocabulary(repoId, { ...vocab, version: '1.0.0' }, vocab.version),
        ).rejects.toMatchObject(typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'));
        expect(await provider.getRepository(repoId)).toBeNull();
      });

      it('getVocabulary with { fresh: true } returns the stored value', async () => {
        // The plain read may populate a provider-side cache; the fresh read must not be served from it.
        const v0 = await provider.getVocabulary(repoId);
        await provider.saveVocabulary(repoId, { ...v0, version: '1.0.0' }, v0.version);

        const fetched = await provider.getVocabulary(repoId, { fresh: true });
        expect(fetched.version).toBe('1.0.0');
      });

      it('returns vocabulary change log', async () => {
        const log = await provider.getVocabularyChangeLog(repoId);
        expect(Array.isArray(log.items)).toBe(true);
      });
    });

    // ─── Entities ───────────────────────────────────────────

    describe('entity operations', () => {
      it('creates and retrieves an entity', async () => {
        const entity = makeEntity('e1');
        await provider.createEntity(repoId, entity);

        const retrieved = await provider.getEntity(repoId, 'e1');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe('e1');
        expect(retrieved!.label).toBe('e1');
      });

      it('retrieves an entity by slug', async () => {
        const entity = makeEntity('e1', 'test-type', 'Alpha');
        await provider.createEntity(repoId, entity);

        const retrieved = await provider.getEntityBySlug(repoId, entity.slug);
        expect(retrieved).not.toBeNull();
        expect(retrieved!.id).toBe('e1');
        expect(retrieved!.slug).toBe(entity.slug);
      });

      it('returns null for non-existent entity', async () => {
        const result = await provider.getEntity(repoId, 'nonexistent');
        expect(result).toBeNull();
      });

      it('returns null for non-existent slug', async () => {
        const result = await provider.getEntityBySlug(repoId, 'nonexistent:slug');
        expect(result).toBeNull();
      });

      it('batch retrieves entities', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.createEntity(repoId, makeEntity('e2'));

        const map = await provider.getEntities(repoId, ['e1', 'e2', 'missing']);
        expect(map.size).toBe(2);
        expect(map.has('e1')).toBe(true);
        expect(map.has('e2')).toBe(true);
        expect(map.has('missing')).toBe(false);
      });

      it('updates an entity', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        const updated = await provider.updateEntity(repoId, 'e1', {
          label: 'Updated Label',
          provenance: makeProvenance(),
        });
        expect(updated.label).toBe('Updated Label');

        const fetched = await provider.getEntity(repoId, 'e1');
        expect(fetched!.label).toBe('Updated Label');
      });

      it('clears summary/data/dataFormat when null is passed', async () => {
        const entity: StoredEntity = {
          ...makeEntity('e1'),
          summary: 'starting summary',
          data: 'raw content',
          dataFormat: 'text/plain',
        };
        await provider.createEntity(repoId, entity);

        await provider.updateEntity(repoId, 'e1', {
          summary: null,
          data: null,
          dataFormat: null,
          provenance: makeProvenance(),
        });

        const fetched = await provider.getEntity(repoId, 'e1');
        expect(fetched!.summary).toBeUndefined();
        expect(fetched!.data).toBeUndefined();
        expect(fetched!.dataFormat).toBeUndefined();
      });

      it('preserves summary/data/dataFormat when undefined is passed', async () => {
        const entity: StoredEntity = {
          ...makeEntity('e1'),
          summary: 'keep me',
          data: 'keep me too',
          dataFormat: 'text/plain',
        };
        await provider.createEntity(repoId, entity);

        await provider.updateEntity(repoId, 'e1', {
          label: 'Renamed',
          provenance: makeProvenance(),
        });

        const fetched = await provider.getEntity(repoId, 'e1');
        expect(fetched!.summary).toBe('keep me');
        expect(fetched!.data).toBe('keep me too');
        expect(fetched!.dataFormat).toBe('text/plain');
      });

      it('deletes an entity', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.deleteEntity(repoId, 'e1');
        expect(await provider.getEntity(repoId, 'e1')).toBeNull();
      });

      it('deleting an entity id that never existed throws EntityNotFoundError', async () => {
        await expect(provider.deleteEntity(repoId, 'never-existed')).rejects.toMatchObject(
          typedError('EntityNotFoundError', 'ENTITY_NOT_FOUND', { id: 'never-existed' }),
        );
      });

      it('deleting the same entity twice throws EntityNotFoundError the second time', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.deleteEntity(repoId, 'e1');
        await expect(provider.deleteEntity(repoId, 'e1')).rejects.toMatchObject(
          typedError('EntityNotFoundError', 'ENTITY_NOT_FOUND', { id: 'e1' }),
        );
      });

      it('finds entities by search term', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'test-type', 'Alpha'));
        await provider.createEntity(repoId, makeEntity('e2', 'test-type', 'Beta'));

        const result = await provider.findEntities(repoId, {
          searchTerm: 'alpha',
          limit: 10,
          offset: 0,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.label).toBe('Alpha');
      });

      it('finds entities by search term case-insensitively', async () => {
        // Locks the invariant that searchTerm matching is case-insensitive on
        // every provider. In-memory lowercases both sides; SQL Server's LIKE
        // is case-insensitive under the default *_CI_AS collation; Cosmos
        // routes through CONTAINS(..., @term, true) on the Document endpoint.
        await provider.createEntity(repoId, makeEntity('e1', 'test-type', 'Alpha'));

        const result = await provider.findEntities(repoId, {
          searchTerm: 'ALPHA',
          limit: 10,
          offset: 0,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.label).toBe('Alpha');
      });

      it('finds entities by type filter', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'type-a', 'A'));
        await provider.createEntity(repoId, makeEntity('e2', 'type-b', 'B'));

        const result = await provider.findEntities(repoId, {
          entityTypes: ['type-a'],
          limit: 10,
          offset: 0,
        });
        expect(result.items).toHaveLength(1);
        expect(result.items[0]!.entityType).toBe('type-a');
      });

      it('paginates find results', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.createEntity(repoId, makeEntity('e2'));
        await provider.createEntity(repoId, makeEntity('e3'));

        const page1 = await provider.findEntities(repoId, { limit: 2, offset: 0 });
        expect(page1.items).toHaveLength(2);
        expect(page1.hasMore).toBe(true);

        const page2 = await provider.findEntities(repoId, { limit: 2, offset: 2 });
        expect(page2.items).toHaveLength(1);
        expect(page2.hasMore).toBe(false);
      });

      it('createEntity rejects an existing id with DuplicateEntityError', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'test-type', 'Alpha'));

        await expect(
          provider.createEntity(repoId, makeEntity('e1', 'test-type', 'Beta')),
        ).rejects.toMatchObject(typedError('DuplicateEntityError', 'ENTITY_ALREADY_EXISTS', { id: 'e1' }));
      });

      it('createEntity refuses a slug another entity holds with SlugConflictError', async () => {
        // Slugs are unique per repository. The refusal must name the slug, not
        // the new id (no entity has that id), so the engine can retry with the
        // next free slug.
        const first = makeEntity('e1', 'test-type', 'Alpha');
        const second = makeEntity('e2', 'test-type', 'Alpha');
        expect(second.slug).toBe(first.slug);
        await provider.createEntity(repoId, first);

        await expect(provider.createEntity(repoId, second)).rejects.toMatchObject(
          typedError('SlugConflictError', 'SLUG_CONFLICT', { slug: first.slug }),
        );
        expect(await provider.getEntity(repoId, 'e2')).toBeNull();
        expect((await provider.getEntityBySlug(repoId, first.slug))?.id).toBe('e1');
      });

      it('updateEntity refuses a slug another entity holds and leaves the entity unchanged', async () => {
        const first = makeEntity('e1', 'test-type', 'Alpha');
        const second = makeEntity('e2', 'test-type', 'Beta');
        await provider.createEntity(repoId, first);
        await provider.createEntity(repoId, second);

        await expect(
          provider.updateEntity(repoId, 'e2', {
            label: 'Alpha',
            slug: first.slug,
            provenance: makeProvenance(),
          }),
        ).rejects.toMatchObject(typedError('SlugConflictError', 'SLUG_CONFLICT', { slug: first.slug }));

        const unchanged = await provider.getEntity(repoId, 'e2');
        expect(unchanged!.slug).toBe(second.slug);
        expect(unchanged!.label).toBe('Beta');
        expect((await provider.getEntityBySlug(repoId, first.slug))?.id).toBe('e1');
        expect((await provider.getEntityBySlug(repoId, second.slug))?.id).toBe('e2');
      });

      it("updateEntity accepts the entity's own current slug", async () => {
        const entity = makeEntity('e1', 'test-type', 'Alpha');
        await provider.createEntity(repoId, entity);

        const updated = await provider.updateEntity(repoId, 'e1', {
          summary: 'Revised',
          slug: entity.slug,
          provenance: makeProvenance(),
        });

        expect(updated.slug).toBe(entity.slug);
        expect((await provider.getEntityBySlug(repoId, entity.slug))?.id).toBe('e1');
      });

      it('createEntity throws RepositoryNotFoundError after the repository is deleted', async () => {
        await provider.deleteRepository(repoId);

        await expect(provider.createEntity(repoId, makeEntity('e1'))).rejects.toMatchObject(
          typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'),
        );
        expect(await provider.getRepository(repoId)).toBeNull();
      });

      it('deleteEntitiesByType removes that type and its edges, and leaves the rest of the repository', async () => {
        await provider.createEntity(repoId, makeEntity('d1', 'doomed-type'));
        await provider.createEntity(repoId, makeEntity('d2', 'doomed-type'));
        await provider.createEntity(repoId, makeEntity('k1'));
        await provider.createEntity(repoId, makeEntity('k2'));
        await provider.createRelationship(repoId, makeRelationship('rd1', 'connects', 'd1', 'k1'));
        await provider.createRelationship(repoId, makeRelationship('rk', 'connects', 'k1', 'k2'));
        await provider.createRelationship(repoId, makeRelationship('rd2', 'connects', 'k2', 'd2'));

        const result = await provider.deleteEntitiesByType(repoId, 'doomed-type');
        expect(result.deletedEntities).toBe(2);
        // A provider that cannot count the cascaded edges cheaply reports undefined.
        if (result.deletedRelationships !== undefined) expect(result.deletedRelationships).toBe(2);

        expect(await provider.getEntity(repoId, 'd1')).toBeNull();
        expect(await provider.getEntity(repoId, 'd2')).toBeNull();
        expect(await provider.getRelationship(repoId, 'rd1')).toBeNull();
        expect(await provider.getRelationship(repoId, 'rd2')).toBeNull();
        expect((await provider.getRelationship(repoId, 'rk'))?.id).toBe('rk');
        const k1Edges = await provider.getEntityRelationships(repoId, 'k1');
        expect(k1Edges.items.map((r) => r.id)).toEqual(['rk']);

        // The repository and its other entities are still there.
        expect(await provider.getRepository(repoId)).not.toBeNull();
        const survivors = await provider.getEntities(repoId, ['k1', 'k2', 'd1']);
        expect([...survivors.keys()].sort()).toEqual(['k1', 'k2']);
        expect((await provider.getEntityBySlug(repoId, 'test-type:k2'))?.id).toBe('k2');
      });
    });

    // ─── Relationships ──────────────────────────────────────

    describe('relationship operations', () => {
      beforeEach(async () => {
        await provider.createEntity(repoId, makeEntity('a'));
        await provider.createEntity(repoId, makeEntity('b'));
        await provider.createEntity(repoId, makeEntity('c'));
      });

      it('creates and retrieves a relationship', async () => {
        const rel = makeRelationship('r1', 'connects', 'a', 'b');
        await provider.createRelationship(repoId, rel);

        const retrieved = await provider.getRelationship(repoId, 'r1');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.sourceEntityId).toBe('a');
        expect(retrieved!.targetEntityId).toBe('b');
      });

      it('returns null for non-existent relationship', async () => {
        expect(await provider.getRelationship(repoId, 'nonexistent')).toBeNull();
      });

      it('creates a self-loop and lists it once', async () => {
        await provider.createRelationship(repoId, makeRelationship('loop', 'connects', 'a', 'a'));

        const retrieved = await provider.getRelationship(repoId, 'loop');
        expect(retrieved).not.toBeNull();
        expect(retrieved!.sourceEntityId).toBe('a');
        expect(retrieved!.targetEntityId).toBe('a');

        for (const direction of ['both', 'out', 'in'] as const) {
          const listed = await provider.getEntityRelationships(repoId, 'a', { direction });
          expect(listed.items.map((r) => r.id), direction).toEqual(['loop']);
          if (listed.total !== undefined) expect(listed.total, direction).toBe(1);
        }
      });

      it('gets entity relationships', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'connects', 'c', 'a'));

        const result = await provider.getEntityRelationships(repoId, 'a');
        expect(result.items).toHaveLength(2);
      });

      it('filters relationships by direction', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'connects', 'c', 'a'));

        const outbound = await provider.getEntityRelationships(repoId, 'a', { direction: 'out' });
        expect(outbound.items).toHaveLength(1);
        expect(outbound.items[0]!.targetEntityId).toBe('b');

        const inbound = await provider.getEntityRelationships(repoId, 'a', { direction: 'in' });
        expect(inbound.items).toHaveLength(1);
        expect(inbound.items[0]!.sourceEntityId).toBe('c');
      });

      it('deletes a relationship', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.deleteRelationship(repoId, 'r1');
        expect(await provider.getRelationship(repoId, 'r1')).toBeNull();
      });

      it('deleting a relationship id that never existed throws RelationshipNotFoundError', async () => {
        await expect(provider.deleteRelationship(repoId, 'never-existed')).rejects.toMatchObject(
          typedError('RelationshipNotFoundError', 'RELATIONSHIP_NOT_FOUND', { relationshipId: 'never-existed' }),
        );
      });

      it('deleting the same relationship twice throws RelationshipNotFoundError the second time', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.deleteRelationship(repoId, 'r1');
        await expect(provider.deleteRelationship(repoId, 'r1')).rejects.toMatchObject(
          typedError('RelationshipNotFoundError', 'RELATIONSHIP_NOT_FOUND', { relationshipId: 'r1' }),
        );
      });

      it('creating a relationship with an explicit id already in use throws DuplicateRelationshipError', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));

        // Same type, different endpoints.
        await expect(
          provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'b', 'c')),
        ).rejects.toMatchObject(
          typedError('DuplicateRelationshipError', 'RELATIONSHIP_ALREADY_EXISTS', { relationshipId: 'r1' }),
        );
        // A different type: the id is unique across every type in the repository.
        await expect(
          provider.createRelationship(repoId, makeRelationship('r1', 'mentions', 'a', 'b')),
        ).rejects.toMatchObject(
          typedError('DuplicateRelationshipError', 'RELATIONSHIP_ALREADY_EXISTS', { relationshipId: 'r1' }),
        );

        const original = await provider.getRelationship(repoId, 'r1');
        expect(original).toMatchObject({ relationshipType: 'connects', sourceEntityId: 'a', targetEntityId: 'b' });
        const fromB = await provider.getEntityRelationships(repoId, 'b');
        expect(fromB.items.map((rel) => rel.id)).toEqual(['r1']);
      });

      it('createRelationship throws EntityNotFoundError naming a missing source', async () => {
        await expect(
          provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'missing-source', 'b')),
        ).rejects.toMatchObject(typedError('EntityNotFoundError', 'ENTITY_NOT_FOUND', { id: 'missing-source' }));
        expect(await provider.getRelationship(repoId, 'r1')).toBeNull();
      });

      it('createRelationship throws EntityNotFoundError naming a missing target', async () => {
        await expect(
          provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'missing-target')),
        ).rejects.toMatchObject(typedError('EntityNotFoundError', 'ENTITY_NOT_FOUND', { id: 'missing-target' }));
        expect(await provider.getRelationship(repoId, 'r1')).toBeNull();
      });

      // A second repository with its own entities "a" and "b". The suite has
      // no teardown and live stores persist, so tests remove it on both sides.
      const otherRepoId = '40000000-0000-4000-a000-000000000002';
      const removeOther = async (): Promise<void> => {
        if ((await provider.getRepository(otherRepoId)) !== null) {
          await provider.deleteRepository(otherRepoId);
        }
      };
      const createOther = async (): Promise<void> => {
        await removeOther();
        await provider.createRepository({
          repositoryId: otherRepoId,
          label: 'Conformance Test (second repository)',
          governanceConfig: { mode: 'open' },
          createdAt: new Date().toISOString(),
          createdBy: 'conformance-test',
        });
        await provider.createEntity(otherRepoId, makeEntity('a'));
        await provider.createEntity(otherRepoId, makeEntity('b'));
      };

      it('the same relationship id can be used in two repositories', async () => {
        try {
          await createOther();

          await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
          await provider.createRelationship(otherRepoId, makeRelationship('r1', 'mentions', 'b', 'a'));

          expect(await provider.getRelationship(repoId, 'r1')).toMatchObject({
            relationshipType: 'connects',
            sourceEntityId: 'a',
            targetEntityId: 'b',
          });
          expect(await provider.getRelationship(otherRepoId, 'r1')).toMatchObject({
            relationshipType: 'mentions',
            sourceEntityId: 'b',
            targetEntityId: 'a',
          });
          const inFirst = await provider.getEntityRelationships(repoId, 'a');
          expect(inFirst.items.map((rel) => rel.relationshipType)).toEqual(['connects']);
          const inOther = await provider.getEntityRelationships(otherRepoId, 'a');
          expect(inOther.items.map((rel) => rel.relationshipType)).toEqual(['mentions']);
        } finally {
          await removeOther();
        }
      });

      it('deleting by a shared relationship id leaves the other repository untouched', async () => {
        // Each delete path runs against the first repository while the second
        // holds a relationship with the same id between same-id entities.
        const expectOtherIntact = async (): Promise<void> => {
          expect(await provider.getRelationship(otherRepoId, 'r1')).toMatchObject({
            relationshipType: 'mentions',
            sourceEntityId: 'b',
            targetEntityId: 'a',
          });
          const entities = await provider.getEntities(otherRepoId, ['a', 'b']);
          expect([...entities.keys()].sort()).toEqual(['a', 'b']);
        };
        try {
          await createOther();
          await provider.createRelationship(otherRepoId, makeRelationship('r1', 'mentions', 'b', 'a'));

          await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
          await provider.deleteRelationship(repoId, 'r1');
          expect(await provider.getRelationship(repoId, 'r1')).toBeNull();
          await expectOtherIntact();

          await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
          await provider.deleteRelationships(repoId, ['r1']);
          expect(await provider.getRelationship(repoId, 'r1')).toBeNull();
          await expectOtherIntact();

          await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
          await expect(provider.deleteAllContents(repoId)).resolves.toEqual({
            deletedEntities: 3,
            deletedRelationships: 1,
          });
          await expectOtherIntact();

          await provider.createEntity(repoId, makeEntity('a'));
          await provider.createEntity(repoId, makeEntity('b'));
          await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
          await expect(provider.deleteRepository(repoId)).resolves.toEqual({
            deletedEntities: 2,
            deletedRelationships: 1,
          });
          await expectOtherIntact();
        } finally {
          await removeOther();
        }
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('createRelationship throws RepositoryNotFoundError after the repository is deleted', async () => {
        // Entities "a" and "b" were created by beforeEach while the repository existed.
        await provider.deleteRepository(repoId);

        await expect(
          provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b')),
        ).rejects.toMatchObject(typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'));
        expect(await provider.getRepository(repoId)).toBeNull();
      });

      it('creates a relationship whose id the engine minted', async () => {
        await provider.createRelationship(repoId, makeRelationship('minted-r1', 'connects', 'a', 'b'), {
          idMinted: true,
        });

        expect(await provider.getRelationship(repoId, 'minted-r1')).toMatchObject({
          relationshipType: 'connects',
          sourceEntityId: 'a',
          targetEntityId: 'b',
        });
        const fromA = await provider.getEntityRelationships(repoId, 'a');
        expect(fromA.items.map((rel) => rel.id)).toEqual(['minted-r1']);
      });

      it('a minted-id create names a missing endpoint and writes nothing', async () => {
        await expect(
          provider.createRelationship(repoId, makeRelationship('minted-r1', 'connects', 'missing-source', 'b'), {
            idMinted: true,
          }),
        ).rejects.toMatchObject(typedError('EntityNotFoundError', 'ENTITY_NOT_FOUND', { id: 'missing-source' }));
        await expect(
          provider.createRelationship(repoId, makeRelationship('minted-r1', 'connects', 'a', 'missing-target'), {
            idMinted: true,
          }),
        ).rejects.toMatchObject(typedError('EntityNotFoundError', 'ENTITY_NOT_FOUND', { id: 'missing-target' }));
        expect(await provider.getRelationship(repoId, 'minted-r1')).toBeNull();
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('a minted-id create throws RepositoryNotFoundError after the repository is deleted', async () => {
        await provider.deleteRepository(repoId);

        await expect(
          provider.createRelationship(repoId, makeRelationship('minted-r1', 'connects', 'a', 'b'), { idMinted: true }),
        ).rejects.toMatchObject(typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'));
        expect(await provider.getRepository(repoId)).toBeNull();
      });

      it('deleteRepository reports the entities and relationships it removed', async () => {
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'mentions', 'b', 'c'));

        await expect(provider.deleteRepository(repoId)).resolves.toEqual({
          deletedEntities: 3,
          deletedRelationships: 2,
        });
        expect(await provider.getRepository(repoId)).toBeNull();
      });
    });

    // ─── Graph Traversal ────────────────────────────────────

    describe('graph traversal', () => {
      beforeEach(async () => {
        await provider.createEntity(repoId, makeEntity('a', 'node', 'A'));
        await provider.createEntity(repoId, makeEntity('b', 'node', 'B'));
        await provider.createEntity(repoId, makeEntity('c', 'node', 'C'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'links', 'a', 'b'));
        await provider.createRelationship(repoId, makeRelationship('r2', 'links', 'b', 'c'));
      });

      it('explores neighborhood at depth 1', async () => {
        const result = await provider.exploreNeighborhood(repoId, 'a', {
          depth: 1,
          direction: 'both',
          limitPerType: 10,
          offsetPerType: 0,
        });
        expect(result.centerId).toBe('a');
        expect(result.layers).toHaveLength(1);
      });

      it('dedupes connected entities per (layer, relationship-type) bucket', async () => {
        // Two same-type edges connect the same pair (b ↔ c), modelling a
        // logically-symmetric relationship as two directed half-edges. The
        // bucket should still report c exactly once at depth 2 from a.
        await provider.createRelationship(repoId, makeRelationship('r3', 'links', 'c', 'b'));
        const result = await provider.exploreNeighborhood(repoId, 'a', {
          depth: 2,
          direction: 'both',
          limitPerType: 10,
          offsetPerType: 0,
        });
        const linksLayer2 = result.layers[1]?.['links'];
        expect(linksLayer2).toBeDefined();
        expect(linksLayer2!.total).toBe(1);
        expect(linksLayer2!.entities.map((e) => e.id)).toEqual(['c']);
      });

      it('finds paths between connected entities', async () => {
        const result = await provider.findPaths(repoId, 'a', 'c', {
          maxDepth: 3,
          limit: 5,
          offset: 0,
        });
        expect(result.paths.length).toBeGreaterThanOrEqual(1);
        const firstPath = result.paths[0]!;
        expect(firstPath.entityIds[0]).toBe('a');
        expect(firstPath.entityIds[firstPath.entityIds.length - 1]).toBe('c');
      });

      it('returns empty paths when no connection', async () => {
        await provider.createEntity(repoId, makeEntity('isolated', 'node', 'Isolated'));
        const result = await provider.findPaths(repoId, 'a', 'isolated', {
          maxDepth: 3,
          limit: 5,
          offset: 0,
        });
        expect(result.paths).toHaveLength(0);
      });

      it('returns only simple paths (no repeated vertices)', async () => {
        // Set up a graph where a non-simple walk could otherwise emerge:
        //   a — b — c (the target)
        //         c — d via two distinct edges
        // A walk of length 4 along (a)-(b)-(c)-(d)-(c) reuses neither edge
        // but visits c twice. The contract requires findPaths to drop walks
        // that visit any vertex more than once.
        await provider.createEntity(repoId, makeEntity('d', 'node', 'D'));
        await provider.createRelationship(repoId, makeRelationship('r3', 'links', 'c', 'd'));
        await provider.createRelationship(repoId, makeRelationship('r4', 'links', 'c', 'd'));
        const result = await provider.findPaths(repoId, 'a', 'c', {
          maxDepth: 4,
          limit: 50,
          offset: 0,
        });
        for (const path of result.paths) {
          expect(new Set(path.entityIds).size).toBe(path.entityIds.length);
          expect(path.entityIds[path.entityIds.length - 1]).toBe('c');
        }
        // Exactly one simple path from a to c at depth ≤ 4: a-b-c.
        expect(result.totalPaths).toBe(1);
      });

      it('finds paths through non-bidirectional inbound edges', async () => {
        // Graph: a → b ← d (both edges are non-bidirectional)
        // Path from a to d should traverse: a →(outbound) b ←(inbound) d
        await provider.createEntity(repoId, makeEntity('d', 'node', 'D'));
        await provider.createRelationship(repoId, makeRelationship('r3', 'links', 'd', 'b'));
        const result = await provider.findPaths(repoId, 'a', 'd', {
          maxDepth: 3,
          limit: 5,
          offset: 0,
        });
        expect(result.paths.length).toBeGreaterThanOrEqual(1);
        const firstPath = result.paths[0]!;
        expect(firstPath.entityIds[0]).toBe('a');
        expect(firstPath.entityIds[firstPath.entityIds.length - 1]).toBe('d');
      });

      // A caller-supplied relationship type or filter key must never change
      // the structure of the query a provider runs. Providers that write
      // names into query text refuse unsafe ones with a typed validation
      // error; providers that bind or match names directly treat them as
      // ordinary (non-matching) names. Either is acceptable. A provider error
      // (the query failed to parse) or a match (the text altered the query)
      // is not. The filter uses `eq` with a value nothing stores, because
      // `isNull` matches a missing key on providers that filter in process.
      describe('caller-supplied names cannot alter the query', () => {
        const injectionStrings = [
          'KNOWS]-() WITH 1 AS x MATCH (m:_Entity) RETURN m //',
          'id IS NOT NULL OR true OR n0.id',
        ];
        const unmatchedValue = 'conformance-value-that-is-never-stored';

        async function expectRefusedOrNoMatch<T>(
          call: () => Promise<T>,
          hasMatch: (result: T) => boolean,
        ): Promise<void> {
          let result: T;
          try {
            result = await call();
          } catch (err) {
            expect(err).toMatchObject(
              typedError('TraversalValidationError', 'TRAVERSAL_VALIDATION_FAILED'),
            );
            return;
          }
          expect(hasMatch(result)).toBe(false);
        }

        const exploreHasMatch = (result: Awaited<ReturnType<StorageProvider['exploreNeighborhood']>>): boolean =>
          result.layers.some((layer) =>
            Object.values(layer).some((group) => group.total > 0 || group.entities.length > 0),
          );
        const pathsHaveMatch = (result: Awaited<ReturnType<StorageProvider['findPaths']>>): boolean =>
          result.paths.length > 0;

        for (const injection of injectionStrings) {
          it(`exploreNeighborhood: relationship type ${JSON.stringify(injection)}`, async () => {
            await expectRefusedOrNoMatch(
              () =>
                provider.exploreNeighborhood(repoId, 'a', {
                  depth: 1,
                  direction: 'both',
                  limitPerType: 10,
                  offsetPerType: 0,
                  relationshipTypes: [injection],
                }),
              exploreHasMatch,
            );
          });

          it(`exploreNeighborhood: relationship filter key ${JSON.stringify(injection)}`, async () => {
            await expectRefusedOrNoMatch(
              () =>
                provider.exploreNeighborhood(repoId, 'a', {
                  depth: 1,
                  direction: 'both',
                  limitPerType: 10,
                  offsetPerType: 0,
                  relationshipPropertyFilters: [{ key: injection, operator: 'eq', value: unmatchedValue }],
                }),
              exploreHasMatch,
            );
          });

          it(`findPaths: relationship type ${JSON.stringify(injection)}`, async () => {
            await expectRefusedOrNoMatch(
              () =>
                provider.findPaths(repoId, 'a', 'c', {
                  maxDepth: 3,
                  limit: 5,
                  offset: 0,
                  relationshipTypes: [injection],
                }),
              pathsHaveMatch,
            );
          });

          it(`findPaths: relationship filter key ${JSON.stringify(injection)}`, async () => {
            await expectRefusedOrNoMatch(
              () =>
                provider.findPaths(repoId, 'a', 'c', {
                  maxDepth: 3,
                  limit: 5,
                  offset: 0,
                  relationshipPropertyFilters: [{ key: injection, operator: 'eq', value: unmatchedValue }],
                }),
              pathsHaveMatch,
            );
          });
        }
      });
    });

    // ─── Timeline ───────────────────────────────────────────

    describe('timeline', () => {
      it('returns timeline events', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));
        const result = await provider.getTimeline(repoId, 'e1', {
          limit: 10,
          offset: 0,
        });
        expect(result.events.length).toBeGreaterThanOrEqual(1);
      });
    });

    // ─── Bulk Operations ────────────────────────────────────

    describe('bulk operations', () => {
      it('exports data', async () => {
        await provider.createEntity(repoId, makeEntity('e1'));

        const chunks = [];
        for await (const chunk of provider.exportAll(repoId)) {
          chunks.push(chunk);
        }
        expect(chunks.length).toBeGreaterThanOrEqual(1);
      });

      it('imports data', async () => {
        const result = await provider.importBulk(repoId, [
          { entities: [makeEntity('imported-1'), makeEntity('imported-2')] },
          { relationships: [makeRelationship('ir1', 'links', 'imported-1', 'imported-2')] },
        ]);
        expect(result.entitiesImported).toBe(2);
        expect(result.relationshipsImported).toBe(1);

        // Verify imported data is accessible
        const e = await provider.getEntity(repoId, 'imported-1');
        expect(e).not.toBeNull();
      });
    });

    // ─── Delete All Contents ───────────────────────────────

    describe('deleteAllContents', () => {
      it('deletes all entities and relationships but preserves the repository', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'alpha'));
        await provider.createEntity(repoId, makeEntity('e2', 'beta'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'links', 'e1', 'e2'));

        const result = await provider.deleteAllContents(repoId);
        expect(result.deletedEntities).toBe(2);
        expect(result.deletedRelationships).toBe(1);

        // Repository still exists
        const repo = await provider.getRepository(repoId);
        expect(repo).not.toBeNull();

        // Vocabulary still exists
        const vocab = await provider.getVocabulary(repoId);
        expect(vocab).toBeDefined();

        // Contents are gone
        const stats = await provider.getRepositoryStats(repoId);
        expect(stats.entityCount).toBe(0);
        expect(stats.relationshipCount).toBe(0);
      });

      it('returns zero counts on an empty repository', async () => {
        const result = await provider.deleteAllContents(repoId);
        expect(result.deletedEntities).toBe(0);
        expect(result.deletedRelationships).toBe(0);
      });

      it('throws RepositoryNotFoundError for an unknown repository', async () => {
        await expect(
          provider.deleteAllContents('ffffffff-ffff-4fff-afff-ffffffffffff'),
        ).rejects.toMatchObject(typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'));
      });

      it('throws RepositoryNotFoundError after the repository is deleted', async () => {
        await provider.deleteRepository(repoId);

        await expect(provider.deleteAllContents(repoId)).rejects.toMatchObject(
          typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND'),
        );
      });
    });

    // ─── Stats after data ───────────────────────────────────

    describe('stats reflect data', () => {
      it('counts entities and relationships', async () => {
        await provider.createEntity(repoId, makeEntity('e1', 'alpha'));
        await provider.createEntity(repoId, makeEntity('e2', 'alpha'));
        await provider.createEntity(repoId, makeEntity('e3', 'beta'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'links', 'e1', 'e2'));

        const stats = await provider.getRepositoryStats(repoId);
        expect(stats.entityCount).toBe(3);
        expect(stats.relationshipCount).toBe(1);
        expect(stats.entityTypeBreakdown['alpha']).toBe(2);
        expect(stats.entityTypeBreakdown['beta']).toBe(1);
        expect(stats.relationshipTypeBreakdown['links']).toBe(1);
      });
    });

    // ─── Deleted repository ─────────────────────────────────

    describe('after deleteRepository, each call throws RepositoryNotFoundError', () => {
      const repositoryNotFound = typedError('RepositoryNotFoundError', 'REPOSITORY_NOT_FOUND');

      /**
       * Give the repository a vocabulary, two entities and a relationship,
       * then delete it. The fresh read that supplies the expected version
       * fills a provider's vocabulary cache, and `saveVocabulary` drops that
       * entry again, so no cache holds the vocabulary when the calls under
       * test run.
       */
      async function populateAndDelete(): Promise<void> {
        const now = new Date().toISOString();
        const current = await provider.getVocabulary(repoId, { fresh: true });
        await provider.saveVocabulary(
          repoId,
          {
            ...current,
            version: '1.0.0',
            lastModified: now,
            entityTypes: [
              {
                type: 'test-type',
                description: 'Entity type of the deleted repository',
                version: '1.0.0',
                properties: [],
                createdAt: now,
                createdBy: 'conformance-test',
                modifiedAt: now,
                modifiedBy: 'conformance-test',
              },
            ],
          },
          current.version,
        );
        await provider.createEntity(repoId, makeEntity('e1'));
        await provider.createEntity(repoId, makeEntity('e2'));
        await provider.createRelationship(repoId, makeRelationship('r1', 'connects', 'e1', 'e2'));
        await provider.deleteRepository(repoId);
      }

      /**
       * Recreate the deleted repository and assert that a rejected import
       * left nothing behind: no entity and not the imported relationship.
       */
      async function expectNothingImported(relationshipId: string): Promise<void> {
        expect(await provider.getRepository(repoId)).toBeNull();
        await createConformanceRepository();
        const entities = await provider.findEntities(repoId, { limit: 10, offset: 0 });
        expect(entities.total).toBe(0);
        expect(await provider.getRelationship(repoId, relationshipId)).toBeNull();
      }

      it('getVocabulary', async () => {
        await populateAndDelete();
        await expect(provider.getVocabulary(repoId)).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getVocabulary with { fresh: true }', async () => {
        await populateAndDelete();
        await expect(provider.getVocabulary(repoId, { fresh: true })).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getRepositoryStats', async () => {
        await populateAndDelete();
        await expect(provider.getRepositoryStats(repoId)).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteEntities', async () => {
        await populateAndDelete();
        await expect(provider.deleteEntities(repoId, ['e1', 'missing'])).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteRelationships', async () => {
        await populateAndDelete();
        await expect(provider.deleteRelationships(repoId, ['r1', 'missing'])).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteEntities with no ids', async () => {
        await populateAndDelete();
        await expect(provider.deleteEntities(repoId, [])).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteRelationships with no ids', async () => {
        await populateAndDelete();
        await expect(provider.deleteRelationships(repoId, [])).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteEntity, for a former entity and for an id that never existed', async () => {
        await populateAndDelete();
        await expect(provider.deleteEntity(repoId, 'e1')).rejects.toMatchObject(repositoryNotFound);
        await expect(provider.deleteEntity(repoId, 'missing')).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteRelationship, for a former relationship and for an id that never existed', async () => {
        await populateAndDelete();
        await expect(provider.deleteRelationship(repoId, 'r1')).rejects.toMatchObject(repositoryNotFound);
        await expect(provider.deleteRelationship(repoId, 'missing')).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('updateEntity, ahead of EntityNotFoundError', async () => {
        await populateAndDelete();
        await expect(
          provider.updateEntity(repoId, 'e1', { label: 'Renamed', provenance: makeProvenance() }),
        ).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('updateEntity with properties', async () => {
        await populateAndDelete();
        await expect(
          provider.updateEntity(repoId, 'e1', { properties: { key: 'changed' }, provenance: makeProvenance() }),
        ).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getEntity, for a former entity and for an id that never existed', async () => {
        await populateAndDelete();
        await expect(provider.getEntity(repoId, 'e1')).rejects.toMatchObject(repositoryNotFound);
        await expect(provider.getEntity(repoId, 'missing')).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getEntityBySlug, for a former slug and for a slug that never existed', async () => {
        await populateAndDelete();
        await expect(provider.getEntityBySlug(repoId, makeEntity('e1').slug)).rejects.toMatchObject(
          repositoryNotFound,
        );
        await expect(provider.getEntityBySlug(repoId, 'test-type:missing')).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getEntities, for former and never-existing ids', async () => {
        await populateAndDelete();
        await expect(provider.getEntities(repoId, ['e1', 'e2', 'missing'])).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getEntities with no ids', async () => {
        await populateAndDelete();
        await expect(provider.getEntities(repoId, [])).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('findEntities with no filter', async () => {
        await populateAndDelete();
        await expect(provider.findEntities(repoId, { limit: 10, offset: 0 })).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('findEntities with an entity type filter', async () => {
        await populateAndDelete();
        await expect(
          provider.findEntities(repoId, { entityTypes: ['test-type'], limit: 10, offset: 0 }),
        ).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('findEntities with a search term', async () => {
        await populateAndDelete();
        await expect(
          provider.findEntities(repoId, { searchTerm: 'e1', limit: 10, offset: 0 }),
        ).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getRelationship, for a former relationship and for an id that never existed', async () => {
        await populateAndDelete();
        await expect(provider.getRelationship(repoId, 'r1')).rejects.toMatchObject(repositoryNotFound);
        await expect(provider.getRelationship(repoId, 'missing')).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getEntityRelationships, for a former entity and for an id that never existed', async () => {
        await populateAndDelete();
        await expect(
          provider.getEntityRelationships(repoId, 'e1', { direction: 'both', limit: 10, offset: 0 }),
        ).rejects.toMatchObject(repositoryNotFound);
        await expect(
          provider.getEntityRelationships(repoId, 'missing', { direction: 'both', limit: 10, offset: 0 }),
        ).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteEntitiesByType, for a former type and for a type that never existed', async () => {
        await populateAndDelete();
        await expect(provider.deleteEntitiesByType(repoId, 'test-type')).rejects.toMatchObject(
          repositoryNotFound,
        );
        await expect(provider.deleteEntitiesByType(repoId, 'missing-type')).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('deleteRelationshipsByType, for a former type and for a type that never existed', async () => {
        await populateAndDelete();
        await expect(provider.deleteRelationshipsByType(repoId, 'connects')).rejects.toMatchObject(
          repositoryNotFound,
        );
        await expect(provider.deleteRelationshipsByType(repoId, 'missing_type')).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getVocabularyChangeLog', async () => {
        await populateAndDelete();
        await expect(provider.getVocabularyChangeLog(repoId)).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getTimeline, for a former entity and for an id that never existed', async () => {
        await populateAndDelete();
        await expect(provider.getTimeline(repoId, 'e1', { limit: 10, offset: 0 })).rejects.toMatchObject(
          repositoryNotFound,
        );
        await expect(provider.getTimeline(repoId, 'missing', { limit: 10, offset: 0 })).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('exportAll, on the first iteration', async () => {
        await populateAndDelete();
        const drain = async (): Promise<number> => {
          let chunks = 0;
          for await (const _chunk of provider.exportAll(repoId)) {
            chunks++;
          }
          return chunks;
        };
        await expect(drain()).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('importBulk in upsert mode, writing nothing', async () => {
        await populateAndDelete();
        await expect(
          provider.importBulk(repoId, [
            { entities: [makeEntity('e1'), makeEntity('e3')] },
            { relationships: [makeRelationship('r2', 'connects', 'e1', 'e3')] },
          ]),
        ).rejects.toMatchObject(repositoryNotFound);
        await expectNothingImported('r2');
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('importBulk in insert mode (skipExistenceCheck), writing nothing', async () => {
        await populateAndDelete();
        await expect(
          provider.importBulk(
            repoId,
            [
              { entities: [makeEntity('e3'), makeEntity('e4')] },
              { relationships: [makeRelationship('r2', 'connects', 'e3', 'e4')] },
            ],
            { skipExistenceCheck: true },
          ),
        ).rejects.toMatchObject(repositoryNotFound);
        await expectNothingImported('r2');
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('importBulk with no chunks', async () => {
        await populateAndDelete();
        await expect(provider.importBulk(repoId, [])).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('exploreNeighborhood, for a former entity and for an id that never existed', async () => {
        await populateAndDelete();
        const options = { depth: 1, direction: 'both' as const, limitPerType: 10, offsetPerType: 0 };
        await expect(provider.exploreNeighborhood(repoId, 'e1', options)).rejects.toMatchObject(
          repositoryNotFound,
        );
        await expect(provider.exploreNeighborhood(repoId, 'missing', options)).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('findPaths, between former entities and between ids that never existed', async () => {
        await populateAndDelete();
        const options = { maxDepth: 2, limit: 10, offset: 0 };
        await expect(provider.findPaths(repoId, 'e1', 'e2', options)).rejects.toMatchObject(repositoryNotFound);
        await expect(provider.findPaths(repoId, 'missing', 'missing-too', options)).rejects.toMatchObject(
          repositoryNotFound,
        );
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('traverse, for a provider that implements GraphTraversalProvider', async (ctx) => {
        // Providers without native traversal are served by the engine's
        // fallback over the StorageProvider calls covered above.
        const traversal = isGraphTraversalProvider(provider) ? provider : null;
        if (traversal === null) return ctx.skip('provider does not implement GraphTraversalProvider');
        await populateAndDelete();
        await expect(
          traversal.traverse(repoId, {
            start: { entityId: 'e1' },
            steps: [{ direction: 'out', relationshipTypes: ['connects'] }],
            returnMode: 'terminal',
            limit: 10,
          }),
        ).rejects.toMatchObject(repositoryNotFound);
        await expect(
          traversal.traverse(repoId, {
            start: { entityType: 'test-type' },
            returnMode: 'terminal',
            limit: 10,
          }),
        ).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('a second deleteRepository', async () => {
        await populateAndDelete();
        await expect(provider.deleteRepository(repoId)).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);

      it('getVocabulary is not served from a cache filled before the delete', async () => {
        // Fill any provider cache with a read, then delete through the same
        // provider instance: the delete must drop the cached copy.
        await provider.getVocabulary(repoId);
        await provider.getRepositoryStats(repoId);
        await provider.deleteRepository(repoId);

        await expect(provider.getVocabulary(repoId)).rejects.toMatchObject(repositoryNotFound);
        await expect(provider.getRepositoryStats(repoId)).rejects.toMatchObject(repositoryNotFound);
      }, MULTI_STEP_TEST_TIMEOUT_MS);
    });
  });
}
