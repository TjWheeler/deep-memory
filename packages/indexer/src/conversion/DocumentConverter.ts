/**
 * DocumentConverter — turns rich-format sources into derived Markdown before
 * extraction.
 *
 * Pipeline (per source with status `needs-conversion`):
 *   1) Read the source bytes.
 *   2) `DoclingClient.postConvert(...)` — one round trip yields Markdown.
 *   3) Write the Markdown to `state/converted/{docSlug}.md`.
 *   4) Record `derivedTextPath` on the entry and flip status to `pending`
 *      so the existing extraction path consumes the derived text.
 *
 * One bad source must not abort the batch — an exception returns that source
 * to `needs-conversion` with a `lastError` message so it stays retryable, and
 * the loop continues. Higher-level failures (missing source list) abort before
 * the loop starts.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { extname, join, relative, isAbsolute } from 'node:path';
import { InvalidInputError } from '@utaba/deep-memory';

import { DoclingServiceError } from './errors.js';
import type { DoclingClient } from './DoclingClient.js';
import type { StateManager } from '../orchestrator/StateManager.js';
import type { IndexSource } from '../types/source-list.js';

/** Subdirectory under the state dir where derived Markdown is written. */
const CONVERTED_DIR = 'converted';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
};

export interface DocumentConverterOptions {
  /** Filter to a subset of sources by `path`. */
  sourceFilter?: string[];
  /** Hard cap on the number of sources to process this run. */
  maxItems?: number;
  /** Whether docling-serve runs OCR. Forwarded to each convert request. */
  doOcr?: boolean;
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
  /** Sources skipped — outside the filter or not `needs-conversion`. */
  skipped: number;
  /** Sources that errored during conversion — returned to `needs-conversion` with a recorded `lastError`. */
  failed: number;
  /** True when a stop signal was observed mid-run. */
  stoppedEarly: boolean;
  /** Per-document outcomes for converted sources. */
  perDoc: DocumentConverterPerDoc[];
}

/**
 * Convert every `needs-conversion` source in the source list to Markdown.
 * Mutates the source list on disk (per-source status + `derivedTextPath`)
 * and writes one Markdown file per converted source under
 * `state/converted/`.
 *
 * Returns a summary even when a stop signal interrupts the run mid-loop —
 * the partial result reflects what was persisted.
 */
export async function convertSources(
  deps: DocumentConverterDeps,
  options: DocumentConverterOptions = {},
): Promise<DocumentConverterSummary> {
  const sourceList = await deps.state.getSourceList();
  if (!sourceList) {
    throw new InvalidInputError(
      'sourceList',
      'Source list is missing.',
      'Run prepare before converting sources.',
    );
  }

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
    if (filter && !filter.some((f) => source.path === f || source.path.includes(f))) {
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
  let converted = 0;
  let failed = 0;
  let stoppedEarly = false;

  try {
    for (const source of truncated) {
      if (await deps.state.isStopRequested()) {
        stoppedEarly = true;
        break;
      }

      try {
        await deps.state.updateSource(source.path, { status: 'converting', lastError: undefined });

        const docSlug = deriveDocSlug(deps.sourceRoot, source.path);
        const markdown = await convertOne(deps, source, options.doOcr);
        const derivedTextPath = join(convertedDir, `${docSlug}.md`);
        await writeFile(derivedTextPath, markdown, 'utf-8');

        await deps.state.updateSource(source.path, {
          status: 'pending',
          derivedTextPath,
          lastError: undefined,
        });

        perDoc.push({ path: source.path, docSlug, derivedTextPath });
        converted += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        // A failed conversion returns to `needs-conversion` with the error
        // recorded, mirroring how failed extraction stays retryable with a
        // `lastError`. A transient docling failure clears on the next run;
        // a persistent one is surfaced via the recorded error.
        await deps.state.updateSource(source.path, { status: 'needs-conversion', lastError: message });
      }
    }
  } finally {
    await deps.state.clearStopRequest();
  }

  return { converted, skipped, failed, stoppedEarly, perDoc };
}

async function convertOne(
  deps: DocumentConverterDeps,
  source: IndexSource,
  doOcr: boolean | undefined,
): Promise<string> {
  const content = await readFile(source.path);
  const filename = source.path.split(/[\\/]/).pop() ?? source.path;
  const response = await deps.doclingClient.postConvert({
    content,
    filename,
    mimeType: detectMime(source.path),
    toFormat: 'md',
    ...(doOcr !== undefined ? { doOcr } : {}),
  });

  const markdown = response.document.content['md_content'];
  if (typeof markdown !== 'string') {
    throw new DoclingServiceError(
      source.path,
      'conversion returned no Markdown content',
    );
  }
  return markdown;
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
