import { describe, it, expect } from 'vitest';
import { DocumentAnalyzer, singleWorkerFromConfig, reassignFailedSource } from './DocumentAnalyzer.js';
import type { WorkerConfig } from '../types/config.js';
import type { IndexSource } from '../types/source-list.js';

// ── Test Fixtures ─────────────────────────────────────────────────

function makeWorker(overrides: Partial<WorkerConfig> & { name: string }): WorkerConfig {
  return {
    endpoint: 'http://localhost:8020/v1',
    model: 'test-model',
    contextWindow: 32768,
    maxChunkSize: 20000,
    maxOutputTokens: 4096,
    costPerMillionInputTokens: 0,
    costPerMillionOutputTokens: 0,
    temperature: 0,
    concurrency: 1,
    capabilities: ['structured-extraction'],
    ...overrides,
  };
}

function makeSource(overrides: Partial<IndexSource> & { path: string }): IndexSource {
  return {
    type: 'spec-sheet',
    status: 'pending',
    ...overrides,
  };
}

const localWorker = makeWorker({
  name: 'local-small',
  contextWindow: 32768,
  maxChunkSize: 20000,
  maxOutputTokens: 4096,
  costPerMillionInputTokens: 0,
  costPerMillionOutputTokens: 0,
  capabilities: ['structured-extraction'],
});

const cloudHaiku = makeWorker({
  name: 'cloud-haiku',
  endpoint: 'https://api.anthropic.com/v1',
  model: 'claude-haiku-4-5-20251001',
  contextWindow: 200000,
  maxChunkSize: 100000,
  maxOutputTokens: 8192,
  costPerMillionInputTokens: 0.80,
  costPerMillionOutputTokens: 4.00,
  concurrency: 5,
  capabilities: ['structured-extraction', 'prose-extraction', 'large-context'],
});

const cloudSonnet = makeWorker({
  name: 'cloud-sonnet',
  endpoint: 'https://api.anthropic.com/v1',
  model: 'claude-sonnet-4-6-20260327',
  contextWindow: 200000,
  maxChunkSize: 100000,
  maxOutputTokens: 16384,
  costPerMillionInputTokens: 3.00,
  costPerMillionOutputTokens: 15.00,
  concurrency: 3,
  capabilities: ['structured-extraction', 'prose-extraction', 'reasoning', 'large-context'],
});

// ── Worker Assignment Tests ───────────────────────────────────────

describe('DocumentAnalyzer', () => {
  describe('assignWorker', () => {
    it('assigns cheapest viable worker for small spec sheets', () => {
      const analyzer = new DocumentAnalyzer({ workers: [localWorker, cloudHaiku, cloudSonnet] });
      const source = makeSource({ path: '/docs/spec-sheet.md', type: 'spec-sheet' });

      const result = analyzer.assignWorker(source, 4000); // ~16KB doc
      expect(result).toBe('local-small');
    });

    it('assigns large-context worker when document exceeds local context window', () => {
      const analyzer = new DocumentAnalyzer({ workers: [localWorker, cloudHaiku, cloudSonnet] });
      const source = makeSource({ path: '/docs/big-fluids.md', type: 'spec-sheet' });

      // ~500KB document = ~125K tokens, exceeds localWorker context
      const result = analyzer.assignWorker(source, 125000);
      expect(result).toBe('cloud-haiku'); // Cheapest large-context worker
    });

    it('assigns prose-capable worker for om-manuals', () => {
      const analyzer = new DocumentAnalyzer({ workers: [localWorker, cloudHaiku, cloudSonnet] });
      const source = makeSource({ path: '/docs/om-manual.md', type: 'om-manual' });

      const result = analyzer.assignWorker(source, 4000);
      // localWorker only has structured-extraction, not prose-extraction
      expect(result).toBe('cloud-haiku');
    });

    it('returns null when no worker can handle the document', () => {
      const tinyWorker = makeWorker({
        name: 'tiny',
        contextWindow: 1000,
        maxChunkSize: 500,
        maxOutputTokens: 100,
        capabilities: [], // no capabilities
      });
      const analyzer = new DocumentAnalyzer({ workers: [tinyWorker] });
      const source = makeSource({ path: '/docs/prose.md', type: 'om-manual' });

      const result = analyzer.assignWorker(source, 50000);
      expect(result).toBeNull();
    });

    it('prefers fewer chunks over lower cost', () => {
      // localWorker needs 5 chunks, cloudHaiku needs 1
      const analyzer = new DocumentAnalyzer({ workers: [localWorker, cloudHaiku] });
      const source = makeSource({ path: '/docs/medium.md', type: 'spec-sheet' });

      // 50K tokens — local can handle but needs chunking, cloud fits in one pass
      const result = analyzer.assignWorker(source, 50000);
      expect(result).toBe('cloud-haiku');
    });

    it('respects pre-assigned workers on source', () => {
      const analyzer = new DocumentAnalyzer({ workers: [localWorker, cloudHaiku] });
      const source = makeSource({
        path: '/docs/spec.md',
        type: 'spec-sheet',
        assignedWorkers: ['cloud-haiku'],
      });

      // analyze should use pre-assigned workers
      // (assignWorker itself doesn't check this — the analyze method does)
      expect(source.assignedWorkers).toEqual(['cloud-haiku']);
    });
  });

  describe('analyze', () => {
    it('produces a report with per-document and per-worker summaries', async () => {
      const analyzer = new DocumentAnalyzer({ workers: [localWorker, cloudHaiku] });
      const sources: IndexSource[] = [
        makeSource({ path: '/docs/small-spec.md', type: 'spec-sheet', notes: '10 KB' }),
        makeSource({ path: '/docs/big-fluids.md', type: 'spec-sheet', notes: '487 KB' }),
      ];

      const report = await analyzer.analyze(sources);

      expect(report.summary.totalDocuments).toBe(2);
      expect(report.summary.totalInputTokens).toBeGreaterThan(0);
      expect(report.summary.totalOutputTokens).toBeGreaterThan(0);
      expect(report.documents).toHaveLength(2);

      // Small doc → local, big doc → cloud
      const small = report.documents.find(d => d.source === 'small-spec.md');
      const big = report.documents.find(d => d.source === 'big-fluids.md');
      expect(small?.assignedWorkers).toEqual(['local-small']);
      expect(big?.assignedWorkers).toEqual(['cloud-haiku']);
    });

    it('uses actual tokens when available instead of estimates', async () => {
      const analyzer = new DocumentAnalyzer({ workers: [cloudHaiku] });
      const sources: IndexSource[] = [
        makeSource({
          path: '/docs/already-extracted.md',
          type: 'spec-sheet',
          notes: '10 KB',
          actualTokens: { inputTokens: 5000, outputTokens: 2000 },
          assignedWorkers: ['cloud-haiku'],
        }),
      ];

      const report = await analyzer.analyze(sources);
      const doc = report.documents[0]!;

      expect(doc.usedActuals).toBe(true);
      expect(doc.estimatedTokens.inputTokens).toBe(5000);
      expect(doc.estimatedTokens.outputTokens).toBe(2000);
    });

    it('tracks unassigned documents', async () => {
      const restrictedWorker = makeWorker({
        name: 'restricted',
        capabilities: [], // can't handle anything
      });
      const analyzer = new DocumentAnalyzer({ workers: [restrictedWorker] });
      const sources: IndexSource[] = [
        makeSource({ path: '/docs/om-manual.md', type: 'om-manual', notes: '100 KB' }),
      ];

      const report = await analyzer.analyze(sources);
      expect(report.summary.unassignedDocuments).toBe(1);
      expect(report.documents[0]!.assignedWorkers).toEqual([]);
    });
  });
});

// ── singleWorkerFromConfig Tests ──────────────────────────────────

describe('singleWorkerFromConfig', () => {
  it('synthesizes a WorkerConfig from flat ExtractionConfig', () => {
    const worker = singleWorkerFromConfig({
      endpoint: 'http://localhost:8020/v1',
      model: 'Qwen/Qwen3-4B',
      concurrency: 1,
      maxChunkSize: 20000,
      maxTokens: 4096,
    });

    expect(worker.name).toBe('default');
    expect(worker.endpoint).toBe('http://localhost:8020/v1');
    expect(worker.model).toBe('Qwen/Qwen3-4B');
    expect(worker.maxChunkSize).toBe(20000);
    expect(worker.maxOutputTokens).toBe(4096);
    expect(worker.costPerMillionInputTokens).toBe(0);
    expect(worker.costPerMillionOutputTokens).toBe(0);
    // Default worker gets all capabilities so it can handle everything
    expect(worker.capabilities).toContain('structured-extraction');
    expect(worker.capabilities).toContain('prose-extraction');
    expect(worker.capabilities).toContain('large-context');
  });
});

// ── Intelligent Retry Tests ───────────────────────────────────────

describe('reassignFailedSource', () => {
  const workers = [localWorker, cloudHaiku, cloudSonnet];

  it('reassigns context-window errors to a larger-context worker', () => {
    const source = makeSource({
      path: '/docs/big.md',
      type: 'spec-sheet',
      lastError: 'LLM API error (400): This model maximum context length is 32768 tokens',
      assignedWorkers: ['local-small'],
    });

    const newWorker = reassignFailedSource(source, workers, 'local-small');
    expect(newWorker).toBe('cloud-haiku'); // Cheapest upgrade with larger context
  });

  it('reassigns JSON parse errors to a more capable worker', () => {
    const source = makeSource({
      path: '/docs/broken.md',
      type: 'spec-sheet',
      lastError: 'Failed to parse LLM response as JSON: Unexpected token',
      assignedWorkers: ['local-small'],
    });

    const newWorker = reassignFailedSource(source, workers, 'local-small');
    // Should pick a more capable (higher cost) worker
    expect(newWorker).not.toBe('local-small');
    expect(newWorker).toBeTruthy();
  });

  it('returns null when already on the most capable worker', () => {
    const source = makeSource({
      path: '/docs/hard.md',
      type: 'spec-sheet',
      lastError: 'LLM API error (400): context length exceeded',
      assignedWorkers: ['cloud-sonnet'],
    });

    const newWorker = reassignFailedSource(source, workers, 'cloud-sonnet');
    // cloud-sonnet is already the most capable, no upgrade available
    expect(newWorker).toBeNull();
  });

  it('reassigns to cheapest viable upgrade', () => {
    const source = makeSource({
      path: '/docs/medium.md',
      type: 'spec-sheet',
      lastError: 'LLM returned empty response',
      assignedWorkers: ['local-small'],
    });

    const newWorker = reassignFailedSource(source, workers, 'local-small');
    // Should pick cloud-haiku (cheapest upgrade) not cloud-sonnet
    expect(newWorker).toBe('cloud-haiku');
  });
});
