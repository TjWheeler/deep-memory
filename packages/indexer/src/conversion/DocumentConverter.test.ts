import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { convertSources, deriveDocSlug, detectMime, decideOcr, type DocumentConverterDeps, type DocumentConverterOptions } from './DocumentConverter.js';
import { DoclingServiceError } from './errors.js';
import type { DoclingClient } from './DoclingClient.js';
import type { ConvertViaAsyncOptions, DoclingConvertOptions, DoclingConvertRequest, DoclingConvertResponse, PollDecision } from './types.js';
import type { ConversionReport } from './ConversionReport.js';
import { StateManager } from '../orchestrator/StateManager.js';
import type { IndexSource, IndexSourceList } from '../types/source-list.js';

// ── Fake client ──────────────────────────────────────────────────────────────

interface FakeDoc {
  /** Markdown text returned for `to_formats=md`. */
  md: string;
  /** Page count reported in the structural JSON (drives the OCR heuristic). */
  pages?: number;
  /** Table count reported in the structural JSON. */
  tables?: number;
}

interface FakeCall {
  filename: string;
  format: string;
  doOcr: boolean | undefined;
  mode: 'sync' | 'async';
  convertOptions: DoclingConvertOptions | undefined;
}

/**
 * A DoclingClient stand-in. `docs` maps a filename to the document it yields;
 * `ocrDocs` optionally overrides the response for the OCR (second) pass so a
 * low-yield first pass followed by a rich OCR pass can be scripted. `fail`
 * lists filenames that throw. Records every call with its format/OCR/mode so
 * tests can assert the paired md+json calls and the sync/async choice.
 */
function fakeClient(opts: {
  docs: Record<string, FakeDoc>;
  ocrDocs?: Record<string, FakeDoc>;
  fail?: Set<string>;
  onAsyncPoll?: (filename: string) => Array<{ taskStatus: 'pending' | 'started' | 'success' | 'failure'; taskPosition?: number }>;
  /** Awaited before each poll step, so a test can deterministically arm state (e.g. a stop). */
  beforePoll?: (filename: string, index: number) => Promise<void>;
}): { client: DoclingClient; calls: FakeCall[] } {
  const calls: FakeCall[] = [];
  const fail = opts.fail ?? new Set<string>();

  function respond(request: DoclingConvertRequest, mode: 'sync' | 'async'): DoclingConvertResponse {
    calls.push({ filename: request.filename, format: request.toFormat ?? 'md', doOcr: request.doOcr, mode, convertOptions: request.convertOptions });
    if (fail.has(request.filename)) {
      throw new DoclingServiceError('http://host:8030/v1/convert/file', 'boom', { status: 500 });
    }
    const useOcr = request.doOcr === true && opts.ocrDocs?.[request.filename] !== undefined;
    const doc = (useOcr ? opts.ocrDocs![request.filename] : opts.docs[request.filename]) ?? { md: '# default' };
    // The real docling envelope nests structural data inside json_content:
    // pages as an object map keyed by page, tables as an array. Only attach
    // json_content when the fixture carries page/table data, so the
    // "no page data" case has genuinely-absent structure.
    const content: Record<string, unknown> = { md_content: doc.md };
    if (doc.pages !== undefined || doc.tables !== undefined) {
      const jsonContent: Record<string, unknown> = {};
      if (doc.pages !== undefined) {
        jsonContent['pages'] = Object.fromEntries(
          Array.from({ length: doc.pages }, (_, i) => [String(i + 1), { page_no: i + 1 }]),
        );
      }
      if (doc.tables !== undefined) {
        jsonContent['tables'] = Array.from({ length: doc.tables }, () => ({ data: {} }));
      }
      content['json_content'] = jsonContent;
    }
    return { document: { schemaVersion: 'DoclingDocument', name: request.filename, content } };
  }

  const client = {
    async postConvert(request: DoclingConvertRequest): Promise<DoclingConvertResponse> {
      return respond(request, 'sync');
    },
    async convertViaAsync(
      request: DoclingConvertRequest,
      asyncOpts: ConvertViaAsyncOptions = {},
    ): Promise<DoclingConvertResponse> {
      // Drive the poll callback with a scripted status sequence so the
      // converter's progress-writing and stop handling are exercised.
      const sequence = opts.onAsyncPoll?.(request.filename) ?? [{ taskStatus: 'success' as const }];
      for (let index = 0; index < sequence.length; index++) {
        const step = sequence[index]!;
        await opts.beforePoll?.(request.filename, index);
        const decision: PollDecision | void = await asyncOpts.onPoll?.({
          taskId: `task-${request.filename}`,
          taskStatus: step.taskStatus,
          ...(step.taskPosition !== undefined ? { taskPosition: step.taskPosition } : {}),
        });
        if (decision === 'stop') {
          throw new DoclingServiceError('http://host:8030/v1/status/poll/task', 'conversion stopped before completion');
        }
      }
      return respond(request, 'async');
    },
  } as unknown as DoclingClient;

  return { client, calls };
}

const SYNC: DocumentConverterOptions = { mode: 'sync' };

// ── deriveDocSlug / detectMime / decideOcr ────────────────────────────────────

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

describe('decideOcr', () => {
  function src(path: string, doOcr?: boolean): IndexSource {
    return { path, type: 'general', status: 'needs-conversion', originalFormat: '.pdf', ...(doOcr !== undefined ? { doOcr } : {}) };
  }

  it('honours a per-source override above everything', () => {
    expect(decideOcr(src('a.pdf', true), { mode: 'sync', doOcr: false })).toEqual({ doOcr: true, heuristic: false });
  });

  it('honours the global option when no per-source override', () => {
    expect(decideOcr(src('a.pdf'), { mode: 'sync', doOcr: true })).toEqual({ doOcr: true, heuristic: false });
  });

  it('never runs OCR on native-text formats', () => {
    const docx: IndexSource = { path: 'a.docx', type: 'general', status: 'needs-conversion', originalFormat: '.docx' };
    expect(decideOcr(docx, { mode: 'sync' })).toEqual({ doOcr: false, heuristic: false });
  });

  it('leaves a PDF with no explicit decision to the heuristic', () => {
    expect(decideOcr(src('a.pdf'), { mode: 'sync' })).toEqual({ doOcr: false, heuristic: true });
  });
});

// ── convertSources ────────────────────────────────────────────────────────────

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

  async function seedSources(list: IndexSourceList, bytesByPath: Record<string, string> = {}): Promise<void> {
    await state.saveSourceList(list);
    for (const s of list.sources) {
      await writeFile(s.path, bytesByPath[s.path] ?? 'raw bytes', 'utf-8');
    }
  }

  function baseList(): IndexSourceList {
    return { version: '1.0.0', repositoryId: 'repo-1', sources: [] };
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  }

  it('converts a source, writes both the Markdown and the JSON sidecar, and flips status to pending', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    // Enough text per page that the OCR heuristic does not fire, so this is a
    // single conversion pass yielding one md + one json call.
    const md = `# Converted\n\n${'x'.repeat(300)}`;
    const { client, calls } = fakeClient({ docs: { 'doc.pdf': { md, pages: 2, tables: 1 } } });

    const deps: DocumentConverterDeps = { state, doclingClient: client, sourceRoot: sourceDir };
    const summary = await convertSources(deps, SYNC);

    expect(summary.converted).toBe(1);
    expect(summary.failed).toBe(0);
    // Both formats requested; the client cache makes the pair cheap in production.
    expect(calls.map((c) => c.format).sort()).toEqual(['json', 'md']);

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('pending');
    expect(source.derivedTextPath).toBeDefined();
    expect(source.derivedDoclingJsonPath).toBeDefined();
    expect(source.sourceHash).toMatch(/^[0-9a-f]{64}$/);
    expect(source.conversion?.pageCount).toBe(2);
    expect(source.conversion?.tableCount).toBe(1);

    expect(await readFile(source.derivedTextPath!, 'utf-8')).toBe(md);
    expect(await exists(source.derivedDoclingJsonPath!)).toBe(true);
  });

  it('skips an unchanged source on a re-run without any client call', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });

    const first = fakeClient({ docs: { 'doc.pdf': { md: '# once', pages: 1, tables: 2 } } });
    await convertSources({ state, doclingClient: first.client, sourceRoot: sourceDir }, SYNC);

    // Re-mark as needs-conversion (as prepare/resume would) and re-run.
    await state.updateSource(pdfPath, { status: 'needs-conversion' });
    const second = fakeClient({ docs: { 'doc.pdf': { md: '# twice' } } });
    const summary = await convertSources({ state, doclingClient: second.client, sourceRoot: sourceDir }, SYNC);

    expect(second.calls).toHaveLength(0);
    expect(summary.converted).toBe(0);
    expect(summary.skipped).toBe(1);

    const report = (await state.getConversionReport<ConversionReport>())!;
    const skip = report.entries.find((e) => e.status === 'skipped-unchanged')!;
    expect(skip).toBeDefined();
    // The skip reports the historical conversion (from the persisted mirror),
    // not the current decision: '# once' over 1 page tripped the OCR fallback.
    expect(skip.doOcr).toBe(true);
    expect(skip.ocrFallbackApplied).toBe(true);
    expect(skip.tableCount).toBe(2);

    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('pending');
  });

  it('reconverts a changed source and deletes the stale derived files first', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources(
      { ...baseList(), sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }] },
      { [pdfPath]: 'original bytes' },
    );

    const first = fakeClient({ docs: { 'doc.pdf': { md: '# original', pages: 1 } } });
    await convertSources({ state, doclingClient: first.client, sourceRoot: sourceDir }, SYNC);
    const before = (await state.getSourceList())!.sources[0]!;
    const stalePath = before.derivedTextPath!;
    expect(await readFile(stalePath, 'utf-8')).toBe('# original');

    // Change the source bytes and re-run.
    await writeFile(pdfPath, 'edited bytes', 'utf-8');
    await state.updateSource(pdfPath, { status: 'needs-conversion' });
    const second = fakeClient({ docs: { 'doc.pdf': { md: '# rewritten', pages: 1 } } });
    const summary = await convertSources({ state, doclingClient: second.client, sourceRoot: sourceDir }, SYNC);

    expect(summary.converted).toBe(1);
    expect(second.calls.length).toBeGreaterThan(0);
    const after = (await state.getSourceList())!.sources[0]!;
    expect(await readFile(after.derivedTextPath!, 'utf-8')).toBe('# rewritten');
    expect(after.sourceHash).not.toBe(before.sourceHash);
  });

  it('reconverts when only the per-source convert options change, with unchanged bytes', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources(
      { ...baseList(), sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }] },
      { [pdfPath]: 'stable bytes' },
    );

    const md = `# original\n\n${'x'.repeat(300)}`;
    const first = fakeClient({ docs: { 'doc.pdf': { md, pages: 1 } } });
    await convertSources({ state, doclingClient: first.client, sourceRoot: sourceDir }, SYNC);
    const before = (await state.getSourceList())!.sources[0]!;
    expect(before.convertOptionsUsed).toBeUndefined();

    // Same bytes, but set a per-source convert option and re-run: the derived
    // text depends on the options, so this must reconvert, not skip.
    await state.updateSource(pdfPath, { status: 'needs-conversion', sourceConvertOptions: { tableCellMatching: false } });
    const reconverted = `# reconverted\n\n${'y'.repeat(300)}`;
    const second = fakeClient({ docs: { 'doc.pdf': { md: reconverted, pages: 1 } } });
    const summary = await convertSources({ state, doclingClient: second.client, sourceRoot: sourceDir }, SYNC);

    expect(summary.converted).toBe(1);
    expect(summary.skipped).toBe(0);
    expect(second.calls.length).toBeGreaterThan(0);
    const after = (await state.getSourceList())!.sources[0]!;
    expect(after.status).toBe('pending');
    expect(await readFile(after.derivedTextPath!, 'utf-8')).toBe(reconverted);
    // The effective options used are recorded so the next run is options-aware.
    expect(after.convertOptionsUsed).toEqual({ tableCellMatching: false });
    // Bytes were unchanged, so the hash is stable across the option-driven reconvert.
    expect(after.sourceHash).toBe(before.sourceHash);
  });

  it('skips when both the bytes and the per-source convert options are unchanged', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{
        path: pdfPath,
        type: 'general',
        status: 'needs-conversion',
        originalFormat: '.pdf',
        sourceConvertOptions: { tableCellMatching: false },
      }],
    });

    const md = `# once\n\n${'x'.repeat(300)}`;
    const first = fakeClient({ docs: { 'doc.pdf': { md, pages: 1 } } });
    await convertSources({ state, doclingClient: first.client, sourceRoot: sourceDir }, SYNC);
    const afterFirst = (await state.getSourceList())!.sources[0]!;
    expect(afterFirst.convertOptionsUsed).toEqual({ tableCellMatching: false });

    // Re-mark as needs-conversion (as resume would) with the same option and
    // re-run: identical bytes and identical options must skip the round trip.
    await state.updateSource(pdfPath, { status: 'needs-conversion' });
    const second = fakeClient({ docs: { 'doc.pdf': { md: '# twice' } } });
    const summary = await convertSources({ state, doclingClient: second.client, sourceRoot: sourceDir }, SYNC);

    expect(second.calls).toHaveLength(0);
    expect(summary.converted).toBe(0);
    expect(summary.skipped).toBe(1);
    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('pending');
  });

  it('skips an option-less source whose recorded options are absent (empty matches undefined)', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });

    const md = `# once\n\n${'x'.repeat(300)}`;
    const first = fakeClient({ docs: { 'doc.pdf': { md, pages: 1 } } });
    await convertSources({ state, doclingClient: first.client, sourceRoot: sourceDir }, SYNC);
    const afterFirst = (await state.getSourceList())!.sources[0]!;
    // No options were used, so nothing is recorded on the entry.
    expect(afterFirst.convertOptionsUsed).toBeUndefined();

    // Re-mark and re-run with still no options: the effective empty option set
    // matches the absent recorded set, so the source is skipped — an existing
    // corpus is not forced to reconvert by this feature.
    await state.updateSource(pdfPath, { status: 'needs-conversion' });
    const second = fakeClient({ docs: { 'doc.pdf': { md: '# twice' } } });
    const summary = await convertSources({ state, doclingClient: second.client, sourceRoot: sourceDir }, SYNC);

    expect(second.calls).toHaveLength(0);
    expect(summary.converted).toBe(0);
    expect(summary.skipped).toBe(1);
  });

  it('lets a per-source override beat the process-wide default per field in the request options', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{
        path: pdfPath,
        type: 'general',
        status: 'needs-conversion',
        originalFormat: '.pdf',
        sourceConvertOptions: { tableCellMatching: false },
      }],
    });
    const md = `# doc\n\n${'x'.repeat(300)}`;
    const { client, calls } = fakeClient({ docs: { 'doc.pdf': { md, pages: 1 } } });

    const summary = await convertSources(
      { state, doclingClient: client, sourceRoot: sourceDir },
      { mode: 'sync', convertOptions: { tableCellMatching: true, tableMode: 'accurate' } },
    );

    expect(summary.converted).toBe(1);
    expect(calls.length).toBeGreaterThan(0);
    // Per-source tableCellMatching:false wins over the process default true;
    // the process-wide tableMode:accurate carries through since the source did
    // not override it. Both export passes see the identical merged options.
    for (const call of calls) {
      expect(call.convertOptions).toEqual({ tableCellMatching: false, tableMode: 'accurate' });
    }
    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.convertOptionsUsed).toEqual({ tableCellMatching: false, tableMode: 'accurate' });
  });

  it('drives submit/poll/fetch through the async client and writes progress', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    const { client, calls } = fakeClient({
      docs: { 'doc.pdf': { md: '# async', pages: 1 } },
      onAsyncPoll: () => [
        { taskStatus: 'pending', taskPosition: 2 },
        { taskStatus: 'started' },
        { taskStatus: 'success' },
      ],
    });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, { mode: 'async' });

    expect(summary.converted).toBe(1);
    expect(calls.every((c) => c.mode === 'async')).toBe(true);
    const source = (await state.getSourceList())!.sources[0]!;
    expect(source.status).toBe('pending');
    // Progress files are cleaned up on completion.
    expect(await state.getActiveConversionProgress()).toHaveLength(0);
  });

  it('short-circuits mid-poll on a stop signal and persists a partial report', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    // The run starts with no stop armed (so the loop-top guard passes and the
    // conversion begins). Before the second poll the fake deterministically
    // arms the stop, so that poll observes it and returns the stop sentinel —
    // exercising the mid-poll short-circuit, not the pre-run guard.
    const client = fakeClient({
      docs: { 'doc.pdf': { md: '# never', pages: 1 } },
      onAsyncPoll: () => [{ taskStatus: 'started' }, { taskStatus: 'success' }],
      beforePoll: async (_filename, index) => {
        if (index === 1) await state.requestStop();
      },
    }).client;

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, { mode: 'async' });

    expect(summary.stoppedEarly).toBe(true);
    expect(summary.converted).toBe(0);
    expect(summary.failed).toBe(0);
    const source = (await state.getSourceList())!.sources[0]!;
    // Left mid-flight for resetConvertingSources to recover — not a failure.
    expect(source.status).toBe('converting');
    expect(source.lastError).toBeUndefined();
    // A partial report was still written.
    expect(await state.getConversionReport<ConversionReport>()).not.toBeNull();
  });

  it('fires the OCR fallback on a low-yield PDF and not on a healthy one', async () => {
    const lowPath = join(sourceDir, 'scanned.pdf');
    const richPath = join(sourceDir, 'born-digital.pdf');
    await seedSources({
      ...baseList(),
      sources: [
        { path: lowPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
        { path: richPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
      ],
    });
    const { client, calls } = fakeClient({
      docs: {
        // 5 chars over 2 pages = 2.5 chars/page, well below the threshold.
        'scanned.pdf': { md: 'a b c', pages: 2 },
        // Plenty of text per page.
        'born-digital.pdf': { md: 'x'.repeat(500), pages: 1 },
      },
      ocrDocs: {
        'scanned.pdf': { md: 'the OCR-recovered text is much longer', pages: 2 },
      },
    });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, { mode: 'sync', ocrTextYieldThreshold: 100 });

    expect(summary.converted).toBe(2);
    const report = (await state.getConversionReport<ConversionReport>())!;
    const scanned = report.entries.find((e) => e.path === lowPath)!;
    const born = report.entries.find((e) => e.path === richPath)!;
    expect(scanned.ocrFallbackApplied).toBe(true);
    expect(scanned.doOcr).toBe(true);
    expect(born.ocrFallbackApplied).toBe(false);
    expect(born.doOcr).toBe(false);

    // The scanned doc ran a no-OCR pass (md+json) then an OCR pass (md+json).
    const scannedOcrCalls = calls.filter((c) => c.filename === 'scanned.pdf' && c.doOcr === true);
    expect(scannedOcrCalls.length).toBe(2);
    // The OCR-recovered text is what got written.
    const source = (await state.getSourceList())!.sources.find((s) => s.path === lowPath)!;
    expect(await readFile(source.derivedTextPath!, 'utf-8')).toBe('the OCR-recovered text is much longer');
  });

  it('does not fire the OCR fallback when the document reports no page count, and records a warning', async () => {
    const pdfPath = join(sourceDir, 'no-pages.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    const { client, calls } = fakeClient({
      docs: { 'no-pages.pdf': { md: 'tiny' } }, // no pages → heuristic must not fire
      ocrDocs: { 'no-pages.pdf': { md: 'SHOULD NOT BE USED', pages: 2 } },
    });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, SYNC);

    expect(summary.converted).toBe(1);
    // No OCR pass — only the initial no-OCR md+json calls.
    expect(calls.every((c) => c.doOcr === false)).toBe(true);
    const report = (await state.getConversionReport<ConversionReport>())!;
    const entry = report.entries[0]!;
    expect(entry.ocrFallbackApplied).toBe(false);
    expect(entry.warnings.some((w) => /no page count/i.test(w))).toBe(true);
  });

  it('isolates a failing source: returned to needs-conversion with lastError, the batch continues', async () => {
    const goodPath = join(sourceDir, 'good.pdf');
    const badPath = join(sourceDir, 'bad.pdf');
    await seedSources({
      ...baseList(),
      sources: [
        { path: badPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
        { path: goodPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' },
      ],
    });
    const { client } = fakeClient({ docs: { 'good.pdf': { md: '# good', pages: 1 } }, fail: new Set(['bad.pdf']) });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, SYNC);

    expect(summary.converted).toBe(1);
    expect(summary.failed).toBe(1);
    const updated = await state.getSourceList();
    const bad = updated!.sources.find((s) => s.path === badPath)!;
    const good = updated!.sources.find((s) => s.path === goodPath)!;
    expect(bad.status).toBe('needs-conversion');
    // The full operator-facing detail (including the service URL) stays on the
    // source entry's lastError.
    expect(bad.lastError).toContain('boom');
    expect(bad.lastError).toContain('http://host:8030');
    expect(good.status).toBe('pending');

    // The report warning is caller-safe: the failure class, no service URL,
    // because the diagnose tool surfaces report warnings verbatim.
    const report = (await state.getConversionReport<ConversionReport>())!;
    const failedEntry = report.entries.find((e) => e.path === badPath)!;
    expect(failedEntry.status).toBe('failed');
    expect(failedEntry.warnings).toEqual(['conversion failed (HTTP 500)']);
    expect(failedEntry.warnings.join(' ')).not.toContain('http://');
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
    const { client, calls } = fakeClient({ docs: { 'a.pdf': { md: '# a', pages: 1 }, 'b.pdf': { md: '# b', pages: 1 } } });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, { mode: 'sync', maxItems: 1 });

    expect(summary.converted).toBe(1);
    const filenames = new Set(calls.map((c) => c.filename));
    expect(filenames.size).toBe(1);
  });

  it('short-circuits when a stop is requested before processing (sync)', async () => {
    const pdfPath = join(sourceDir, 'doc.pdf');
    await seedSources({
      ...baseList(),
      sources: [{ path: pdfPath, type: 'general', status: 'needs-conversion', originalFormat: '.pdf' }],
    });
    await state.requestStop();
    const { client, calls } = fakeClient({ docs: { 'doc.pdf': { md: '# never' } } });

    const summary = await convertSources({ state, doclingClient: client, sourceRoot: sourceDir }, SYNC);

    expect(summary.stoppedEarly).toBe(true);
    expect(summary.converted).toBe(0);
    expect(calls).toHaveLength(0);
    expect(await state.isStopRequested()).toBe(false);
  });
});
