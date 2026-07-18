import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { IndexingOrchestrator } from './IndexingOrchestrator.js';
import { StateManager } from './StateManager.js';
import type { DoclingConvertOptions } from '../conversion/types.js';
import type { OrchestratorConfig } from '../types/config.js';
import { DEFAULT_QUALITY_THRESHOLDS } from '../types/config.js';
import type { IndexSource, IndexSourceList } from '../types/source-list.js';

const PDF_BYTES = '%PDF-1.4 stable bytes';

function baseConfig(stateDir: string, convertOptions?: DoclingConvertOptions): OrchestratorConfig {
  return {
    stateDir,
    vocabularyPath: join(stateDir, 'vocabulary.md'),
    repositoryId: 'test-repo',
    extraction: { endpoint: 'http://localhost:0/v1', model: 'test', concurrency: 1 },
    consolidation: { endpoint: 'http://localhost:0/v1', model: 'test' },
    import: { storage: { type: 'memory' } },
    qualityThresholds: DEFAULT_QUALITY_THRESHOLDS,
    ...(convertOptions !== undefined
      ? { services: { docling: { endpoint: 'http://localhost:5001', convertOptions } } }
      : {}),
  };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('IndexingOrchestrator prepare re-convert trigger', () => {
  let root: string;
  let stateDir: string;
  let sourceDir: string;
  let state: StateManager;
  let pdfPath: string;
  let mdPath: string;
  let jsonPath: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'reconvert-trigger-'));
    stateDir = join(root, 'state');
    sourceDir = join(root, 'sources');
    await mkdir(stateDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    state = new StateManager(stateDir);
    await state.initialize();

    pdfPath = join(sourceDir, 'doc.pdf');
    await writeFile(pdfPath, PDF_BYTES, 'utf-8');
    mdPath = join(stateDir, 'converted', 'doc.md');
    jsonPath = join(stateDir, 'converted', 'doc.docling.json');
    await mkdir(join(stateDir, 'converted'), { recursive: true });
    await writeFile(mdPath, '# stale derived text', 'utf-8');
    await writeFile(jsonPath, '{}', 'utf-8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** A converted source whose bytes match its recorded hash. */
  function convertedSource(overrides: Partial<IndexSource> = {}): IndexSource {
    return {
      path: pdfPath,
      type: 'general',
      status: 'pending',
      originalFormat: '.pdf',
      sourceHash: createHash('sha256').update(PDF_BYTES).digest('hex'),
      derivedTextPath: mdPath,
      derivedDoclingJsonPath: jsonPath,
      ...overrides,
    };
  }

  async function seed(source: IndexSource): Promise<void> {
    const list: IndexSourceList = { version: '1.0.0', repositoryId: 'test-repo', sources: [source] };
    await state.saveSourceList(list);
  }

  it('re-queues a converted source when its per-source convert options changed', async () => {
    // Recorded options are absent; the new per-source override differs, so the
    // derived text is stale and the source must reconvert.
    await seed(convertedSource({ sourceConvertOptions: { tableCellMatching: false } }));

    await new IndexingOrchestrator(baseConfig(stateDir)).prepare(sourceDir);

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('needs-conversion');
    expect(source.derivedTextPath).toBeUndefined();
    expect(source.derivedDoclingJsonPath).toBeUndefined();
    expect(source.sourceHash).toBeUndefined();
    // Stale derived files were dropped so a failed reconversion can't be mistaken for current.
    expect(await fileExists(mdPath)).toBe(false);
    expect(await fileExists(jsonPath)).toBe(false);
  });

  it('re-queues a converted source when the process-level default convert options changed', async () => {
    // No per-source override; the process default now sets an option the last
    // conversion did not use — this too must reconvert.
    await seed(convertedSource());

    await new IndexingOrchestrator(baseConfig(stateDir, { tableCellMatching: false })).prepare(sourceDir);

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('needs-conversion');
    expect(source.sourceHash).toBeUndefined();
  });

  it('does not re-queue when the effective options equal what was last used', async () => {
    // The override matches what the last conversion recorded — no spurious reconvert.
    await seed(convertedSource({
      sourceConvertOptions: { tableCellMatching: false },
      convertOptionsUsed: { tableCellMatching: false },
    }));

    await new IndexingOrchestrator(baseConfig(stateDir)).prepare(sourceDir);

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('pending');
    expect(source.derivedTextPath).toBe(mdPath);
    expect(source.sourceHash).toBeDefined();
    // Derived files are untouched.
    expect(await fileExists(mdPath)).toBe(true);
  });

  it('does not re-queue an option-less source whose recorded options are absent', async () => {
    // Neither process default nor per-source options; recorded options absent.
    // Effective {} equals undefined, so an existing corpus is left alone.
    await seed(convertedSource());

    await new IndexingOrchestrator(baseConfig(stateDir)).prepare(sourceDir);

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('pending');
    expect(source.sourceHash).toBeDefined();
  });
});
