import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReviewDiagnostics } from './ReviewDiagnostics.js';
import type { StateManager } from '../orchestrator/StateManager.js';
import type { ExtractionOutput } from '../types/extraction.js';
import type { IndexSourceList } from '../types/source-list.js';

/** Build a minimal extraction output for testing */
function makeOutput(overrides: Partial<ExtractionOutput> = {}): ExtractionOutput {
  return {
    source: 'test-doc.md',
    sourcePath: '/docs/test-doc.md',
    extractedAt: '2026-04-05T00:00:00Z',
    extractedBy: 'test-worker',
    entities: [],
    relationships: [],
    ...overrides,
  };
}

/** Build a minimal source list */
function makeSourceList(sources: Array<{ path: string; status: string }>): IndexSourceList {
  return {
    version: '1.0.0',
    repositoryId: 'test-repo',
    sources: sources.map(s => ({
      path: s.path,
      type: 'spec-sheet',
      status: s.status as 'extracted' | 'excluded',
    })),
  };
}

function mockStateManager(sourceList: IndexSourceList, outputs: ExtractionOutput[]): StateManager {
  return {
    getSourceList: vi.fn().mockResolvedValue(sourceList),
    getExtractionOutputs: vi.fn().mockResolvedValue(outputs),
    getExtractionOutputsByWorker: vi.fn().mockResolvedValue(outputs),
    getStateDirPath: vi.fn().mockReturnValue('/mock/state'),
    saveReviewDiagnostics: vi.fn().mockResolvedValue(undefined),
    getReviewDiagnostics: vi.fn().mockResolvedValue(null),
  } as unknown as StateManager;
}

describe('ReviewDiagnostics', () => {
  describe('property coverage', () => {
    it('rates 100% coverage as good', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: { weight: '25t' }, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat 330F', properties: { weight: '30t' }, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.propertyCheck.zeroPropertyCount).toBe(0);
      expect(report.documents[0]!.propertyCheck.rating).toBe('good');
      expect(report.aggregate.propertyCoverageRating).toBe('good');
    });

    it('flags entities with zero properties', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: { weight: '25t' }, aliases: [], sourceRefs: [] },
          { entityType: 'Manufacturer', label: 'Cat', properties: {}, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.propertyCheck.zeroPropertyCount).toBe(1);
      expect(report.documents[0]!.propertyCheck.examples).toEqual([
        { entityType: 'Manufacturer', label: 'Cat' },
      ]);
    });

    it('rates <90% coverage as needs-work', async () => {
      // 8 of 10 entities have no properties → 80% coverage
      const entities = Array.from({ length: 10 }, (_, i) => ({
        entityType: 'Equipment',
        label: `Item ${i}`,
        properties: i < 2 ? { weight: '10t' } : {},
        aliases: [] as string[],
        sourceRefs: [],
      }));
      const output = makeOutput({ entities });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.propertyCheck.rating).toBe('needs-work');
    });
  });

  describe('orphan relationships', () => {
    it('detects orphan relationships with missing source labels', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F L', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Manufacturer', label: 'Caterpillar', properties: {}, aliases: [], sourceRefs: [] },
        ],
        relationships: [
          { type: 'MANUFACTURED_BY', sourceLabel: 'Cat 325F L', targetLabel: 'Caterpillar', properties: {}, sourceRefs: [] },
          { type: 'HAS_COMPONENT', sourceLabel: 'Cat 330F', targetLabel: 'Cat 325F L', properties: {}, sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      const orphanCheck = report.documents[0]!.orphanCheck;
      expect(orphanCheck.orphanCount).toBe(1);
      expect(orphanCheck.orphanPercent).toBe(50);
      expect(orphanCheck.missingSourceLabels).toEqual([{ label: 'Cat 330F', count: 1 }]);
      expect(orphanCheck.missingTargetLabels).toEqual([]);
    });

    it('matches aliases case-insensitively', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Caterpillar 325F L', properties: {}, aliases: ['Cat 325F L', '325F L'], sourceRefs: [] },
          { entityType: 'Manufacturer', label: 'Caterpillar', properties: {}, aliases: ['Cat'], sourceRefs: [] },
        ],
        relationships: [
          { type: 'MANUFACTURED_BY', sourceLabel: 'cat 325f l', targetLabel: 'cat', properties: {}, sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.orphanCheck.orphanCount).toBe(0);
      expect(report.documents[0]!.orphanCheck.rating).toBe('good');
    });

    it('rates >5% orphans as needs-work', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'A', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'B', properties: {}, aliases: [], sourceRefs: [] },
        ],
        relationships: Array.from({ length: 10 }, (_, i) => ({
          type: 'RELATED_TO',
          sourceLabel: i < 4 ? 'MISSING' : 'A',
          targetLabel: 'B',
          properties: {},
          sourceRefs: [],
        })),
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.orphanCheck.orphanCount).toBe(4);
      expect(report.documents[0]!.orphanCheck.rating).toBe('needs-work');
    });
  });

  describe('duplicate detection', () => {
    it('detects exact duplicates (case-insensitive)', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: { weight: '25t' }, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'cat 325f', properties: { weight: '25 tonnes' }, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat 330F', properties: { weight: '30t' }, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.duplicateCheck.duplicateCount).toBe(1);
      expect(report.documents[0]!.duplicateCheck.rating).toBe('needs-work');
    });

    it('reports zero duplicates as good', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat 330F', properties: {}, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.duplicateCheck.duplicateCount).toBe(0);
      expect(report.documents[0]!.duplicateCheck.rating).toBe('good');
    });
  });

  describe('label quality', () => {
    it('flags short labels', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'AB', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat 325F', properties: {}, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.labelCheck.badLabelCount).toBe(1);
      expect(report.documents[0]!.labelCheck.examples[0]!.reason).toBe('too-short');
    });

    it('flags JSON artifacts in labels', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: '{"name": "Cat 325F"}', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat [325F]', properties: {}, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.labelCheck.badLabelCount).toBe(2);
    });

    it('flags numeric-only labels', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: '12345', properties: {}, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.labelCheck.badLabelCount).toBe(1);
      expect(report.documents[0]!.labelCheck.examples[0]!.reason).toBe('numeric-only');
    });
  });

  describe('entity type distribution', () => {
    it('counts entities by type', async () => {
      const output = makeOutput({
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat 330F', properties: {}, aliases: [], sourceRefs: [] },
          { entityType: 'Manufacturer', label: 'Cat', properties: {}, aliases: [], sourceRefs: [] },
        ],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documents[0]!.entityTypeDistribution).toEqual({
        Equipment: 2,
        Manufacturer: 1,
      });
      expect(report.aggregate.entityTypeDistribution).toEqual({
        Equipment: 2,
        Manufacturer: 1,
      });
    });
  });

  describe('source filtering', () => {
    it('excludes sources with excluded status', async () => {
      const sourceList = makeSourceList([
        { path: '/docs/active.md', status: 'extracted' },
        { path: '/docs/excluded.md', status: 'excluded' },
      ]);
      const outputs = [
        makeOutput({ source: 'active.md', sourcePath: '/docs/active.md', entities: [{ entityType: 'Equipment', label: 'A', properties: {}, aliases: [], sourceRefs: [] }] }),
        makeOutput({ source: 'excluded.md', sourcePath: '/docs/excluded.md', entities: [{ entityType: 'Equipment', label: 'B', properties: {}, aliases: [], sourceRefs: [] }] }),
      ];
      const state = mockStateManager(sourceList, outputs);
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.documentsAnalyzed).toBe(1);
      expect(report.documents[0]!.source).toBe('active.md');
    });

    it('applies sourceFilter to narrow scope', async () => {
      const sourceList = makeSourceList([
        { path: '/docs/cat-manual.md', status: 'extracted' },
        { path: '/docs/komatsu-spec.md', status: 'extracted' },
      ]);
      const outputs = [
        makeOutput({ source: 'cat-manual.md', entities: [{ entityType: 'Equipment', label: 'A', properties: {}, aliases: [], sourceRefs: [] }] }),
        makeOutput({ source: 'komatsu-spec.md', entities: [{ entityType: 'Equipment', label: 'B', properties: {}, aliases: [], sourceRefs: [] }] }),
      ];
      const state = mockStateManager(sourceList, outputs);
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(['komatsu'], 'test-worker');

      expect(report.documentsAnalyzed).toBe(1);
      expect(report.documents[0]!.source).toBe('komatsu-spec.md');
    });
  });

  describe('aggregate metrics', () => {
    it('computes aggregate across multiple documents', async () => {
      const sourceList = makeSourceList([
        { path: '/docs/doc1.md', status: 'extracted' },
        { path: '/docs/doc2.md', status: 'extracted' },
      ]);
      const outputs = [
        makeOutput({
          source: 'doc1.md',
          entities: [
            { entityType: 'Equipment', label: 'A', properties: { w: '1' }, aliases: [], sourceRefs: [] },
            { entityType: 'Equipment', label: 'B', properties: {}, aliases: [], sourceRefs: [] },
          ],
          relationships: [
            { type: 'REL', sourceLabel: 'A', targetLabel: 'B', properties: {}, sourceRefs: [] },
            { type: 'REL', sourceLabel: 'MISSING', targetLabel: 'B', properties: {}, sourceRefs: [] },
          ],
        }),
        makeOutput({
          source: 'doc2.md',
          entities: [
            { entityType: 'Manufacturer', label: 'C', properties: { name: 'C' }, aliases: [], sourceRefs: [] },
          ],
          relationships: [
            { type: 'REL', sourceLabel: 'C', targetLabel: 'C', properties: {}, sourceRefs: [] },
          ],
        }),
      ];
      const state = mockStateManager(sourceList, outputs);
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      expect(report.aggregate.totalEntities).toBe(3);
      expect(report.aggregate.totalRelationships).toBe(3);
      expect(report.aggregate.orphanCount).toBe(1);
      expect(report.aggregate.zeroPropertyCount).toBe(1);
      expect(report.aggregate.duplicateCount).toBe(0);
    });

    it('computes worst overall rating', async () => {
      const sourceList = makeSourceList([
        { path: '/docs/doc1.md', status: 'extracted' },
      ]);
      // 10 entities: 9 have properties (90% coverage = acceptable), orphan rate high
      const entities = Array.from({ length: 10 }, (_, i) => ({
        entityType: 'Equipment',
        label: `E${i}`,
        properties: i < 9 ? { w: '1' } : {},
        aliases: [] as string[],
        sourceRefs: [],
      }));
      const relationships = Array.from({ length: 10 }, (_, i) => ({
        type: 'REL',
        sourceLabel: i < 4 ? 'MISSING' : 'E0',
        targetLabel: 'E1',
        properties: {},
        sourceRefs: [],
      }));
      const outputs = [makeOutput({ source: 'doc1.md', entities, relationships })];
      const state = mockStateManager(sourceList, outputs);
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run(undefined, 'test-worker');

      // Orphans at 40% → needs-work, coverage at 90% → acceptable
      // Overall should be needs-work (worst of the two)
      expect(report.aggregate.overallRating).toBe('needs-work');
    });
  });

  describe('multi-worker comparison', () => {
    function mockMultiWorkerState(
      sourceList: IndexSourceList,
      workerOutputs: Record<string, ExtractionOutput[]>,
    ): StateManager {
      return {
        getSourceList: vi.fn().mockResolvedValue(sourceList),
        getExtractionOutputs: vi.fn().mockResolvedValue([]),
        getExtractionOutputsByWorker: vi.fn().mockImplementation((name: string) =>
          Promise.resolve(workerOutputs[name] ?? []),
        ),
        getWorkerNames: vi.fn().mockResolvedValue(Object.keys(workerOutputs)),
        getStateDirPath: vi.fn().mockReturnValue('/mock/state'),
        saveReviewDiagnostics: vi.fn().mockResolvedValue(undefined),
        getReviewDiagnostics: vi.fn().mockResolvedValue(null),
      } as unknown as StateManager;
    }

    it('produces worker comparison when sources lack selectedExtraction', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [{
          path: '/docs/test-doc.md',
          type: 'spec-sheet',
          status: 'extracted' as const,
          extractionFiles: { 'worker-a': 'extraction-notes/worker-a/test-doc.json', 'worker-b': 'extraction-notes/worker-b/test-doc.json' },
          // no selectedExtraction
        }],
      };

      const workerAOutput = makeOutput({
        source: 'test-doc.md',
        sourcePath: '/docs/test-doc.md',
        extractedBy: 'worker-a',
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: { weight: '25t' }, aliases: [], sourceRefs: [] },
          { entityType: 'Equipment', label: 'Cat 330F', properties: { weight: '30t' }, aliases: [], sourceRefs: [] },
        ],
        relationships: [
          { type: 'RELATED_TO', sourceLabel: 'Cat 325F', targetLabel: 'Cat 330F', properties: {}, sourceRefs: [] },
        ],
      });

      const workerBOutput = makeOutput({
        source: 'test-doc.md',
        sourcePath: '/docs/test-doc.md',
        extractedBy: 'worker-b',
        entities: [
          { entityType: 'Equipment', label: 'Cat 325F', properties: {}, aliases: [], sourceRefs: [] },
        ],
        relationships: [
          { type: 'RELATED_TO', sourceLabel: 'Cat 325F', targetLabel: 'MISSING', properties: {}, sourceRefs: [] },
        ],
      });

      const state = mockMultiWorkerState(sourceList, {
        'worker-a': [workerAOutput],
        'worker-b': [workerBOutput],
      });

      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run();

      expect(report.workerComparison).toBeDefined();
      expect(report.workerComparison!.workers).toHaveLength(2);
      expect(report.workerComparison!.recommended).toBe('worker-a');

      // Worker A should have better scores
      const wA = report.workerComparison!.workers.find(w => w.workerName === 'worker-a')!;
      const wB = report.workerComparison!.workers.find(w => w.workerName === 'worker-b')!;
      expect(wA.aggregate.totalEntities).toBe(2);
      expect(wB.aggregate.totalEntities).toBe(1);
      expect(wA.aggregate.propertyCoverageRating).toBe('good');
      expect(wB.aggregate.zeroPropertyPercent).toBe(100);

      // Per-source comparison
      const sc = report.workerComparison!.sourceComparisons;
      expect(sc).toHaveLength(1);
      expect(sc[0]!.source).toBe('test-doc.md');
      expect(sc[0]!.recommended).toBe('worker-a');
      expect(sc[0]!.workers).toHaveLength(2);
      const scA = sc[0]!.workers.find(w => w.workerName === 'worker-a')!;
      const scB = sc[0]!.workers.find(w => w.workerName === 'worker-b')!;
      expect(scA.entityCount).toBe(2);
      expect(scB.entityCount).toBe(1);
      expect(scB.orphanPercent).toBe(100);
    });

    it('recommends different workers per source when appropriate', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [
          { path: '/docs/doc1.md', type: 'general', status: 'extracted' as const, extractionFiles: { 'w1': 'x', 'w2': 'y' } },
          { path: '/docs/doc2.md', type: 'general', status: 'extracted' as const, extractionFiles: { 'w1': 'x', 'w2': 'y' } },
        ],
      };

      // w1 is better at doc1 (good properties), w2 is better at doc2 (good properties)
      const w1Doc1 = makeOutput({
        source: 'doc1.md', sourcePath: '/docs/doc1.md', extractedBy: 'w1',
        entities: [
          { entityType: 'E', label: 'A', properties: { p: '1' }, aliases: [], sourceRefs: [] },
          { entityType: 'E', label: 'B', properties: { p: '2' }, aliases: [], sourceRefs: [] },
        ],
        relationships: [{ type: 'R', sourceLabel: 'A', targetLabel: 'B', properties: {}, sourceRefs: [] }],
      });
      const w2Doc1 = makeOutput({
        source: 'doc1.md', sourcePath: '/docs/doc1.md', extractedBy: 'w2',
        entities: [
          { entityType: 'E', label: 'A', properties: {}, aliases: [], sourceRefs: [] },
        ],
        relationships: [{ type: 'R', sourceLabel: 'A', targetLabel: 'MISSING', properties: {}, sourceRefs: [] }],
      });
      const w1Doc2 = makeOutput({
        source: 'doc2.md', sourcePath: '/docs/doc2.md', extractedBy: 'w1',
        entities: [
          { entityType: 'E', label: 'X', properties: {}, aliases: [], sourceRefs: [] },
        ],
        relationships: [{ type: 'R', sourceLabel: 'X', targetLabel: 'MISSING', properties: {}, sourceRefs: [] }],
      });
      const w2Doc2 = makeOutput({
        source: 'doc2.md', sourcePath: '/docs/doc2.md', extractedBy: 'w2',
        entities: [
          { entityType: 'E', label: 'X', properties: { p: '1' }, aliases: [], sourceRefs: [] },
          { entityType: 'E', label: 'Y', properties: { p: '2' }, aliases: [], sourceRefs: [] },
        ],
        relationships: [{ type: 'R', sourceLabel: 'X', targetLabel: 'Y', properties: {}, sourceRefs: [] }],
      });

      const state = mockMultiWorkerState(sourceList, {
        'w1': [w1Doc1, w1Doc2],
        'w2': [w2Doc1, w2Doc2],
      });

      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run();

      const sc = report.workerComparison!.sourceComparisons;
      expect(sc).toHaveLength(2);

      const doc1 = sc.find(s => s.source === 'doc1.md')!;
      const doc2 = sc.find(s => s.source === 'doc2.md')!;
      expect(doc1.recommended).toBe('w1');
      expect(doc2.recommended).toBe('w2');
    });

    it('does not produce comparison when selectedExtraction is set', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [{
          path: '/docs/test-doc.md',
          type: 'spec-sheet',
          status: 'extracted' as const,
          extractionFiles: { 'worker-a': 'extraction-notes/worker-a/test-doc.json' },
          selectedExtraction: 'extraction-notes/worker-a/test-doc.json',
        }],
      };

      const output = makeOutput({
        source: 'test-doc.md',
        sourcePath: '/docs/test-doc.md',
        extractedBy: 'worker-a',
        entities: [{ entityType: 'Equipment', label: 'A', properties: {}, aliases: [], sourceRefs: [] }],
      });

      // Mock that reads selectedExtraction path via getActiveExtractionOutputs (file-based)
      // Since the default path reads files, we need to mock at the right level
      const state = {
        getSourceList: vi.fn().mockResolvedValue(sourceList),
        getExtractionOutputs: vi.fn().mockResolvedValue([output]),
        getExtractionOutputsByWorker: vi.fn().mockResolvedValue([output]),
        getWorkerNames: vi.fn().mockResolvedValue(['worker-a']),
        getStateDirPath: vi.fn().mockReturnValue('/mock/state'),
        saveReviewDiagnostics: vi.fn().mockResolvedValue(undefined),
        getReviewDiagnostics: vi.fn().mockResolvedValue(null),
      } as unknown as StateManager;

      const diagnostics = new ReviewDiagnostics(state);
      // With workerName specified, no comparison
      const report = await diagnostics.run(undefined, 'worker-a');
      expect(report.workerComparison).toBeUndefined();
    });

    it('recommends single worker when only one exists', async () => {
      const sourceList: IndexSourceList = {
        version: '1.0.0',
        repositoryId: 'test-repo',
        sources: [{
          path: '/docs/test-doc.md',
          type: 'spec-sheet',
          status: 'extracted' as const,
          extractionFiles: { 'solo-worker': 'extraction-notes/solo-worker/test-doc.json' },
        }],
      };

      const output = makeOutput({
        source: 'test-doc.md',
        sourcePath: '/docs/test-doc.md',
        extractedBy: 'solo-worker',
        entities: [{ entityType: 'Equipment', label: 'A', properties: { w: '1' }, aliases: [], sourceRefs: [] }],
      });

      const state = mockMultiWorkerState(sourceList, { 'solo-worker': [output] });
      const diagnostics = new ReviewDiagnostics(state);
      const report = await diagnostics.run();

      expect(report.workerComparison).toBeDefined();
      expect(report.workerComparison!.recommended).toBe('solo-worker');
      expect(report.workerComparison!.reason).toContain('Only one worker');
    });
  });

  describe('report persistence', () => {
    it('saves the report via StateManager', async () => {
      const output = makeOutput({
        entities: [{ entityType: 'Equipment', label: 'A', properties: {}, aliases: [], sourceRefs: [] }],
      });
      const state = mockStateManager(
        makeSourceList([{ path: '/docs/test-doc.md', status: 'extracted' }]),
        [output],
      );
      const diagnostics = new ReviewDiagnostics(state);
      await diagnostics.run(undefined, 'test-worker');

      expect(state.saveReviewDiagnostics).toHaveBeenCalledTimes(1);
      const savedReport = (state.saveReviewDiagnostics as ReturnType<typeof vi.fn>).mock.calls[0]![0];
      expect(savedReport.documentsAnalyzed).toBe(1);
      expect(savedReport.generatedAt).toBeDefined();
    });
  });
});
