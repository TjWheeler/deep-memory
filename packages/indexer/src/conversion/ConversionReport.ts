/**
 * Conversion report — the diagnostic trail the convert step leaves behind.
 *
 * Each converted (or skipped) source contributes a `ConversionReportEntry`;
 * `summarize` folds them into a compact `summary`. The report is persisted to
 * the state dir by the converter and read by the status/diagnose tools, so a
 * bad conversion (little text, dropped tables, pathological timing) is visible
 * without leaving the tool surface.
 *
 * The helpers here are pure. No timestamps are taken inside the library — the
 * caller stamps `generatedAt` — and `extractDoclingDiagnostics` never throws on
 * a malformed payload, because `DoclingDocument.content` is deliberately
 * opaque and may drift across docling-serve schema versions.
 */

import type { DoclingDocument } from './types.js';

/** Outcome of converting a single source. */
export interface ConversionReportEntry {
  /** Absolute source path that was processed. */
  path: string;
  /** Slug used for the derived filenames. */
  docSlug: string;
  /** How the source resolved this run. */
  status: 'converted' | 'skipped-unchanged' | 'failed';
  /** Which client path produced the document. */
  mode: 'sync' | 'async';
  /** The OCR decision applied to the final (successful) conversion. */
  doOcr: boolean;
  /** True when a low-yield first pass triggered a second OCR pass. */
  ocrFallbackApplied: boolean;
  /** Page count read from the converted document, when the envelope carried one. */
  pageCount?: number;
  /** Table count read from the converted document, when the envelope carried tables. */
  tableCount?: number;
  /** Warnings lifted from the envelope plus any recorded by the converter. */
  warnings: string[];
  /** Wall-clock time spent converting this source, in milliseconds. */
  durationMs: number;
  /** sha256 of the raw source bytes at conversion time. */
  sourceHash: string;
}

/** Aggregate view of a conversion run. */
export interface ConversionReport {
  /** ISO timestamp stamped by the caller when the report is persisted. */
  generatedAt: string;
  /** One entry per source touched this run. */
  entries: ConversionReportEntry[];
  /** Rolled-up counts across all entries. */
  summary: {
    converted: number;
    skippedUnchanged: number;
    failed: number;
    totalTables: number;
    totalDurationMs: number;
    ocrFallbacks: number;
  };
}

/**
 * Fold a set of entries into the report summary. Pure — the caller stamps
 * `generatedAt` and assembles the full `ConversionReport`.
 */
export function summarize(entries: ConversionReportEntry[]): ConversionReport['summary'] {
  const summary = {
    converted: 0,
    skippedUnchanged: 0,
    failed: 0,
    totalTables: 0,
    totalDurationMs: 0,
    ocrFallbacks: 0,
  };
  for (const entry of entries) {
    if (entry.status === 'converted') summary.converted += 1;
    else if (entry.status === 'skipped-unchanged') summary.skippedUnchanged += 1;
    else summary.failed += 1;

    summary.totalTables += entry.tableCount ?? 0;
    summary.totalDurationMs += entry.durationMs;
    if (entry.ocrFallbackApplied) summary.ocrFallbacks += 1;
  }
  return summary;
}

/** Diagnostics lifted from a converted document's opaque payload. */
export interface DoclingDiagnostics {
  /** Number of pages, when the payload carried a page list. */
  pageCount?: number;
  /** Number of tables recovered, when the payload carried a table list. */
  tableCount?: number;
  /** Any conversion warnings/errors the envelope reported. */
  warnings: string[];
}

/**
 * Read structural diagnostics out of a converted document.
 *
 * `DoclingDocument.content` is the raw docling-serve `document` envelope, kept
 * opaque so the client is not coupled to a schema version. Its root carries the
 * rendered outputs (`md_content`, `json_content`, …); the structural data lives
 * one level down, inside `json_content`: `json_content.pages` (an object map
 * keyed by page) and `json_content.tables` (an array). `json_content` may be
 * an embedded object or a stringified JSON payload, depending on how the client
 * received it.
 *
 * This reader is the one place that peeks inside the envelope, and it does so
 * defensively: it resolves `json_content` tolerantly (object, parseable string,
 * or absent), counts pages/tables from it, and never throws. A missing or
 * wrong-shaped payload yields `undefined`/`[]` so a schema drift degrades
 * diagnostics rather than failing a conversion. The envelope's `errors`/`status`
 * are siblings of `document` and therefore not present in `content`, so this
 * source contributes no warnings — the converter adds its own.
 */
export function extractDoclingDiagnostics(doc: DoclingDocument): DoclingDiagnostics {
  const diagnostics: DoclingDiagnostics = { warnings: [] };

  const jsonContent = resolveRecord(doc.content['json_content']);
  if (jsonContent !== undefined) {
    const pageCount = countable(jsonContent['pages']);
    if (pageCount !== undefined) diagnostics.pageCount = pageCount;

    const tableCount = countable(jsonContent['tables']);
    if (tableCount !== undefined) diagnostics.tableCount = tableCount;
  }

  return diagnostics;
}

/**
 * Resolve a value that may be an embedded object or a stringified JSON object
 * into a record. Tolerant by contract: a non-object, a non-string, or an
 * unparseable string yields `undefined` rather than throwing — diagnostics must
 * never fail a conversion.
 */
function resolveRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Count the members of a docling collection that may be an array or an
 * object-keyed map (pages arrive as a map, tables as an array). Returns
 * `undefined` when the value is neither, so an absent key does not masquerade
 * as a zero count.
 */
function countable(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (isRecord(value)) return Object.keys(value).length;
  return undefined;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
