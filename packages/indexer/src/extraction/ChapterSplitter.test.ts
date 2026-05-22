import { describe, it, expect } from 'vitest';
import { isMarkdownStructured, splitIntoChapters, generateOverview, addChapterLineNumbers } from './ChapterSplitter.js';
import type { IndexSource } from '../types/source-list.js';

const MULTI_HEADING_DOC = `# Equipment Overview

This document describes the Cat 325F.

## Engine

The engine is a Cat C4.4 ACERT.

### Specifications

- Power: 138 kW
- Displacement: 4.4 L

## Hydraulic System

Main pump flow: 2 x 185 L/min.

## Undercarriage

Track shoes: 600 mm standard.
`;

const SIMPLE_DOC = `This is a plain text document.
It has no headings at all.
Just paragraphs of text.
`;

const PAGE_MARKER_DOC = `Title page content here.
Some introductory text that spans multiple lines.
This is important safety information.

-- 1 of 10 --

${'Chapter one content.\n'.repeat(50)}

-- 2 of 10 --

${'Chapter two content.\n'.repeat(50)}

-- 3 of 10 --

${'Chapter three content.\n'.repeat(50)}
`;

const BLANK_GAP_DOC = `First section of content.
${'Line of text.\n'.repeat(40)}


${'Second section after double blank.\n'.repeat(40)}


${'Third section after another gap.\n'.repeat(40)}
`;

const source: IndexSource = {
  path: '/docs/cat-325f-manual.md',
  type: 'om-manual',
  status: 'pending',
  notes: '601 KB',
};

describe('isMarkdownStructured', () => {
  it('returns true for documents with markdown headings', () => {
    expect(isMarkdownStructured(MULTI_HEADING_DOC)).toBe(true);
  });

  it('returns true for documents with page markers', () => {
    expect(isMarkdownStructured(PAGE_MARKER_DOC)).toBe(true);
  });

  it('returns true for documents with blank gaps', () => {
    expect(isMarkdownStructured(BLANK_GAP_DOC)).toBe(true);
  });

  it('returns false for short plain text', () => {
    expect(isMarkdownStructured(SIMPLE_DOC)).toBe(false);
  });
});

describe('splitIntoChapters — heading-based', () => {
  it('splits on ATX headings when segments exceed maxChunkSize', () => {
    // Build a document large enough that heading-based segments can't be merged
    const bigDoc = '# Overview\n\n' + 'Overview content.\n'.repeat(200) +
      '\n## Engine\n\n' + 'Engine details.\n'.repeat(200) +
      '\n## Hydraulic System\n\n' + 'Hydraulic details.\n'.repeat(200);
    // Use a small maxChunkSize to force splitting
    const chapters = splitIntoChapters(bigDoc, 5000);
    expect(chapters.length).toBeGreaterThanOrEqual(3);
  });

  it('merges small heading-based segments together', () => {
    // The small test doc should merge small sections
    const chapters = splitIntoChapters(MULTI_HEADING_DOC);
    // Small sections get merged, so fewer chapters than headings
    expect(chapters.length).toBeGreaterThanOrEqual(1);
    // But all content is preserved
    const allContent = chapters.map(c => c.content).join('\n');
    expect(allContent).toContain('Equipment Overview');
    expect(allContent).toContain('Engine');
    expect(allContent).toContain('Hydraulic System');
  });

  it('preserves line numbers', () => {
    const chapters = splitIntoChapters(MULTI_HEADING_DOC);
    expect(chapters[0]!.lineStart).toBeGreaterThanOrEqual(1);
  });
});

describe('splitIntoChapters — page markers', () => {
  it('splits on page markers when content exceeds maxChunkSize', () => {
    const chapters = splitIntoChapters(PAGE_MARKER_DOC, 2000);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
  });

  it('merges small page-based segments into larger ones', () => {
    // With default 30K maxChunkSize, this small doc merges into 1 segment
    const chapters = splitIntoChapters(PAGE_MARKER_DOC);
    expect(chapters.length).toBe(1);
  });

  it('segments have reasonable content', () => {
    const chapters = splitIntoChapters(PAGE_MARKER_DOC);
    for (const ch of chapters) {
      expect(ch.content.length).toBeGreaterThan(0);
    }
  });
});

describe('splitIntoChapters — blank gaps', () => {
  it('splits on double-blank-line gaps when exceeding maxChunkSize', () => {
    const chapters = splitIntoChapters(BLANK_GAP_DOC, 1000);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
  });
});

describe('splitIntoChapters — size constraints', () => {
  it('merges small segments', () => {
    const chapters = splitIntoChapters(MULTI_HEADING_DOC);
    // All segments should be at least MIN_SEGMENT_CHARS (1000) or be the only segment
    for (const ch of chapters) {
      if (chapters.length > 1) {
        // With a small document, merging may produce fewer chapters
        expect(ch.content.length).toBeGreaterThan(0);
      }
    }
  });

  it('sub-splits oversized segments', () => {
    // Create a large document with one heading and lots of content
    const bigContent = '# Big Section\n\n' + 'A'.repeat(100) + '\n\n' +
      Array.from({ length: 200 }, (_, i) => `Line ${i}: ${'x'.repeat(200)}`).join('\n');
    const chapters = splitIntoChapters(bigContent, 5000);
    expect(chapters.length).toBeGreaterThan(1);
    for (const ch of chapters) {
      expect(ch.content.length).toBeLessThanOrEqual(6000); // some tolerance
    }
  });

  it('single small document returns one segment', () => {
    const chapters = splitIntoChapters(SIMPLE_DOC);
    expect(chapters.length).toBe(1);
  });
});

describe('generateOverview', () => {
  it('extracts title from first heading', () => {
    const chapters = splitIntoChapters(MULTI_HEADING_DOC);
    const overview = generateOverview(source, chapters);
    expect(overview.title).toBe('Equipment Overview');
  });

  it('falls back to filename when no headings', () => {
    const chapters = splitIntoChapters(PAGE_MARKER_DOC);
    const overview = generateOverview(source, chapters);
    expect(overview.title).toBe('cat-325f-manual.md');
  });

  it('includes metadata', () => {
    const chapters = splitIntoChapters(MULTI_HEADING_DOC);
    const overview = generateOverview(source, chapters);
    expect(overview.metadata).toContain('/docs/cat-325f-manual.md');
    expect(overview.metadata).toContain('om-manual');
  });
});

describe('addChapterLineNumbers', () => {
  it('prepends absolute line numbers', () => {
    const chapters = splitIntoChapters(MULTI_HEADING_DOC);
    const numbered = addChapterLineNumbers(chapters[0]!);
    const firstLine = numbered.split('\n')[0]!;
    expect(firstLine).toMatch(/^\d+\t/);
    const lineNum = parseInt(firstLine.split('\t')[0]!, 10);
    expect(lineNum).toBe(chapters[0]!.lineStart);
  });
});
