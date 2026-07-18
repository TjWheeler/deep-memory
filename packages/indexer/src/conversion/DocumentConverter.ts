/**
 * DocumentConverter — turns rich-format sources into derived text before
 * extraction, idempotently and with a diagnostic trail.
 *
 * Pipeline (per source with status `needs-conversion`):
 *   1) Read the source bytes and hash them.
 *   2) If the stored hash matches and both derived files still exist, skip the
 *      round trip — the source is unchanged.
 *   3) Otherwise convert to Markdown *and* structural JSON (the JSON sidecar is
 *      the substrate for later structure-aware extraction), deciding OCR per
 *      document, then write `state/converted/{docSlug}.md` +
 *      `{docSlug}.docling.json`.
 *   4) Record the derived paths, source hash, and compact diagnostics on the
 *      entry and flip status to `pending` so extraction consumes the text.
 *
 * Conversion may run synchronously (one request stays open) or asynchronously
 * (submit + poll + fetch, which survives the server-side sync-wait ceiling that
 * large documents hit). One bad source must not abort the batch — an exception
 * returns that source to `needs-conversion` with a `lastError` and the loop
 * continues. A stop signal short-circuits the loop and still leaves a partial
 * report on disk.
 */

import { readFile, writeFile, mkdir, unlink, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, relative, isAbsolute } from 'node:path';
import { InvalidInputError } from '@utaba/deep-memory';

import { DoclingServiceError } from './errors.js';
import { matchesSourceFilter } from './source-filter.js';
import { extractDoclingDiagnostics, summarize } from './ConversionReport.js';
import type { ConversionReport, ConversionReportEntry } from './ConversionReport.js';
import type { ConversionProgress } from './ConversionProgress.js';
import type { DoclingClient } from './DoclingClient.js';
import type { DoclingConvertOptions, DoclingConvertResponse, PollDecision } from './types.js';
import type { StateManager } from '../orchestrator/StateManager.js';
import type { IndexSource } from '../types/source-list.js';

/** Subdirectory under the state dir where derived files are written. */
const CONVERTED_DIR = 'converted';

/** Default chars-per-page floor below which a PDF is reconverted with OCR. */
const DEFAULT_OCR_TEXT_YIELD_THRESHOLD = 100;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

/** Formats that carry text natively and therefore never need OCR. */
const NATIVE_TEXT_FORMATS = new Set(['.docx', '.html', '.htm', '.pptx']);

export interface DocumentConverterOptions {
  /** Filter to a subset of sources by `path`. */
  sourceFilter?: string[];
  /** Hard cap on the number of sources to process this run. */
  maxItems?: number;
  /**
   * Global OCR decision. When set it disables the per-source heuristic; a
   * per-source `source.doOcr` still takes precedence over it.
   */
  doOcr?: boolean;
  /** Submit conversions synchronously or via the async submit/poll/fetch protocol. */
  mode: 'sync' | 'async';
  /** Chars-per-page floor below which a PDF is reconverted with OCR. */
  ocrTextYieldThreshold?: number;
  /**
   * Process-wide default conversion options. A per-source
   * `source.sourceConvertOptions` override takes precedence over these for that
   * source. When neither is set, docling's own defaults apply.
   */
  convertOptions?: DoclingConvertOptions;
}

export interface DocumentConverterDeps {
  /** State manager bound to the process's `state/` directory. */
  state: StateManager;
  /** Client pointed at the configured docling-serve. */
  doclingClient: DoclingClient;
  /**
   * Root the source paths are relative to (the scanned source directory).
   * Used to derive a collision-resistant slug from each source's relative
   * path. Absolute source paths outside this root fall back to their basename.
   */
  sourceRoot: string;
  /**
   * Injected monotonic-enough clock for timing conversions. Defaults to
   * `Date.now`; tests inject a controllable clock. Kept out of the pure
   * report helpers — the caller stamps every timestamp.
   */
  now?: () => number;
}

export interface DocumentConverterPerDoc {
  /** Absolute source path that was converted. */
  path: string;
  /** Slug used for the derived filename. */
  docSlug: string;
  /** Absolute path to the derived Markdown file. */
  derivedTextPath: string;
}

export interface DocumentConverterSummary {
  /** Sources converted this run. */
  converted: number;
  /** Sources skipped — outside the filter, not `needs-conversion`, or unchanged. */
  skipped: number;
  /** Sources that errored during conversion — returned to `needs-conversion` with a recorded `lastError`. */
  failed: number;
  /** True when a stop signal was observed mid-run. */
  stoppedEarly: boolean;
  /** Per-document outcomes for converted sources. */
  perDoc: DocumentConverterPerDoc[];
}

/**
 * Convert every `needs-conversion` source in the source list. Mutates the
 * source list on disk (per-source status + derived paths + hash + diagnostics),
 * writes one Markdown file and one structural JSON sidecar per converted
 * source under `state/converted/`, and persists a conversion report.
 *
 * Returns a summary even when a stop signal interrupts the run mid-loop — the
 * partial result and report reflect what was persisted.
 */
export async function convertSources(
  deps: DocumentConverterDeps,
  options: DocumentConverterOptions,
): Promise<DocumentConverterSummary> {
  const sourceList = await deps.state.getSourceList();
  if (!sourceList) {
    throw new InvalidInputError(
      'sourceList',
      'Source list is missing.',
      'Run prepare before converting sources.',
    );
  }

  const now = deps.now ?? Date.now;
  const threshold = options.ocrTextYieldThreshold ?? DEFAULT_OCR_TEXT_YIELD_THRESHOLD;

  const filter =
    options.sourceFilter && options.sourceFilter.length > 0
      ? options.sourceFilter
      : undefined;

  const targets: IndexSource[] = [];
  let skipped = 0;
  for (const source of sourceList.sources) {
    if (source.status !== 'needs-conversion') {
      skipped += 1;
      continue;
    }
    if (filter && !matchesSourceFilter(source.path, filter)) {
      skipped += 1;
      continue;
    }
    targets.push(source);
  }

  const truncated =
    options.maxItems !== undefined ? targets.slice(0, Math.max(0, options.maxItems)) : targets;

  const convertedDir = join(deps.state.getStateDirPath(), CONVERTED_DIR);
  await mkdir(convertedDir, { recursive: true });

  const perDoc: DocumentConverterPerDoc[] = [];
  const entries: ConversionReportEntry[] = [];
  let converted = 0;
  let failed = 0;
  let stoppedEarly = false;

  try {
    for (const source of truncated) {
      if (await deps.state.isStopRequested()) {
        stoppedEarly = true;
        break;
      }

      const docSlug = deriveDocSlug(deps.sourceRoot, source.path);
      const filename = basename(source.path);
      const stopRequested = { value: false };

      try {
        const content = await readFile(source.path);
        const sourceHash = hashBytes(content);
        const mdPath = join(convertedDir, `${docSlug}.md`);
        const jsonPath = join(convertedDir, `${docSlug}.docling.json`);

        // Effective conversion options: the process default with any per-source
        // override layered on top, so a single document can be re-converted with
        // different settings from the rest of the batch. Computed once here so
        // the idempotency check and both export passes use the same options.
        const effectiveConvertOptions = mergeConvertOptions(
          options.convertOptions,
          source.sourceConvertOptions,
        );
        const optionsUnchanged = convertOptionsEqual(
          effectiveConvertOptions,
          source.convertOptionsUsed,
        );

        // Idempotency: an unchanged source with both derived files already on
        // disk, and the same effective options as last time, skips the round
        // trip entirely. A changed option forces a re-convert even when the
        // bytes are identical — the derived text depends on the options.
        if (
          source.sourceHash === sourceHash &&
          optionsUnchanged &&
          (await fileExists(mdPath)) &&
          (await fileExists(jsonPath))
        ) {
          await deps.state.updateSource(source.path, {
            status: 'pending',
            derivedTextPath: mdPath,
            derivedDoclingJsonPath: jsonPath,
            lastError: undefined,
          });
          entries.push(skippedEntry(source, docSlug, options, sourceHash));
          skipped += 1;
          continue;
        }

        // Reconverting: drop stale derived files and clear the entry's pointers
        // first, so a failed reconversion cannot leave the previous document's
        // text masquerading as current. This covers both a byte change and an
        // options change against a previously-converted source.
        if (source.sourceHash !== undefined && (source.sourceHash !== sourceHash || !optionsUnchanged)) {
          await deleteDerivedFiles(mdPath, jsonPath);
          await deps.state.updateSource(source.path, {
            derivedTextPath: undefined,
            derivedDoclingJsonPath: undefined,
            sourceHash: undefined,
          });
        }

        await deps.state.updateSource(source.path, { status: 'converting', lastError: undefined });

        const started = now();
        const startedAt = new Date(started).toISOString();

        const outcome = await convertOne(deps, source, options, threshold, {
          filename,
          docSlug,
          content,
          startedAt,
          now,
          stopRequested,
          convertOptions: effectiveConvertOptions,
        });

        await writeFile(mdPath, outcome.markdown, 'utf-8');
        await writeFile(jsonPath, JSON.stringify(outcome.jsonDocument, null, 2), 'utf-8');

        const durationMs = now() - started;
        const conversionMirror = {
          durationMs,
          ...(outcome.diagnostics.pageCount !== undefined ? { pageCount: outcome.diagnostics.pageCount } : {}),
          ...(outcome.diagnostics.tableCount !== undefined ? { tableCount: outcome.diagnostics.tableCount } : {}),
          ocrApplied: outcome.doOcr,
          ocrFallbackApplied: outcome.ocrFallbackApplied,
          warnings: outcome.warnings,
        };

        await deps.state.updateSource(source.path, {
          status: 'pending',
          derivedTextPath: mdPath,
          derivedDoclingJsonPath: jsonPath,
          sourceHash,
          conversion: conversionMirror,
          // Record the effective options actually used so the next run's
          // idempotency check is options-aware. Cleared when docling's defaults
          // were used, so a later options change is detectable.
          convertOptionsUsed: hasConvertOptions(effectiveConvertOptions) ? effectiveConvertOptions : undefined,
          lastError: undefined,
        });
        await deps.state.deleteConversionProgress(docSlug);

        entries.push({
          path: source.path,
          docSlug,
          status: 'converted',
          mode: options.mode,
          doOcr: outcome.doOcr,
          ocrFallbackApplied: outcome.ocrFallbackApplied,
          ...(outcome.diagnostics.pageCount !== undefined ? { pageCount: outcome.diagnostics.pageCount } : {}),
          ...(outcome.diagnostics.tableCount !== undefined ? { tableCount: outcome.diagnostics.tableCount } : {}),
          warnings: outcome.warnings,
          durationMs,
          sourceHash,
        });

        perDoc.push({ path: source.path, docSlug, derivedTextPath: mdPath });
        converted += 1;
      } catch (err) {
        // A stop signal surfaced from the async poll loop is not a failure —
        // the poll callback set the flag before returning its stop sentinel.
        // Leave the source `converting` for resetConvertingSources to recover
        // on the next run and end the batch.
        if (stopRequested.value) {
          stoppedEarly = true;
          break;
        }

        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        // A failed conversion returns to `needs-conversion` with the full error
        // recorded on the source entry (operator-facing) so it stays retryable;
        // a transient docling failure clears on the next run.
        await deps.state.updateSource(source.path, { status: 'needs-conversion', lastError: message });
        await deps.state.deleteConversionProgress(docSlug);
        // The report `warnings` are surfaced to the diagnose tool, so keep them
        // caller-safe: report the failure class without the internal service
        // URL the raw error message carries.
        const reportWarning = err instanceof DoclingServiceError
          ? `conversion failed (HTTP ${err.status ?? 'network error'})`
          : message;
        entries.push({
          path: source.path,
          docSlug,
          status: 'failed',
          mode: options.mode,
          doOcr: effectiveOcr(source, options),
          ocrFallbackApplied: false,
          warnings: [reportWarning],
          durationMs: 0,
          sourceHash: '',
        });
      }

      // Persist incrementally so a stopped or crashed run still leaves the
      // report of everything completed so far.
      await persistReport(deps, entries, now);
    }
  } finally {
    await persistReport(deps, entries, now);
    await deps.state.clearStopRequest();
  }

  return { converted, skipped, failed, stoppedEarly, perDoc };
}

/** Outcome of converting a single source through docling. */
interface ConvertOneOutcome {
  markdown: string;
  jsonDocument: Record<string, unknown>;
  doOcr: boolean;
  ocrFallbackApplied: boolean;
  diagnostics: { pageCount?: number; tableCount?: number };
  warnings: string[];
}

interface ConvertOneContext {
  filename: string;
  /** Collision-resistant slug; keys the derived files and progress file. */
  docSlug: string;
  content: Buffer;
  startedAt: string;
  now: () => number;
  /**
   * Set true by the async poll callback when it returns a stop sentinel, so
   * the caller can distinguish a stop from a genuine conversion failure
   * without inspecting the thrown error's message.
   */
  stopRequested: { value: boolean };
  /**
   * Effective conversion options (process default merged with the per-source
   * override) applied identically to both the Markdown and JSON passes.
   */
  convertOptions: DoclingConvertOptions;
}

/**
 * Convert one source to Markdown + structural JSON, applying the OCR decision.
 * When the OCR decision is left to the heuristic, a low text yield relative to
 * page count triggers a single reconversion with OCR on. Both export formats
 * are requested; the client cache makes the paired calls cheap on identical
 * input.
 */
async function convertOne(
  deps: DocumentConverterDeps,
  source: IndexSource,
  options: DocumentConverterOptions,
  threshold: number,
  ctx: ConvertOneContext,
): Promise<ConvertOneOutcome> {
  const decision = decideOcr(source, options);
  const warnings: string[] = [];

  const firstPass = decision.doOcr ?? false;
  let result = await runConversion(deps, source, options, ctx, firstPass);
  let doOcr = firstPass;
  let ocrFallbackApplied = false;

  if (decision.heuristic) {
    // Heuristic path: the first pass ran with OCR off. Reconvert with OCR only
    // when the text yield per page is implausibly low for a born-digital
    // document. No page count means no confident basis for the decision — do
    // not guess from byte size; record a warning and keep the no-OCR result.
    const pageCount = result.diagnostics.pageCount;
    if (pageCount === undefined) {
      warnings.push(
        'OCR heuristic skipped: the converted document reported no page count. ' +
          'If this document is scanned, set doOcr: true on the source to force OCR.',
      );
    } else if (pageCount > 0) {
      const charsPerPage = result.markdown.length / pageCount;
      if (charsPerPage < threshold) {
        result = await runConversion(deps, source, options, ctx, true);
        doOcr = true;
        ocrFallbackApplied = true;
      }
    }
  }

  return {
    markdown: result.markdown,
    jsonDocument: result.jsonDocument,
    doOcr,
    ocrFallbackApplied,
    diagnostics: {
      ...(result.diagnostics.pageCount !== undefined ? { pageCount: result.diagnostics.pageCount } : {}),
      ...(result.diagnostics.tableCount !== undefined ? { tableCount: result.diagnostics.tableCount } : {}),
    },
    warnings: [...warnings, ...result.diagnostics.warnings],
  };
}

interface SinglePassResult {
  markdown: string;
  jsonDocument: Record<string, unknown>;
  diagnostics: { pageCount?: number; tableCount?: number; warnings: string[] };
}

/**
 * Run one conversion at a fixed OCR setting, requesting both Markdown and the
 * structural JSON. Diagnostics are read from the JSON result — the richer of
 * the two payloads.
 */
async function runConversion(
  deps: DocumentConverterDeps,
  source: IndexSource,
  options: DocumentConverterOptions,
  ctx: ConvertOneContext,
  doOcr: boolean,
): Promise<SinglePassResult> {
  const mdResponse = await convertForFormat(deps, source, options, ctx, 'md', doOcr);
  const jsonResponse = await convertForFormat(deps, source, options, ctx, 'json', doOcr);

  const markdown = mdResponse.document.content['md_content'];
  if (typeof markdown !== 'string') {
    throw new DoclingServiceError(source.path, 'conversion returned no Markdown content');
  }

  const diagnostics = extractDoclingDiagnostics(jsonResponse.document);
  return {
    markdown,
    jsonDocument: jsonResponse.document.content,
    diagnostics,
  };
}

/**
 * Issue a single convert for one export format via the configured mode. On the
 * async path the poll callback writes live progress and honours the stop
 * signal by returning a stop sentinel.
 */
async function convertForFormat(
  deps: DocumentConverterDeps,
  source: IndexSource,
  options: DocumentConverterOptions,
  ctx: ConvertOneContext,
  format: 'md' | 'json',
  doOcr: boolean,
): Promise<DoclingConvertResponse> {
  const request = {
    content: ctx.content,
    filename: ctx.filename,
    mimeType: detectMime(source.path),
    toFormat: format,
    doOcr,
    ...(hasConvertOptions(ctx.convertOptions) ? { convertOptions: ctx.convertOptions } : {}),
  };

  if (options.mode === 'sync') {
    return deps.doclingClient.postConvert(request);
  }

  const started = ctx.now();
  return deps.doclingClient.convertViaAsync(request, {
    onPoll: async (task): Promise<PollDecision> => {
      const progress: ConversionProgress = {
        source: ctx.filename,
        taskId: task.taskId,
        taskStatus: task.taskStatus,
        ...(task.taskPosition !== undefined ? { taskPosition: task.taskPosition } : {}),
        startedAt: ctx.startedAt,
        elapsedMs: ctx.now() - started,
        ocrApplied: doOcr,
      };
      await deps.state.writeConversionProgress(ctx.docSlug, progress);
      if (await deps.state.isStopRequested()) {
        ctx.stopRequested.value = true;
        return 'stop';
      }
      return 'continue';
    },
  });
}

/**
 * Decide whether OCR runs for a source. Precedence: an explicit per-source
 * override, then the global option, then the format default. Non-PDF formats
 * carry text natively and never need OCR; PDFs with no explicit decision are
 * left to the caller's text-yield heuristic (`heuristic: true`).
 */
export function decideOcr(
  source: IndexSource,
  options: DocumentConverterOptions,
): { doOcr: boolean | undefined; heuristic: boolean } {
  if (source.doOcr !== undefined) return { doOcr: source.doOcr, heuristic: false };
  if (options.doOcr !== undefined) return { doOcr: options.doOcr, heuristic: false };

  const ext = extname(source.path).toLowerCase();
  if (NATIVE_TEXT_FORMATS.has(ext)) return { doOcr: false, heuristic: false };

  // A PDF with no explicit decision: run the no-OCR pass first and let the
  // yield heuristic decide whether a second OCR pass is warranted.
  return { doOcr: false, heuristic: true };
}

function effectiveOcr(source: IndexSource, options: DocumentConverterOptions): boolean {
  const decision = decideOcr(source, options);
  return decision.doOcr ?? false;
}

/**
 * The convert-option keys compared for idempotency and threaded to the client.
 * The `satisfies` binds this list to the type: renaming or adding a field on
 * `DoclingConvertOptions` breaks the build here rather than silently dropping
 * the field from the idempotency comparison.
 */
export const CONVERT_OPTION_KEYS = [
  'tableCellMatching',
  'tableMode',
  'doTableStructure',
  'pdfBackend',
] as const satisfies readonly (keyof DoclingConvertOptions)[];

/**
 * Merge a process-default option set with a per-source override so the override
 * wins per field. The result carries only set keys, since both inputs carry
 * only set keys.
 */
export function mergeConvertOptions(
  base: DoclingConvertOptions | undefined,
  override: DoclingConvertOptions | undefined,
): DoclingConvertOptions {
  return { ...base, ...override };
}

/** True when at least one convert option is set. */
function hasConvertOptions(options: DoclingConvertOptions): boolean {
  return CONVERT_OPTION_KEYS.some((key) => options[key] !== undefined);
}

/**
 * Field-wise equality over the known convert-option keys. An unset field on
 * either side compares equal to an unset field on the other, so an effective
 * `{}` matches a recorded `undefined` and no spurious re-convert results.
 */
export function convertOptionsEqual(
  a: DoclingConvertOptions | undefined,
  b: DoclingConvertOptions | undefined,
): boolean {
  return CONVERT_OPTION_KEYS.every((key) => a?.[key] === b?.[key]);
}

/**
 * Build the report entry for a source skipped as unchanged. The OCR figures and
 * page/table counts come from the persisted `conversion` mirror of the prior
 * run — the historical truth — so a skip does not misreport (e.g. claim no OCR
 * on a document that was originally OCR'd). Falls back to the current decision
 * only when no mirror exists (a source converted before the mirror was added).
 */
function skippedEntry(
  source: IndexSource,
  docSlug: string,
  options: DocumentConverterOptions,
  sourceHash: string,
): ConversionReportEntry {
  const mirror = source.conversion;
  return {
    path: source.path,
    docSlug,
    status: 'skipped-unchanged',
    mode: options.mode,
    doOcr: mirror?.ocrApplied ?? effectiveOcr(source, options),
    ocrFallbackApplied: mirror?.ocrFallbackApplied ?? false,
    ...(mirror?.pageCount !== undefined ? { pageCount: mirror.pageCount } : {}),
    ...(mirror?.tableCount !== undefined ? { tableCount: mirror.tableCount } : {}),
    warnings: [],
    durationMs: 0,
    sourceHash,
  };
}

async function persistReport(
  deps: DocumentConverterDeps,
  entries: ConversionReportEntry[],
  now: () => number,
): Promise<void> {
  const report: ConversionReport = {
    generatedAt: new Date(now()).toISOString(),
    entries,
    summary: summarize(entries),
  };
  await deps.state.saveConversionReport(report);
}

async function deleteDerivedFiles(mdPath: string, jsonPath: string): Promise<void> {
  await removeIfPresent(mdPath);
  await removeIfPresent(jsonPath);
}

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // File may not exist — deletion is best-effort invalidation.
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function hashBytes(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Detect a MIME type from a filename. Defaults to `application/octet-stream`
 * — docling-serve sniffs the extension regardless, so this is a cooperative
 * hint, not a contract.
 */
export function detectMime(path: string): string {
  const ext = extname(path).toLowerCase();
  return MIME_BY_EXTENSION[ext] ?? 'application/octet-stream';
}

/**
 * Derive a filesystem-safe slug from a source's path relative to the source
 * root. Nested paths kebab-case their separators so `guides/intro.pdf` and
 * `refs/intro.pdf` do not collide on the bare filename.
 */
export function deriveDocSlug(sourceRoot: string, sourcePath: string): string {
  let rel = sourcePath;
  if (sourceRoot) {
    const candidate = relative(sourceRoot, sourcePath);
    if (candidate && !candidate.startsWith('..') && !isAbsolute(candidate)) {
      rel = candidate;
    } else {
      rel = sourcePath.split(/[\\/]/).pop() ?? sourcePath;
    }
  }
  const withoutExt = rel.replace(/\.[^./\\]+$/, '');
  const slug = withoutExt
    .toLowerCase()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'document';
}
