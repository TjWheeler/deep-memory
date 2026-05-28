// Portability — tests for export, import, and vocabulary migration

import { describe, it, expect, beforeEach } from 'vitest';
import { DeepMemory } from '../core/DeepMemory.js';
import { DuplicateRelationshipError, OperationAbortedError } from '../core/errors.js';
import { InMemoryStorageProvider } from '../providers-builtin/InMemoryStorageProvider.js';
import type { MemoryRepository } from '../core/MemoryRepository.js';
import type { ExportArchive, ExportStreamItem, ImportChunk } from '../types/portability.js';

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

  beforeEach(async () => {
    memory = new DeepMemory({
      storage: new InMemoryStorageProvider(),
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

    it('fails for non-existent target repo', async () => {
      const result = await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000ffff' },
      });

      expect(result.success).toBe(false);
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

    it('emits import:failed event on failure', async () => {
      const events: string[] = [];
      memory.on('import:failed', () => { events.push('import:failed'); });

      const archive = await memory.exportRepository('10000000-0000-4000-a000-000000000001');
      await memory.importRepository(archive, {
        target: { mode: 'merge', repositoryId: '10000000-0000-4000-a000-00000000ffff' },
      });

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
