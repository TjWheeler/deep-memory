/**
 * Resolves each extraction's `sourcePath` to the readable text a validation
 * worker should actually read.
 *
 * Extraction records the *original* source path on every `ExtractionOutput`
 * (e.g. a binary `.pdf`). For a source that was converted to text before
 * extraction, the readable content lives at `derivedTextPath`; reading the
 * original path as UTF-8 yields binary garbage. Validation tools read the
 * `sourcePath` verbatim, so the path handed to them must point at the derived
 * text when one exists.
 *
 * This is a pure transform: it returns a new array of extractions with
 * `sourcePath` swapped for the matching source's `derivedTextPath` when set,
 * leaving the original array untouched. A source with no `derivedTextPath`
 * (plain `.md`/`.txt`, never converted) falls through to its original path
 * unchanged, as does any extraction whose path matches no registered source
 * (e.g. a stale or removed source).
 */

import type { ExtractionOutput } from '../types/extraction.js';
import type { IndexSource } from '../types/source-list.js';

/**
 * Produce a new extractions array whose `sourcePath` is resolved to the
 * matching source's `derivedTextPath ?? path`. Matches on
 * `extraction.sourcePath === source.path`. Never throws; unmatched extractions
 * pass through unchanged.
 */
export function resolveExtractionSourcePaths(
  extractions: ExtractionOutput[],
  sources: IndexSource[],
): ExtractionOutput[] {
  const byPath = new Map<string, IndexSource>();
  for (const source of sources) {
    byPath.set(source.path, source);
  }

  return extractions.map((extraction) => {
    const source = byPath.get(extraction.sourcePath);
    if (!source) {
      return extraction;
    }
    const resolvedPath = source.derivedTextPath ?? source.path;
    if (resolvedPath === extraction.sourcePath) {
      return extraction;
    }
    return { ...extraction, sourcePath: resolvedPath };
  });
}
