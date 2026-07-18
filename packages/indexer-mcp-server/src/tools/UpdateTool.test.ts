import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { StateManager } from '@utaba/deep-memory-indexer';
import type { IndexSource, IndexSourceList } from '@utaba/deep-memory-indexer';
import { UpdateTool } from './UpdateTool.js';
import type { ILogger } from '../interfaces/ILogger.js';

const silentLogger: ILogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

describe('UpdateTool sourceConvertOptions', () => {
  let processDir: string;
  let stateDir: string;
  let state: StateManager;
  const sourcePath = '/docs/doc.pdf';

  async function seed(source: IndexSource): Promise<void> {
    const list: IndexSourceList = { version: '1.0.0', repositoryId: 'test-repo', sources: [source] };
    await state.saveSourceList(list);
  }

  function convertedSource(overrides: Partial<IndexSource> = {}): IndexSource {
    return {
      path: sourcePath,
      type: 'general',
      status: 'pending',
      originalFormat: '.pdf',
      derivedTextPath: join(stateDir, 'converted', 'doc.md'),
      ...overrides,
    };
  }

  beforeEach(async () => {
    processDir = await mkdtemp(join(tmpdir(), 'update-tool-'));
    stateDir = join(processDir, 'state');
    await mkdir(stateDir, { recursive: true });
    state = new StateManager(stateDir);
    await state.initialize();
  });

  afterEach(async () => {
    await rm(processDir, { recursive: true, force: true });
  });

  it('auto-queues a converted source for re-conversion when the options change', async () => {
    await seed(convertedSource());
    const tool = new UpdateTool(silentLogger);

    await tool.execute({ processDir, source: 'doc.pdf', sourceConvertOptions: { tableCellMatching: false } });

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('needs-conversion');
    expect(source.sourceConvertOptions).toEqual({ tableCellMatching: false });
  });

  it('does not auto-queue when the options equal what was last used', async () => {
    await seed(convertedSource({ convertOptionsUsed: { tableCellMatching: false } }));
    const tool = new UpdateTool(silentLogger);

    await tool.execute({ processDir, source: 'doc.pdf', sourceConvertOptions: { tableCellMatching: false } });

    const source = (await state.getSourceList())!.sources[0]!;
    // Options unchanged relative to the last conversion — no re-queue.
    expect(source.status).toBe('pending');
    expect(source.sourceConvertOptions).toEqual({ tableCellMatching: false });
  });

  it('does not auto-queue a source that was never converted', async () => {
    await seed({ path: sourcePath, type: 'general', status: 'pending', originalFormat: '.pdf' });
    const tool = new UpdateTool(silentLogger);

    await tool.execute({ processDir, source: 'doc.pdf', sourceConvertOptions: { tableCellMatching: false } });

    const source = (await state.getSourceList())!.sources[0]!;
    // No derived text yet, so nothing to invalidate — convert picks it up as-is.
    expect(source.status).toBe('pending');
  });

  it('rejects an unknown convert-option key', async () => {
    await seed(convertedSource());
    const tool = new UpdateTool(silentLogger);

    await expect(
      tool.execute({ processDir, source: 'doc.pdf', sourceConvertOptions: { bogusKey: true } }),
    ).rejects.toThrow(/Unknown sourceConvertOptions key/);
  });

  it('accepts needs-conversion as an explicit sourceStatus escape hatch', async () => {
    await seed(convertedSource());
    const tool = new UpdateTool(silentLogger);

    await tool.execute({ processDir, source: 'doc.pdf', sourceStatus: 'needs-conversion' });

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('needs-conversion');
  });
});
