import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertSources, deriveDocSlug, detectMime, type DocumentConverterDeps } from './DocumentConverter.js';
import { DoclingServiceError } from './errors.js';
import type { DoclingClient } from './DoclingClient.js';
import type { DoclingConvertRequest, DoclingConvertResponse } from './types.js';
import { StateManager } from '../orchestrator/StateManager.js';
import type { IndexSourceList } from '../types/source-list.js';

/**
 * A DoclingClient stand-in that returns a scripted Markdown payload per
 * filename, or throws when the filename is listed as a failure.
 */
function fakeClient(
  markdownByFilename: Record<string, string>,
  failFilenames: Set<string> = new Set(),
): { client: DoclingClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    async postConvert(request: DoclingConvertRequest): Promise<DoclingConvertResponse> {
      calls.push(request.filename);
      if (failFilenames.has(request.filename)) {
        throw new DoclingServiceError('http://host:8030/v1/convert/file', 'boom', { status: 500 });
      }
      const md = markdownByFilename[request.filename] ?? '# default';
      return {
        document: {
          schemaVersion: 'DoclingDocument',
          name: request.filename,
          content: { md_content: md },
        },
      };
    },
  } as unknown as DoclingClient;
  return { client, calls };
}

describe('deriveDocSlug', () => {
  it('kebab-cases a nested relative path so siblings do not collide', () => {
    const root = join('proj', 'src');
    expect(deriveDocSlug(root, join(root, 'guides', 'intro.pdf'))).toBe('guides-intro');
    expect(deriveDocSlug(root, join(root, 'refs', 'intro.pdf'))).toBe('refs-intro');
  });

  it('falls back to the basename when the path is outside the source root', () => {
    expect(deriveDocSlug(join('proj', 'src'), join('elsewhere', 'report.docx'))).toBe('report');
  });
});

describe('detectMime', () => {
  it('maps known rich formats and defaults to octet-stream', () => {
    expect(detectMime('a.pdf')).toBe('application/pdf');
    expect(detectMime('a.docx')).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(detectMime('a.unknown')).toBe('application/octet-stream');
  });
});

describe('convertSources', () => {
  let root: string;
  let stateDir: string;
  let sourceDir: string;
  let state: StateManager;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'doc-convert-'));
    stateDir = join(root, 'state');
    sourceDir = join(root, 'sources');
    await mkdir(stateDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    state = new StateManager(stateDir);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function seedSources(list: IndexSourceList): Promise<void> {
    await state.saveSourceList(list);
    for (const s of list.sources) {
      await writeFile(s.path, 'raw bytes', 'utf-8');
    }
  }

  function baseList(): IndexSourceList {
    return { version: '1.0.0', repositoryId: 'repo-1', sources: [] };
  }

  it('converts a needs-conversion source, writes the derived file, and flips status to pending', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    const { client, calls } = fakeClient({ 'doc.pdf': '# Converted' });

    const deps: DocumentConverterDeps = { state, doclingClient: client, sourceRoot: sourceDir };
    const summary = await convertSources(deps);

    expect(summary.converted).toBe(1);
    expect(summary.failed).toBe(0);
    expect(calls).toEqual(['doc.pdf']);

    const updated = await state.getSourceList();
    const source = updated!.sources[0]!;
    expect(source.status).toBe('pending');
    expect(source.derivedTextPath).toBeDefined();

    const written = await readFile(source.derivedTextPath!, 'utf-8');
    expect(written).toBe('# Converted');
  });

  it('skips sources that do not need conversion', async () => {
    const mdPath = join(sourceDir, 'notes.md');
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [
        { path: mdPath, type: 'general', status: 'pending' },
        { path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
      ],
    });
    const { client, calls } = fakeClient({ 'doc.pdf': '# ok' });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir });

    expect(summary.converted).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(calls).toEqual(['doc.pdf']);
  });

  it('isolates a failing source: it is returned to needs-conversion with lastError, the batch continues', async () => {
    const goodPath = join(sourceDir, 'good.pdf');
    const badPath = join(sourceDir, 'bad.pdf');
    await seedSources({
      ...baseList(),
      sources: [
        { path: badPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
        { path: goodPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
      ],
    });
    const { client } = fakeClient({ 'good.pdf': '# good' }, new Set(['bad.pdf']));

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir });

    expect(summary.converted).toBe(1);
    expect(summary.failed).toBe(1);

    const updated = await state.getSourceList();
    const bad = updated!.sources.find((s) => s.path === badPath)!;
    const good = updated!.sources.find((s) => s.path === goodPath)!;
    expect(bad.status).toBe('needs-conversion');
    expect(bad.lastError).toContain('boom');
    expect(good.status).toBe('pending');
    expect(good.derivedTextPath).toBeDefined();
  });

  it('honours maxItems', async () => {
    const a = join(sourceDir, 'a.pdf');
    const b = join(sourceDir, 'b.pdf');
    await seedSources({
      ...baseList(),
      sources: [
        { path: a, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
        { path: b, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
      ],
    });
    const { client, calls } = fakeClient({ 'a.pdf': '# a', 'b.pdf': '# b' });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, { maxItems: 1 });

    expect(summary.converted).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('short-circuits when a stop is requested before processing', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    await state.requestStop();
    const { client, calls } = fakeClient({ 'doc.pdf': '# never' });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir });

    expect(summary.stoppedEarly).toBe(true);
    expect(summary.converted).toBe(0);
    expect(calls).toHaveLength(0);
    // The stop signal is consumed by the run that observed it.
    expect(await state.isStopRequested()).toBe(false);
  });
});
