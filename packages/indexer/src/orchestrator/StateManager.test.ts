import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from './StateManager.js';
import type { IndexSourceList } from '../types/source-list.js';
import type { EntityRegistry } from '../types/registry.js';
import type { ExtractionOutput } from '../types/extraction.js';

describe('StateManager', () => {
  let stateDir: string;
  let manager: StateManager;

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'indexer-test-'));
    manager = new StateManager(stateDir);
    await manager.initialize();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe('source list', () => {
    it('returns null when no source list exists', async () => {
      const result = await manager.getSourceList();
      expect(result).toBeNull();
    });

    it('saves and loads a source list', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [
          { path: '/docs/spec.md', type: 'spec-sheet', status: 'pending' },
          { path: '/docs/manual.md', type: 'om-manual', status: 'extracted', extractionFiles: { 'worker-1': 'extraction-notes/worker-1/manual.json' }, selectedExtraction: 'extraction-notes/worker-1/manual.json' },
        ],
      };

      await manager.saveSourceList(sourceList);
      const loaded = await manager.getSourceList();

      expect(loaded).toEqual(sourceList);
    });

    it('updates source status', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [
          { path: '/docs/spec.md', type: 'spec-sheet', status: 'pending' },
        ],
      };

      await manager.saveSourceList(sourceList);
      await manager.updateSourceStatus('/docs/spec.md', 'extracted');

      const loaded = await manager.getSourceList();
      expect(loaded!.sources[0]!.status).toBe('extracted');
    });

    it('throws when updating non-existent source', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [],
      };

      await manager.saveSourceList(sourceList);

      await expect(
        manager.updateSourceStatus('/nonexistent.md', 'extracted'),
      ).rejects.toThrow('Source not found');
    });

    it('filters sources by status', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [
          { path: '/a.md', type: 'general', status: 'pending' },
          { path: '/b.md', type: 'general', status: 'extracted' },
          { path: '/c.md', type: 'general', status: 'pending' },
        ],
      };

      await manager.saveSourceList(sourceList);

      const pending = await manager.getSourcesByStatus('pending');
      expect(pending).toHaveLength(2);
      expect(pending.map(s => s.path)).toEqual(['/a.md', '/c.md']);
    });
  });

  describe('entity registry', () => {
    it('returns null when no registry exists', async () => {
      const result = await manager.getRegistry();
      expect(result).toBeNull();
    });

    it('saves and loads a registry', async () => {
      const registry: EntityRegistry = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        lastUpdated: '2026-04-03T10:00:00Z',
        entities: [
          {
            id: 'uuid-1',
            slug: 'Equipment:komatsu-930e',
            entityType: 'Equipment',
            label: 'Komatsu 930E',
            status: 'imported',
            aliases: ['930E'],
            sourceDocuments: ['spec.md'],
          },
        ],
      };

      await manager.saveRegistry(registry);
      const loaded = await manager.getRegistry();

      expect(loaded!.entities).toHaveLength(1);
      expect(loaded!.entities[0]!.label).toBe('Komatsu 930E');
      // lastUpdated should be refreshed on save
      expect(loaded!.lastUpdated).not.toBe('2026-04-03T10:00:00Z');
    });

    it('finds registry entry by slug', async () => {
      const registry: EntityRegistry = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        lastUpdated: '',
        entities: [
          {
            id: 'uuid-1',
            slug: 'Equipment:komatsu-930e',
            entityType: 'Equipment',
            label: 'Komatsu 930E',
            status: 'imported',
            aliases: [],
            sourceDocuments: [],
          },
        ],
      };

      await manager.saveRegistry(registry);

      const found = await manager.findRegistryEntry('Equipment:komatsu-930e');
      expect(found).toBeDefined();
      expect(found!.id).toBe('uuid-1');

      const notFound = await manager.findRegistryEntry('Equipment:cat-793f');
      expect(notFound).toBeUndefined();
    });
  });

  describe('extraction outputs', () => {
    it('returns empty array when no outputs exist', async () => {
      const outputs = await manager.getExtractionOutputs();
      expect(outputs).toEqual([]);
    });

    it('saves extraction output to worker subdirectory', async () => {
      const output: ExtractionOutput = {
        source: 'spec-sheet.md',
        sourcePath: '/docs/spec-sheet.md',
        extractedAt: '2026-04-03T10:00:00Z',
        extractedBy: 'worker-1',
        entities: [
          {
            entityType: 'Equipment',
            label: 'Komatsu 930E',
            summary: 'Electric drive truck',
            properties: { operatingWeight: '292 MT' },
            aliases: ['930E'],
            sourceRefs: [{ description: 'Main spec', lineStart: 10, lineEnd: 20 }],
          },
        ],
        relationships: [],
      };

      const filename = await manager.saveExtractionOutput(output, 'cloud-haiku');
      expect(filename).toBe('extraction-notes/cloud-haiku/spec-sheet.json');
    });

    it('getExtractionOutputs returns only selected outputs', async () => {
      const output: ExtractionOutput = {
        source: 'spec-sheet.md',
        sourcePath: '/docs/spec-sheet.md',
        extractedAt: '2026-04-03T10:00:00Z',
        extractedBy: 'worker-1',
        entities: [],
        relationships: [],
      };

      const path = await manager.saveExtractionOutput(output, 'cloud-haiku');

      // Without a source list with selectedExtraction, returns nothing
      await manager.saveSourceList({
        version: '1.0.0',
        repositoryId: 'test',
        sources: [{ path: '/docs/spec-sheet.md', type: 'spec-sheet', status: 'extracted' }],
      });
      expect(await manager.getExtractionOutputs()).toHaveLength(0);

      // With selectedExtraction set, returns the output
      await manager.updateSource('/docs/spec-sheet.md', { selectedExtraction: path });
      const outputs = await manager.getExtractionOutputs();
      expect(outputs).toHaveLength(1);
      expect(outputs[0]!.source).toBe('spec-sheet.md');
    });

    it('getExtractionOutputsByWorker returns outputs for a specific worker', async () => {
      await manager.saveExtractionOutput({
        source: 'spec-sheet.md',
        sourcePath: '/docs/spec-sheet.md',
        extractedAt: '',
        extractedBy: 'cloud-haiku',
        entities: [],
        relationships: [],
      }, 'cloud-haiku');

      await manager.saveExtractionOutput({
        source: 'spec-sheet.md',
        sourcePath: '/docs/spec-sheet.md',
        extractedAt: '',
        extractedBy: 'qwen35',
        entities: [],
        relationships: [],
      }, 'qwen35');

      const haikuOutputs = await manager.getExtractionOutputsByWorker('cloud-haiku');
      expect(haikuOutputs).toHaveLength(1);
      expect(haikuOutputs[0]!.extractedBy).toBe('cloud-haiku');

      const qwenOutputs = await manager.getExtractionOutputsByWorker('qwen35');
      expect(qwenOutputs).toHaveLength(1);
      expect(qwenOutputs[0]!.extractedBy).toBe('qwen35');
    });

    it('auto-selects extraction when only one worker is assigned', async () => {
      await manager.saveSourceList({
        version: '1.0.0',
        repositoryId: 'test',
        sources: [
          { path: '/docs/spec.md', type: 'spec-sheet', status: 'pending', assignedWorkers: ['only-worker'] },
        ],
      });

      const status = await manager.recordExtractionComplete(
        '/docs/spec.md',
        'only-worker',
        'extraction-notes/only-worker/spec.json',
        {},
      );

      expect(status).toBe('extracted');
      const loaded = await manager.getSourceList();
      const source = loaded!.sources.find(s => s.path === '/docs/spec.md')!;
      expect(source.selectedExtraction).toBe('extraction-notes/only-worker/spec.json');
    });

    it('does not auto-select extraction when multiple workers are assigned', async () => {
      await manager.saveSourceList({
        version: '1.0.0',
        repositoryId: 'test',
        sources: [
          { path: '/docs/spec.md', type: 'spec-sheet', status: 'pending', assignedWorkers: ['worker-a', 'worker-b'] },
        ],
      });

      // First worker completes
      await manager.recordExtractionComplete(
        '/docs/spec.md',
        'worker-a',
        'extraction-notes/worker-a/spec.json',
        {},
      );
      let loaded = await manager.getSourceList();
      let source = loaded!.sources.find(s => s.path === '/docs/spec.md')!;
      expect(source.selectedExtraction).toBeUndefined();
      expect(source.status).toBe('pending');

      // Second worker completes — still no auto-selection, user must choose
      await manager.recordExtractionComplete(
        '/docs/spec.md',
        'worker-b',
        'extraction-notes/worker-b/spec.json',
        {},
      );
      loaded = await manager.getSourceList();
      source = loaded!.sources.find(s => s.path === '/docs/spec.md')!;
      expect(source.selectedExtraction).toBeUndefined();
      expect(source.status).toBe('extracted');
    });

    it('checks if extraction output exists for a worker', async () => {
      expect(await manager.hasExtractionOutput('spec-sheet.md', 'cloud-haiku')).toBe(false);

      await manager.saveExtractionOutput({
        source: 'spec-sheet.md',
        sourcePath: '/docs/spec-sheet.md',
        extractedAt: '',
        extractedBy: 'worker',
        entities: [],
        relationships: [],
      }, 'cloud-haiku');

      expect(await manager.hasExtractionOutput('spec-sheet.md', 'cloud-haiku')).toBe(true);
      expect(await manager.hasExtractionOutput('spec-sheet.md', 'qwen35')).toBe(false);
    });
  });

  describe('resume detection', () => {
    it('returns prepare when no state exists', async () => {
      expect(await manager.getCurrentPhase()).toBe('prepare');
    });

    it('returns extract when sources are pending', async () => {
      await manager.saveSourceList({
        version: '1.0.0',
        repositoryId: 'test',
        sources: [
          { path: '/a.md', type: 'general', status: 'pending' },
          { path: '/b.md', type: 'general', status: 'extracted' },
        ],
      });

      expect(await manager.getCurrentPhase()).toBe('extract');
    });

    it('returns extraction-review when all extracted but no archive', async () => {
      await manager.saveSourceList({
        version: '1.0.0',
        repositoryId: 'test',
        sources: [
          { path: '/a.md', type: 'general', status: 'extracted' },
          { path: '/b.md', type: 'general', status: 'extracted' },
        ],
      });

      expect(await manager.getCurrentPhase()).toBe('extraction-review');
    });

    it('returns complete when all validated', async () => {
      await manager.saveSourceList({
        version: '1.0.0',
        repositoryId: 'test',
        sources: [
          { path: '/a.md', type: 'general', status: 'validated' },
        ],
      });

      expect(await manager.getCurrentPhase()).toBe('complete');
    });
  });

  describe('reorderSource', () => {
    const makeSourceList = (): IndexSourceList => ({
      version: '1.0.0',
      repositoryId: 'test-repo',
      sources: [
        { path: '/a.md', type: 'general', status: 'pending' },
        { path: '/b.md', type: 'general', status: 'pending' },
        { path: '/c.md', type: 'general', status: 'pending' },
        { path: '/d.md', type: 'general', status: 'pending' },
      ],
    });

    it('moves source to a numeric index', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex, total } = await manager.reorderSource('/a.md', 2);

      expect(newIndex).toBe(2);
      expect(total).toBe(4);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/b.md', '/c.md', '/a.md', '/d.md']);
    });

    it('moves source to start', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex } = await manager.reorderSource('/c.md', 'start');

      expect(newIndex).toBe(0);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/c.md', '/a.md', '/b.md', '/d.md']);
    });

    it('moves source to end', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex } = await manager.reorderSource('/a.md', 'end');

      expect(newIndex).toBe(3);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/b.md', '/c.md', '/d.md', '/a.md']);
    });

    it('moves source up one position', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex } = await manager.reorderSource('/c.md', 'up');

      expect(newIndex).toBe(1);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/a.md', '/c.md', '/b.md', '/d.md']);
    });

    it('moves source down one position', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex } = await manager.reorderSource('/b.md', 'down');

      expect(newIndex).toBe(2);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/a.md', '/c.md', '/b.md', '/d.md']);
    });

    it('up is no-op when already first', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex } = await manager.reorderSource('/a.md', 'up');

      expect(newIndex).toBe(0);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
    });

    it('down is no-op when already last', async () => {
      await manager.saveSourceList(makeSourceList());
      const { newIndex } = await manager.reorderSource('/d.md', 'down');

      expect(newIndex).toBe(3);

      const list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
    });

    it('clamps out-of-range numeric index to valid range', async () => {
      await manager.saveSourceList(makeSourceList());

      // Index too high
      const high = await manager.reorderSource('/a.md', 100);
      expect(high.newIndex).toBe(3);
      let list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/b.md', '/c.md', '/d.md', '/a.md']);

      // Index too low (negative)
      const low = await manager.reorderSource('/a.md', -5);
      expect(low.newIndex).toBe(0);
      list = await manager.getSourceList();
      expect(list!.sources.map(s => s.path)).toEqual(['/a.md', '/b.md', '/c.md', '/d.md']);
    });

    it('throws when source not found', async () => {
      await manager.saveSourceList(makeSourceList());
      await expect(manager.reorderSource('/nonexistent.md', 'start')).rejects.toThrow('Source not found');
    });
  });

  describe('extraction progress file naming', () => {
    it('writeExtractionProgress handles filenames without colons or backslashes', async () => {
      const progress = {
        source: 'simple-doc.md',
        sourcePath: '/docs/simple-doc.md',
        totalChunks: 1,
        completedChunks: 0,
        startedAt: '2026-04-10T10:00:00Z',
        elapsedMs: 0,
        tokensUsed: { inputTokens: 0, outputTokens: 0 },
        entitiesSoFar: 0,
        relationshipsSoFar: 0,
      };

      await manager.writeExtractionProgress('simple-doc.md', progress, 'worker-1');

      const active = await manager.getActiveExtractionProgress();
      expect(active).toHaveLength(1);

      await manager.deleteExtractionProgress('simple-doc.md', 'worker-1');
    });
  });

  describe('process lock', () => {
    it('returns null when no lock is held', async () => {
      const lock = await manager.getProcessLock();
      expect(lock).toBeNull();
    });

    it('acquires a lock successfully', async () => {
      const acquired = await manager.acquireProcessLock('extraction');
      expect(acquired).toBe(true);

      const lock = await manager.getProcessLock();
      expect(lock).not.toBeNull();
      expect(lock!.operation).toBe('extraction');
      expect(lock!.pid).toBe(process.pid);
    });

    it('rejects a second acquire while lock is held', async () => {
      await manager.acquireProcessLock('extraction');
      const second = await manager.acquireProcessLock('embeddings');
      expect(second).toBe(false);

      // Original lock is still in place
      const lock = await manager.getProcessLock();
      expect(lock!.operation).toBe('extraction');
    });

    it('allows acquire after release', async () => {
      await manager.acquireProcessLock('extraction');
      await manager.releaseProcessLock();

      const acquired = await manager.acquireProcessLock('embeddings');
      expect(acquired).toBe(true);

      const lock = await manager.getProcessLock();
      expect(lock!.operation).toBe('embeddings');
    });

    it('release is safe when no lock exists', async () => {
      // Should not throw
      await manager.releaseProcessLock();
    });
  });
});
