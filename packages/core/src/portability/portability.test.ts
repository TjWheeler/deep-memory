// Portability — tests for export, import, and vocabulary migration

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DeepMemory } from '../core/DeepMemory.js';
import {
  DuplicateRelationshipError,
  InvalidInputError,
  OperationAbortedError,
  RepositoryNotFoundError,
} from '../core/errors.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { MemoryRepository } from '../core/MemoryRepository.js';
import type {
  BulkImportOptions,
  ExportArchive,
  ExportStreamItem,
  ImportChunk,
} from '../types/portability.js';
import type { BulkImportItemError, BulkImportResult } from '../types/results.js';

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

describe('Portability', () => {
  let memory: DeepMemory;
  let repo: MemoryRepository;
  let storage: InMemoryStorageProvider;

  beforeEach(async () => {
    storage = new InMemoryStorageProvider();
    memory = new DeepMemory({
      storage,
      provenance: { actorId: 'test-agent', actorType: 'agent' },
    });

    repo = await memory.createRepository({
      repositoryId: '10000000-0000-4000-a000-000000000001',
      label: 'Source Repository',
      vocabulary,
      governance: { mode: 'open' },
    });

    // Populate with data
    const [alice] = await repo.createEntities([{ entityType: 'person', label: 'Alice' }]);
    const [bob] = await repo.createEntities([{ entityType: 'person', label: 'Bob' }]);
    const [acme] = await repo.createEntities([{ entityType: 'company', label: 'Acme Corp' }]);
    await repo.createRelationships([{
      relationshipType: 'works_at',
      sourceEntityId: alice.id,
      targetEntityId: acme.id,
    }]);
    await repo.createRelationships([{
      relationshipType: 'works_at',
      sourceEntityId: bob.id,
      targetEntityId: acme.id,
    }]);
  });

  // ─── Export ────────────────────────────────────────────────

  describe('exportRepository', () => {
    it('exports a complete archive', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      expect(archive.manifest.formatVersion).toBe('1.0.0');
      expect(archive.manifest.repository.repositoryId).toBe('10000000-0000-4000-a000-000000000001');
      expect(archive.manifest.repository.label).toBe('Source Repository');
      expect(archive.manifest.statistics.entityCount).toBe(3);
      expect(archive.manifest.statistics.relationshipCount).toBe(2);
      expect(archive.vocabulary.entityTypes).toHaveLength(2);
      expect(archive.entities).toHaveLength(3);
      expect(archive.relationships).toHaveLength(2);
    });

    it('includes provenance in manifest', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      expect(archive.manifest.exportedBy.actorId).toBe('test-agent');
    });

    it('throws for non-existent repository', async () => {
      await expect(memory.exportRepository('nope')).rejects.toThrow('not found');
    });
  });

  // ─── Round-trip ────────────────────────────────────────────

  describe('round-trip export/import', () => {
    it('creates a new repository from an export', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      const result = await memory.importRepository(archive, {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-000000000002',
          config: { repositoryId: '10000000-0000-4000-a000-000000000002', label: 'Imported' },
        },
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(3);
      expect(result.statistics.relationshipsImported).toBe(2);

      // Verify the imported repo works
      const imported = await memory.openRepository('10000000-0000-4000-a000-000000000002');
      const alice = await imported.getBySlug('person:alice');
      expect(alice).not.toBeNull();

      const stats = await imported.getStats();
      expect(stats.entityCount).toBe(3);
      expect(stats.relationshipCount).toBe(2);
    });

    it('preserves entity data through round-trip', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      await memory.importRepository(archive, {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-000000000003',
          config: { repositoryId: '10000000-0000-4000-a000-000000000003', label: 'Round-trip' },
        },
      });

      const imported = await memory.openRepository('10000000-0000-4000-a000-000000000003');
      const alice = await imported.getBySlug('person:alice', 'full');
      expect(alice).not.toBeNull();
      expect(alice!.label).toBe('Alice');
      expect(alice!.provenance.createdBy).toBe('test-agent');
    });

    it('preserves repository legal, owner, and metadata fields through create round-trip', async () => {
      const sourceId = '10000000-0000-4000-a000-0000000000e0';
      await memory.createRepository({
        repositoryId: sourceId,
        label: 'Source With Metadata',
        legal: 'Apache-2.0 — internal use only',
        owner: 'platform-team',
        metadata: {
          embeddingModelId: 'Qwen/Qwen3-Embedding-8B',
          embeddingDimensions: 4096,
          customField: 'custom-value',
        },
        vocabulary,
        governance: { mode: 'open' },
      });

      const archive = await memory.exportRepository(sourceId);

      // The manifest itself should carry the fields
      expect(archive.manifest.repository.legal).toBe('Apache-2.0 — internal use only');
      expect(archive.manifest.repository.owner).toBe('platform-team');
      expect(archive.manifest.repository.metadata?.embeddingModelId).toBe('Qwen/Qwen3-Embedding-8B');
      expect(archive.manifest.repository.metadata?.embeddingDimensions).toBe(4096);
      expect(archive.manifest.repository.metadata?.customField).toBe('custom-value');

      const targetId = '10000000-0000-4000-a000-0000000000e1';
      await memory.importRepository(archive, {
        target: {
          mode: 'create',
          repositoryId: targetId,
          config: {
            repositoryId: targetId,
            label: archive.manifest.repository.label,
            legal: archive.manifest.repository.legal,
            owner: archive.manifest.repository.owner,
            metadata: archive.manifest.repository.metadata,
          },
        },
      });

      const imported = await memory.getRepository(targetId);
      expect(imported.legal).toBe('Apache-2.0 — internal use only');
      expect(imported.owner).toBe('platform-team');
      expect(imported.metadata?.embeddingModelId).toBe('Qwen/Qwen3-Embedding-8B');
      expect(imported.metadata?.embeddingDimensions).toBe(4096);
      expect(imported.metadata?.customField).toBe('custom-value');
    });

    it('rejects non-UUID target repositoryId on import (create mode)', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      await expect(
        memory.importRepository(archive, {
          target: {
            mode: 'create',
            repositoryId: 'person-test',
            config: { label: 'Bad ID' },
          },
        }),
      ).rejects.toThrow('not a valid UUID');
    });

    it('rejects non-UUID target repositoryId on import (merge mode)', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      await expect(
        memory.importRepository(archive, {
          target: { mode: 'merge', repositoryId: 'person-test' },
        }),
      ).rejects.toThrow('not a valid UUID');
    });
  });

  describe('create-mode import into an existing repository', () => {
    const targetId = '10000000-0000-4000-a000-000000000009';

    async function emptyArchive(version: string): Promise<ExportArchive> {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      return {
        ...archive,
        vocabulary: { ...archive.vocabulary, version },
        entities: [],
        relationships: [],
      };
    }

    async function storedVersion(): Promise<string> {
      const target = await memory.openRepository(targetId);
      return (await target.getVocabulary()).vocabulary.version;
    }

    beforeEach(async () => {
      await memory.createRepository({ repositoryId: targetId, label: 'Existing', vocabulary });
    });

    it('advances the version past the stored one when the archive version is not newer', async () => {
      // Stored and archive versions are both 1.0.0. Re-writing 1.0.0 would let a
      // concurrent writer that read the pre-import vocabulary pass its compare-and-set.
      expect(await storedVersion()).toBe('1.0.0');

      const result = await memory.importRepository(await emptyArchive('1.0.0'), {
        target: { mode: 'create', repositoryId: targetId, config: { label: 'Existing' } },
      });

      expect(result.success).toBe(true);
      expect(await storedVersion()).toBe('2.0.0');
    });

    it('keeps the archive version when it is newer than a major bump of the stored one', async () => {
      await memory.importRepository(await emptyArchive('7.3.1'), {
        target: { mode: 'create', repositoryId: targetId, config: { label: 'Existing' } },
      });

      expect(await storedVersion()).toBe('7.3.1');
    });

    it('rejects an archive whose vocabulary version is malformed', async () => {
      await expect(
        memory.importRepository(await emptyArchive('1.x.0'), {
          target: { mode: 'create', repositoryId: targetId, config: { label: 'Existing' } },
        }),
      ).rejects.toThrow(InvalidInputError);
      expect(await storedVersion()).toBe('1.0.0');
    });

    it('upserts the rows of an archive imported again into the repository it created', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      const reimportId = '10000000-0000-4000-a000-00000000000c';
      const target = { mode: 'create' as const, repositoryId: reimportId, config: { label: 'Re-imported' } };

      const first = await memory.importRepository(archive, { target });
      const importBulk = vi.spyOn(storage, 'importBulk');
      const second = await memory.importRepository(archive, { target });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.statistics.entitiesImported).toBe(3);
      expect(second.statistics.relationshipsImported).toBe(2);
      expect(second.warnings.filter((w) => w.code === 'import_error')).toEqual([]);
      for (const [, , options] of importBulk.mock.calls) {
        expect(options?.skipExistenceCheck).toBe(false);
      }
      const stats = await (await memory.openRepository(reimportId)).getStats();
      expect(stats.entityCount).toBe(3);
      expect(stats.relationshipCount).toBe(2);
    });
  });

  // ─── Merge Import ──────────────────────────────────────────

  describe('merge import', () => {
    let archive: ExportArchive;

    beforeEach(async () => {
      archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      // Create a target repository with same vocabulary
      await memory.createRepository({
        repositoryId: '10000000-0000-4000-a000-000000000004',
        label: 'Target Repository',
        vocabulary,
        governance: { mode: 'open' },
      });
    });

    it('skips existing entities by default', async () => {
      // Pre-import Alice from archive into target (same GUID = collision)
      const aliceFromArchive = archive.entities.find((e) => e.slug === 'person:alice')!;
      const result0 = await memory.importRepository(
        { ...archive, entities: [aliceFromArchive], relationships: [] },
        { target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' }, vocabularyConflict: 'extend' },
      );
      expect(result0.success).toBe(true);

      // Now merge full archive — Alice should be skipped (same GUID exists)
      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' },
        vocabularyConflict: 'extend',
        entityConflict: 'skip',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(2); // Bob + Acme (Alice skipped)
      expect(result.statistics.entitiesSkipped).toBe(1);
    });

    it('overwrites existing entities when configured', async () => {
      // Pre-import Alice from archive into target (same GUID = collision)
      const aliceFromArchive = archive.entities.find((e) => e.slug === 'person:alice')!;
      await memory.importRepository(
        { ...archive, entities: [aliceFromArchive], relationships: [] },
        { target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' }, vocabularyConflict: 'extend' },
      );

      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' },
        vocabularyConflict: 'extend',
        entityConflict: 'overwrite',
      });

      expect(result.success).toBe(true);
      // All 3 entities imported (Alice overwritten, Bob + Acme created)
      expect(result.statistics.entitiesImported).toBe(3);
      expect(result.statistics.entitiesSkipped).toBe(0);

      // Verify the overwrite warning was generated
      const overwriteWarning = result.warnings.find((w) => w.code === 'entity_overwritten');
      expect(overwriteWarning).toBeDefined();
      expect(overwriteWarning!.id).toBeDefined();
    });

    it('renames conflicting entities when configured', async () => {
      // Pre-import Alice from archive into target (same GUID = collision)
      const aliceFromArchive = archive.entities.find((e) => e.slug === 'person:alice')!;
      await memory.importRepository(
        { ...archive, entities: [aliceFromArchive], relationships: [] },
        { target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' }, vocabularyConflict: 'extend' },
      );

      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' },
        vocabularyConflict: 'extend',
        entityConflict: 'rename',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(3); // All imported (Alice renamed)

      const target2 = await memory.openRepository('10000000-0000-4000-a000-000000000004');
      const renamed = await target2.getBySlug('person:alice-imported');
      expect(renamed).not.toBeNull();
    });

    it('picks a free slug when the same entity is renamed on a second import', async () => {
      const targetId = '10000000-0000-4000-a000-000000000004';
      const aliceOnly = {
        ...archive,
        entities: [archive.entities.find((e) => e.slug === 'person:alice')!],
        relationships: [],
      };
      await memory.importRepository(aliceOnly, { target: { mode: 'merge', repositoryId: targetId }, vocabularyConflict: 'extend' });

      const first = await memory.importRepository(aliceOnly, {
        target: { mode: 'merge', repositoryId: targetId },
        vocabularyConflict: 'extend',
        entityConflict: 'rename',
      });
      const second = await memory.importRepository(aliceOnly, {
        target: { mode: 'merge', repositoryId: targetId },
        vocabularyConflict: 'extend',
        entityConflict: 'rename',
      });

      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      const target = await memory.openRepository(targetId);
      const firstRename = await target.getBySlug('person:alice-imported');
      const secondRename = await target.getBySlug('person:alice-imported-2');
      expect(firstRename).not.toBeNull();
      expect(secondRename).not.toBeNull();
      expect(secondRename!.id).not.toBe(firstRename!.id);
      expect(second.warnings.find((w) => w.code === 'entity_renamed')?.message).toContain('person:alice-imported-2');
    });

    it('treats DuplicateRelationshipError from createRelationship as skip+warning', async () => {
      // Simulate a storage layer (e.g. SQL Server) that enforces a composite
      // unique constraint beyond relationship ID — so getRelationship() returns
      // null but createRelationship() still throws DuplicateRelationshipError.
      const storage = new InMemoryStorageProvider();
      const realCreate = storage.createRelationship.bind(storage);
      let tripped = false;
      storage.createRelationship = async (repoId, rel) => {
        if (!tripped) {
          tripped = true;
          throw new DuplicateRelationshipError(rel.id);
        }
        return realCreate(repoId, rel);
      };

      const isolated = new DeepMemory({
        storage,
        provenance: { actorId: 'test-agent', actorType: 'agent' },
      });
      await isolated.createRepository({
        repositoryId: '10000000-0000-4000-a000-00000000c001',
        label: 'Composite Constraint Target',
        vocabulary,
        governance: { mode: 'open' },
      });

      const result = await isolated.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000c001' },
        vocabularyConflict: 'extend',
      });

      expect(result.success).toBe(true);
      expect(tripped).toBe(true);
      expect(result.statistics.relationshipsSkipped).toBeGreaterThanOrEqual(1);
      const skipWarning = result.warnings.find(
        (w) => w.code === 'relationship_skipped',
      );
      expect(skipWarning).toBeDefined();
    });

    it('skips and reports an entity whose property name the store refuses, importing the rest', async () => {
      const alice = archive.entities.find((e) => e.slug === 'person:alice')!;
      const failures: Array<{ itemId: string; code?: string }> = [];
      memory.on('import:item-failed', (e) => {
        failures.push({ itemId: e.payload.itemId, code: e.payload.code });
      });
      const legacyArchive = {
        ...archive,
        entities: archive.entities.map((e) =>
          e.id === alice.id ? { ...e, properties: { 'start-date': '2020-01-01' } } : e,
        ),
      };

      const result = await memory.importRepository(legacyArchive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' },
        vocabularyConflict: 'extend',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(2);
      expect(result.statistics.entitiesSkipped).toBe(1);
      expect(result.warnings).toContainEqual(
        expect.objectContaining({ code: 'import_error', id: alice.id, errorCode: 'INVALID_INPUT' }),
      );
      // Alice's relationship has no source to attach to.
      expect(result.statistics.relationshipsImported).toBe(1);
      expect(result.statistics.relationshipsSkipped).toBe(1);
      expect(failures).toContainEqual({ itemId: alice.id, code: 'INVALID_INPUT' });
    });

    it('skips orphaned relationships', async () => {
      // Import only entities, not all — create partial state
      const partialArchive = {
        ...archive,
        entities: archive.entities.filter((e) => e.slug === 'person:alice'),
        // Relationships reference person:bob and company:acme-corp which won't exist
      };

      const result = await memory.importRepository(partialArchive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000004' },
        vocabularyConflict: 'extend',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.relationshipsSkipped).toBeGreaterThan(0);
    });

    it('rejects with RepositoryNotFoundError and writes nothing when the target repo is missing', async () => {
      const storage = new InMemoryStorageProvider();
      const isolated = new DeepMemory({
        storage,
        provenance: { actorId: 'test-agent', actorType: 'agent' },
      });
      const missingId = '10000000-0000-4000-a000-00000000ffff';
      const writes = [
        vi.spyOn(storage, 'createRepository'),
        vi.spyOn(storage, 'saveVocabulary'),
        vi.spyOn(storage, 'importBulk'),
      ];

      const rejection = isolated.importRepository(archive, {
        target: { mode: 'merge', repositoryId: missingId },
        vocabularyConflict: 'extend',
      });

      await expect(rejection).rejects.toBeInstanceOf(RepositoryNotFoundError);
      await expect(rejection).rejects.toMatchObject({ repositoryId: missingId });
      for (const write of writes) {
        expect(write).not.toHaveBeenCalled();
      }
      expect(await storage.getRepository(missingId)).toBeNull();
    });

    it('streaming merge into a missing target repo rejects with RepositoryNotFoundError', async () => {
      async function* chunks(): AsyncGenerator<ImportChunk> {
        yield { entities: archive.entities };
        yield { relationships: archive.relationships };
      }

      await expect(memory.importRepositoryStream(
        { manifest: archive.manifest, vocabulary: archive.vocabulary },
        chunks(),
        { target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000fffe' } },
      )).rejects.toBeInstanceOf(RepositoryNotFoundError);
    });
  });

  // ─── Vocabulary Migration ──────────────────────────────────

  describe('vocabulary migration', () => {
    it('rejects import when vocabularies differ and mode is reject', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      // Create target with different vocabulary
      await memory.createRepository({
        repositoryId: '10000000-0000-4000-a000-000000000005',
        label: 'Different Vocab',
        vocabulary: {
          entityTypes: [{ type: 'document', description: 'A document' }],
        },
        governance: { mode: 'open' },
      });

      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000005' },
        vocabularyConflict: 'reject',
      });

      expect(result.success).toBe(false);
      expect(result.warnings.some((w) => w.code === 'vocabulary_migration_failed')).toBe(true);
    });

    it('extends vocabulary when mode is extend', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      // Create target with different vocabulary
      await memory.createRepository({
        repositoryId: '10000000-0000-4000-a000-000000000006',
        label: 'Extend Vocab',
        vocabulary: {
          entityTypes: [{ type: 'document', description: 'A document' }],
        },
        governance: { mode: 'open' },
      });

      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000006' },
        vocabularyConflict: 'extend',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.vocabularyExtensions).toBeGreaterThan(0);

      // Verify vocabulary was extended
      const target = await memory.openRepository('10000000-0000-4000-a000-000000000006');
      const vocab = await target.getVocabulary();
      const typeNames = vocab.vocabulary.entityTypes.map((t) => t.type);
      expect(typeNames).toContain('document'); // original
      expect(typeNames).toContain('person'); // from import
      expect(typeNames).toContain('company'); // from import
    });

    it('reports vocabulary differences in prompt mode', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      await memory.createRepository({
        repositoryId: '10000000-0000-4000-a000-000000000007',
        label: 'Prompt Vocab',
        vocabulary: {
          entityTypes: [{ type: 'document', description: 'A document' }],
        },
        governance: { mode: 'open' },
      });

      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-000000000007' },
        vocabularyConflict: 'prompt',
      });

      expect(result.success).toBe(false);
      expect(result.warnings.some((w) => w.code === 'vocabulary_mismatch')).toBe(true);
    });
  });

  // ─── Events ────────────────────────────────────────────────

  describe('portability events', () => {
    it('emits export:completed event', async () => {
      const events: string[] = [];
      memory.on('export:completed', () => { events.push('export:completed'); });

      await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      expect(events).toEqual(['export:completed']);
    });

    it('emits import:completed event on success', async () => {
      const events: string[] = [];
      memory.on('import:completed', () => { events.push('import:completed'); });

      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      await memory.importRepository(archive, {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-000000000008',
          config: { repositoryId: '10000000-0000-4000-a000-000000000008', label: 'Event Test' },
        },
      });

      expect(events).toEqual(['import:completed']);
    });

    it('reports bulk row errors as warnings and import:item-failed events with type, id and code', async () => {
      const rowErrors: BulkImportItemError[] = [
        { item: 'relationship:r1', error: 'source entity missing', code: 'ENTITY_NOT_FOUND' },
        { item: 'e1', error: 'refused value', code: 'PROVIDER_ERROR' },
      ];
      // Reports the row errors on the first chunk only; the importer calls
      // importBulk once per chunk.
      class RowErrorStorage extends InMemoryStorageProvider {
        private reported = false;

        public override async importBulk(
          repositoryId: string,
          data: ImportChunk[],
          options?: BulkImportOptions,
        ): Promise<BulkImportResult> {
          const result = await super.importBulk(repositoryId, data, options);
          if (this.reported) return result;
          this.reported = true;
          return { ...result, errors: [...result.errors, ...rowErrors] };
        }
      }
      const source = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      const failingMemory = new DeepMemory({
        storage: new RowErrorStorage(),
        provenance: { actorId: 'test-agent', actorType: 'agent' },
      });
      const failed: Array<{ itemId: string; itemType: string; code?: string }> = [];
      failingMemory.on('import:item-failed', (e) => {
        failed.push({ itemId: e.payload.itemId, itemType: e.payload.itemType, code: e.payload.code });
      });

      const result = await failingMemory.importRepository(
        { ...source, relationships: [] },
        {
          target: {
            mode: 'create',
            repositoryId: '10000000-0000-4000-a000-0000000000e1',
            config: { repositoryId: '10000000-0000-4000-a000-0000000000e1', label: 'Row errors' },
          },
        },
      );

      const importErrors = result.warnings.filter((w) => w.code === 'import_error');
      expect(importErrors.map((w) => ({ id: w.id, errorCode: w.errorCode }))).toEqual([
        { id: 'r1', errorCode: 'ENTITY_NOT_FOUND' },
        { id: 'e1', errorCode: 'PROVIDER_ERROR' },
      ]);
      expect(failed).toEqual([
        { itemId: 'r1', itemType: 'relationship', code: 'ENTITY_NOT_FOUND' },
        // No prefix: the item is looked up in the chunk and defaults to an entity.
        { itemId: 'e1', itemType: 'entity', code: 'PROVIDER_ERROR' },
      ]);
    });

    it('InMemory names a failed row with its entity:/relationship: prefix', async () => {
      const storage = new InMemoryStorageProvider();
      const repositoryId = '10000000-0000-4000-a000-0000000000e2';
      await storage.createRepository({
        repositoryId,
        label: 'Prefix',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'test-agent',
      });
      const source = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      const orphan = { ...source.relationships[0]!, id: 'orphan-rel', sourceEntityId: 'no-such-entity' };

      const result = await storage.importBulk(repositoryId, [
        { entities: source.entities },
        { relationships: [orphan] },
      ]);

      expect(result.entitiesImported).toBe(source.entities.length);
      expect(result.relationshipsImported).toBe(0);
      expect(result.errors).toEqual([
        expect.objectContaining({ item: 'relationship:orphan-rel', code: 'ENTITY_NOT_FOUND' }),
      ]);
    });

    it('emits import:failed event on failure', async () => {
      const events: string[] = [];
      memory.on('import:failed', () => { events.push('import:failed'); });

      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      await expect(memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000ffff' },
      })).rejects.toBeInstanceOf(RepositoryNotFoundError);

      expect(events).toEqual(['import:failed']);
    });

    it('aborts when the supplied signal is triggered and emits import:failed', async () => {
      const failedEvents: unknown[] = [];
      memory.on('import:failed', (e) => { failedEvents.push(e); });

      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      const header = { manifest: archive.manifest, vocabulary: archive.vocabulary };

      async function* chunks(): AsyncGenerator<ImportChunk> {
        yield { entities: archive.entities };
        yield { relationships: archive.relationships };
      }

      const controller = new AbortController();
      controller.abort();

      await expect(memory.importRepositoryStream(header, chunks(), {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-00000000abcd',
          config: { repositoryId: '10000000-0000-4000-a000-00000000abcd', label: 'Aborted' },
        },
        signal: controller.signal,
      })).rejects.toBeInstanceOf(OperationAbortedError);

      expect(failedEvents).toHaveLength(1);
    });
  });

  // ─── Streaming Export ─────────────────────────────────────

  describe('exportRepositoryStream', () => {
    it('yields items in correct order: manifest → vocabulary → data', async () => {
      const items: ExportStreamItem[] = [];
      for await (const item of memory.exportRepositoryStream('10000000-0000-4000-a000-000000000001')) {
        items.push(item);
      }

      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(items[0]!.type).toBe('manifest');
      expect(items[1]!.type).toBe('vocabulary');

      // Remaining items are entities and/or relationships
      const dataTypes = items.slice(2).map((i) => i.type);
      for (const t of dataTypes) {
        expect(['entities', 'relationships']).toContain(t);
      }
    });

    it('stream contains same data as non-streaming export', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      const items: ExportStreamItem[] = [];
      for await (const item of memory.exportRepositoryStream('10000000-0000-4000-a000-000000000001')) {
        items.push(item);
      }

      const manifestItem = items.find((i) => i.type === 'manifest')!;
      expect(manifestItem.type).toBe('manifest');
      if (manifestItem.type === 'manifest') {
        expect(manifestItem.data.repository.repositoryId).toBe(archive.manifest.repository.repositoryId);
        expect(manifestItem.data.statistics.entityCount).toBe(archive.manifest.statistics.entityCount);
        expect(manifestItem.data.statistics.relationshipCount).toBe(archive.manifest.statistics.relationshipCount);
      }

      // Collect streamed entities
      const streamedEntities = items
        .filter((i): i is Extract<ExportStreamItem, { type: 'entities' }> => i.type === 'entities')
        .flatMap((i) => i.data);
      expect(streamedEntities).toHaveLength(archive.entities.length);

      // Collect streamed relationships
      const streamedRels = items
        .filter((i): i is Extract<ExportStreamItem, { type: 'relationships' }> => i.type === 'relationships')
        .flatMap((i) => i.data);
      expect(streamedRels).toHaveLength(archive.relationships.length);
    });

    it('emits export:started and export:completed events', async () => {
      const events: string[] = [];
      memory.on('export:started', () => { events.push('export:started'); });
      memory.on('export:completed', () => { events.push('export:completed'); });

      // Must fully consume the generator for events to fire
      for await (const _item of memory.exportRepositoryStream('10000000-0000-4000-a000-000000000001')) {
        // consume
      }

      expect(events).toEqual(['export:started', 'export:completed']);
    });

    it('throws for non-existent repository', async () => {
      const gen = memory.exportRepositoryStream('nope');
      await expect(gen.next()).rejects.toThrow('not found');
    });
  });

  // ─── Streaming Import ─────────────────────────────────────

  describe('importRepositoryStream', () => {
    it('creates a new repository from streamed chunks', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      const header = { manifest: archive.manifest, vocabulary: archive.vocabulary };

      // Simulate chunked delivery — entities first, then relationships
      async function* chunks(): AsyncGenerator<ImportChunk> {
        yield { entities: archive.entities.slice(0, 2) };
        yield { entities: archive.entities.slice(2) };
        yield { relationships: archive.relationships };
      }

      const result = await memory.importRepositoryStream(header, chunks(), {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-000000000009',
          config: { repositoryId: '10000000-0000-4000-a000-000000000009', label: 'Stream Imported' },
        },
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(3);
      expect(result.statistics.relationshipsImported).toBe(2);

      // Verify the imported repo works
      const imported = await memory.openRepository('10000000-0000-4000-a000-000000000009');
      const stats = await imported.getStats();
      expect(stats.entityCount).toBe(3);
      expect(stats.relationshipCount).toBe(2);
    });

    it('merge mode with skip conflict resolution', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      // Create target and pre-import Alice (same GUID = collision)
      await memory.createRepository({
        repositoryId: '10000000-0000-4000-a000-00000000000a',
        label: 'Stream Merge Target',
        vocabulary,
        governance: { mode: 'open' },
      });
      const aliceFromArchive = archive.entities.find((e) => e.slug === 'person:alice')!;
      await memory.importRepository(
        { ...archive, entities: [aliceFromArchive], relationships: [] },
        { target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000000a' }, vocabularyConflict: 'extend' },
      );

      const header = { manifest: archive.manifest, vocabulary: archive.vocabulary };

      async function* chunks(): AsyncGenerator<ImportChunk> {
        yield { entities: archive.entities };
        yield { relationships: archive.relationships };
      }

      const result = await memory.importRepositoryStream(header, chunks(), {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000000a' },
        vocabularyConflict: 'extend',
        entityConflict: 'skip',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(2); // Bob + Acme
      expect(result.statistics.entitiesSkipped).toBe(1); // Alice
    });

    it('merge mode with overwrite conflict resolution', async () => {
      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');

      await memory.createRepository({
        repositoryId: '10000000-0000-4000-a000-00000000000b',
        label: 'Stream Overwrite Target',
        vocabulary,
        governance: { mode: 'open' },
      });
      // Pre-import Alice (same GUID = collision)
      const aliceFromArchive = archive.entities.find((e) => e.slug === 'person:alice')!;
      await memory.importRepository(
        { ...archive, entities: [aliceFromArchive], relationships: [] },
        { target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000000b' }, vocabularyConflict: 'extend' },
      );

      const header = { manifest: archive.manifest, vocabulary: archive.vocabulary };

      async function* chunks(): AsyncGenerator<ImportChunk> {
        yield { entities: archive.entities };
        yield { relationships: archive.relationships };
      }

      const result = await memory.importRepositoryStream(header, chunks(), {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000000b' },
        vocabularyConflict: 'extend',
        entityConflict: 'overwrite',
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(3);
      expect(result.warnings.some((w) => w.code === 'entity_overwritten')).toBe(true);
    });

    it('emits import events', async () => {
      const events: string[] = [];
      memory.on('import:started', () => { events.push('import:started'); });
      memory.on('import:completed', () => { events.push('import:completed'); });

      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      const header = { manifest: archive.manifest, vocabulary: archive.vocabulary };

      async function* chunks(): AsyncGenerator<ImportChunk> {
        yield { entities: archive.entities };
        yield { relationships: archive.relationships };
      }

      await memory.importRepositoryStream(header, chunks(), {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-00000000000c',
          config: { repositoryId: '10000000-0000-4000-a000-00000000000c', label: 'Events Test' },
        },
      });

      expect(events).toEqual(['import:started', 'import:completed']);
    });

    it('round-trip: stream export → stream import', async () => {
      // Collect stream export items
      const items: ExportStreamItem[] = [];
      for await (const item of memory.exportRepositoryStream('10000000-0000-4000-a000-000000000001')) {
        items.push(item);
      }

      const manifestItem = items.find((i) => i.type === 'manifest')!;
      const vocabItem = items.find((i) => i.type === 'vocabulary')!;

      if (manifestItem.type !== 'manifest' || vocabItem.type !== 'vocabulary') {
        throw new Error('Expected manifest and vocabulary items');
      }

      const header = { manifest: manifestItem.data, vocabulary: vocabItem.data };

      // Convert streamed data items into import chunks
      async function* toImportChunks(): AsyncGenerator<ImportChunk> {
        for (const item of items) {
          if (item.type === 'entities') {
            yield { entities: item.data };
          } else if (item.type === 'relationships') {
            yield { relationships: item.data };
          }
        }
      }

      const result = await memory.importRepositoryStream(header, toImportChunks(), {
        target: {
          mode: 'create',
          repositoryId: '10000000-0000-4000-a000-00000000000d',
          config: { repositoryId: '10000000-0000-4000-a000-00000000000d', label: 'Round-trip Stream' },
        },
      });

      expect(result.success).toBe(true);
      expect(result.statistics.entitiesImported).toBe(3);
      expect(result.statistics.relationshipsImported).toBe(2);

      // Verify data integrity
      const imported = await memory.openRepository('10000000-0000-4000-a000-00000000000d');
      const alice = await imported.getBySlug('person:alice', 'full');
      expect(alice).not.toBeNull();
      expect(alice!.label).toBe('Alice');

      const stats = await imported.getStats();
      expect(stats.entityCount).toBe(3);
      expect(stats.relationshipCount).toBe(2);
    });
  });
});
