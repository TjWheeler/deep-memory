import { describe, expect, it } from 'vitest';
import { extractDoclingDiagnostics, summarize } from './ConversionReport.js';
import type { ConversionReportEntry } from './ConversionReport.js';
import type { DoclingDocument } from './types.js';

function entry(overrides: Partial<ConversionReportEntry>): ConversionReportEntry {
  return {
    path: '/src/doc.pdf',
    docSlug: 'doc',
    status: 'converted',
    mode: 'sync',
    doOcr: false,
    ocrFallbackApplied: false,
    warnings: [],
    durationMs: 100,
    sourceHash: 'abc',
    ...overrides,
  };
}

function doc(content: Record<string, unknown>): DoclingDocument {
  return { schemaVersion: 'DoclingDocument', name: 'doc', content };
}

describe('summarize', () => {
  it('rolls up counts, tables, duration, and OCR fallbacks across entries', () => {
    const summary = summarize([
      entry({ status: 'converted', tableCount: 3, durationMs: 200, ocrFallbackApplied: true }),
      entry({ status: 'converted', tableCount: 1, durationMs: 50 }),
      entry({ status: 'skipped-unchanged', durationMs: 5 }),
      entry({ status: 'failed', durationMs: 10 }),
    ]);

    expect(summary.converted).toBe(2);
    expect(summary.skippedUnchanged).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.totalTables).toBe(4);
    expect(summary.totalDurationMs).toBe(265);
    expect(summary.ocrFallbacks).toBe(1);
  });

  it('returns a zeroed summary for no entries', () => {
    expect(summarize([])).toEqual({
      converted: 0,
      skippedUnchanged: 0,
      failed: 0,
      totalTables: 0,
      totalDurationMs: 0,
      ocrFallbacks: 0,
    });
  });
});

describe('extractDoclingDiagnostics', () => {
  // The structural data lives inside the envelope's `json_content`, not at the
  // envelope root. Pages arrive as an object map keyed by page; tables as an
  // array. `json_content` may be an embedded object or a stringified payload.
  it('reads page and table counts from an embedded json_content object', () => {
    const diagnostics = extractDoclingDiagnostics(
      doc({
        md_content: '# hi',
        json_content: {
          pages: { '1': {}, '2': {}, '3': {} }, // object map — 3 pages
          tables: [{ data: {} }, { data: {} }], // array — 2 tables
        },
      }),
    );

    expect(diagnostics.pageCount).toBe(3);
    expect(diagnostics.tableCount).toBe(2);
    expect(diagnostics.warnings).toEqual([]);
  });

  it('reads page and table counts from a stringified json_content payload', () => {
    const diagnostics = extractDoclingDiagnostics(
      doc({
        md_content: '# hi',
        json_content: JSON.stringify({
          pages: { '1': {}, '2': {} },
          tables: [{ data: {} }],
        }),
      }),
    );
    expect(diagnostics.pageCount).toBe(2);
    expect(diagnostics.tableCount).toBe(1);
  });

  it('returns undefined counts for an envelope with no json_content', () => {
    const diagnostics = extractDoclingDiagnostics(doc({ md_content: '# hi' }));
    expect(diagnostics.pageCount).toBeUndefined();
    expect(diagnostics.tableCount).toBeUndefined();
    expect(diagnostics.warnings).toEqual([]);
  });

  it('returns undefined counts when json_content lacks pages/tables', () => {
    const diagnostics = extractDoclingDiagnostics(
      doc({ json_content: { schema_name: 'DoclingDocument', body: {} } }),
    );
    expect(diagnostics.pageCount).toBeUndefined();
    expect(diagnostics.tableCount).toBeUndefined();
  });

  it('tolerates a malformed json_content string without throwing', () => {
    const diagnostics = extractDoclingDiagnostics(doc({ json_content: 'not valid json {' }));
    expect(diagnostics.pageCount).toBeUndefined();
    expect(diagnostics.tableCount).toBeUndefined();
    expect(diagnostics.warnings).toEqual([]);
  });

  it('tolerates pages/tables of the wrong shape inside json_content', () => {
    const diagnostics = extractDoclingDiagnostics(
      doc({ json_content: { pages: 'not-a-collection', tables: 42 } }),
    );
    expect(diagnostics.pageCount).toBeUndefined();
    expect(diagnostics.tableCount).toBeUndefined();
  });
});
