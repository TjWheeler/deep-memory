import { describe, it, expect } from 'vitest';
import { resolveExtractionSourcePaths } from './resolve-source-paths.js';
import type { ExtractionOutput } from '../types/extraction.js';
import type { IndexSource } from '../types/source-list.js';

function makeExtraction(sourcePath: string, source = 'doc'): ExtractionOutput {
  return {
    source,
    sourcePath,
    extractedAt: '2026-07-19T00:00:00.000Z',
    extractedBy: 'worker',
    entities: [],
    relationships: [],
  };
}

function makeSource(path: string, overrides: Partial<IndexSource> = {}): IndexSource {
  return {
    path,
    type: 'doc',
    status: 'extracted',
    ...overrides,
  };
}

describe('resolveExtractionSourcePaths', () => {
  it('resolves a converted source to its derived text path', () => {
    const extractions = [makeExtraction('/proj/docs/report.pdf')];
    const sources = [
      makeSource('/proj/docs/report.pdf', { derivedTextPath: '/proj/state/converted/report.md' }),
    ];

    const result = resolveExtractionSourcePaths(extractions, sources);

    expect(result[0]?.sourcePath).toBe('/proj/state/converted/report.md');
  });

  it('leaves a never-converted source at its original path', () => {
    const extractions = [makeExtraction('/proj/docs/notes.md')];
    const sources = [makeSource('/proj/docs/notes.md')];

    const result = resolveExtractionSourcePaths(extractions, sources);

    expect(result[0]?.sourcePath).toBe('/proj/docs/notes.md');
  });

  it('passes an unmatched extraction through unchanged without throwing', () => {
    const extractions = [makeExtraction('/proj/docs/removed.pdf')];
    const sources = [
      makeSource('/proj/docs/other.pdf', { derivedTextPath: '/proj/state/converted/other.md' }),
    ];

    const result = resolveExtractionSourcePaths(extractions, sources);

    expect(result[0]?.sourcePath).toBe('/proj/docs/removed.pdf');
  });

  it('does not mutate the input extractions', () => {
    const extractions = [makeExtraction('/proj/docs/report.pdf')];
    const sources = [
      makeSource('/proj/docs/report.pdf', { derivedTextPath: '/proj/state/converted/report.md' }),
    ];

    const result = resolveExtractionSourcePaths(extractions, sources);

    expect(extractions[0]?.sourcePath).toBe('/proj/docs/report.pdf');
    expect(result[0]).not.toBe(extractions[0]);
  });

  it('resolves a mixed set per-source', () => {
    const extractions = [
      makeExtraction('/proj/docs/report.pdf', 'report.pdf'),
      makeExtraction('/proj/docs/notes.md', 'notes.md'),
      makeExtraction('/proj/docs/stale.pdf', 'stale.pdf'),
    ];
    const sources = [
      makeSource('/proj/docs/report.pdf', { derivedTextPath: '/proj/state/converted/report.md' }),
      makeSource('/proj/docs/notes.md'),
    ];

    const result = resolveExtractionSourcePaths(extractions, sources);

    expect(result.map(e => e.sourcePath)).toEqual([
      '/proj/state/converted/report.md',
      '/proj/docs/notes.md',
      '/proj/docs/stale.pdf',
    ]);
    // Non-path fields are preserved.
    expect(result[0]?.source).toBe('report.pdf');
  });
});
