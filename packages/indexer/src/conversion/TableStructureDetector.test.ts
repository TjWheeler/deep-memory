import { describe, it, expect } from 'vitest';
import {
  TableStructureDetector,
  buildTableCorruptionRecommendation,
  type TableStructureFinding,
} from './TableStructureDetector.js';

/** Build a docling sidecar envelope holding one structural table from a 2-D text grid. */
function sidecarWithTable(grid: string[][], numCols: number): unknown {
  return {
    filename: 'fixture.pdf',
    md_content: '',
    json_content: {
      tables: [
        {
          num_rows: grid.length,
          num_cols: numCols,
          data: {
            num_rows: grid.length,
            num_cols: numCols,
            grid: grid.map(row => row.map(text => ({ text }))),
          },
        },
      ],
    },
  };
}

/** A well-formed 3-column table: grid and Markdown agree. */
const CLEAN_MARKDOWN = [
  '| Zone | Code | Use |',
  '| --- | --- | --- |',
  '| R1 | P | House |',
  '| R2 | D | Shop |',
].join('\n');

const CLEAN_GRID: string[][] = [
  ['Zone', 'Code', 'Use'],
  ['R1', 'P', 'House'],
  ['R2', 'D', 'Shop'],
];

/**
 * The LPS12 corruption pattern: one wide (14-column) structural table whose
 * cells carry a scattered prose deferral and a split "Refer to Clause 3.3.6",
 * rendered to Markdown as three narrow sub-tables.
 */
const CORRUPT_GRID: string[][] = [
  ['Zone', 'C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8', 'C9', 'C10', 'C11', 'C12', 'C13'],
  ['LPS12', 'P', 'D', 'A', 'X', 'P', 'D', 'Refer to Clause 3.3.6', 'A', 'X', 'P', 'D', 'A', 'X'],
  ['R2', 'D', 'P', 'X', 'A', 'D', 'Refer to', 'Clause 3.3.6', 'P', 'A', 'D', 'X', 'P', 'A'],
  ['R3', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A'],
  ['R4', 'X', 'A', 'D', 'P', 'X', 'A', 'D', 'P', 'X', 'A', 'D', 'P', 'X'],
  ['R5', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P'],
];

const CORRUPT_MARKDOWN = [
  '| Zone | C1 | C2 | C3 | C4 |',
  '| --- | --- | --- | --- | --- |',
  '| LPS12 | P | D | A | X |',
  '',
  '| C5 | C6 | C7 | C8 | C9 |',
  '| --- | --- | --- | --- | --- |',
  '| P | D | Refer to Clause 3.3.6 | A | X |',
  '',
  '| C10 | C11 | C12 | C13 |',
  '| --- | --- | --- | --- |',
  '| P | D | A | X |',
].join('\n');

/**
 * A legitimate council permissibility table: code columns (P/D/A/X) whose
 * headers are multi-word zone names, plus a prose Notes column carrying a
 * correctly-placed clause deferral. Grid and Markdown agree on topology, so
 * nothing here should elevate the rating. Four data rows so the column-
 * homogeneity check is actually reached (and then suppressed).
 */
const COUNCIL_GRID: string[][] = [
  ['Use', 'General Residential Zone', 'Rural Living Zone', 'Commercial Zone', 'Notes'],
  ['Dwelling', 'P', 'P', 'X', 'Refer to Clause 3.3.6'],
  ['Shop', 'X', 'D', 'P', 'Permitted with consent'],
  ['Farm', 'X', 'P', 'X', 'See overlay map for extent'],
  ['Office', 'D', 'X', 'P', 'Subject to Clause 4.1 controls'],
];

const COUNCIL_MARKDOWN = [
  '| Use | General Residential Zone | Rural Living Zone | Commercial Zone | Notes |',
  '| --- | --- | --- | --- | --- |',
  '| Dwelling | P | P | X | Refer to Clause 3.3.6 |',
  '| Shop | X | D | P | Permitted with consent |',
  '| Farm | X | P | X | See overlay map for extent |',
  '| Office | D | X | P | Subject to Clause 4.1 controls |',
].join('\n');

/** A genuinely wide (10-column) but faithful table: grid and Markdown widths match. */
const WIDE_CLEAN_GRID: string[][] = [
  ['Use', 'Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z8', 'Z9'],
  ['Dwelling', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X', 'P'],
  ['Shop', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A', 'X'],
  ['Farm', 'A', 'X', 'P', 'D', 'A', 'X', 'P', 'D', 'A'],
];

const WIDE_CLEAN_MARKDOWN = [
  '| Use | Z1 | Z2 | Z3 | Z4 | Z5 | Z6 | Z7 | Z8 | Z9 |',
  '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  '| Dwelling | P | D | A | X | P | D | A | X | P |',
  '| Shop | X | P | D | A | X | P | D | A | X |',
  '| Farm | A | X | P | D | A | X | P | D | A |',
].join('\n');

/** A clean 4-column table split across a page break into two Markdown tables of equal width. */
const PAGEBREAK_GRID: string[][] = [
  ['Use', 'Residential', 'Rural', 'Notes'],
  ['Dwelling', 'P', 'X', 'a'],
  ['Shop', 'X', 'D', 'b'],
  ['Farm', 'X', 'P', 'c'],
  ['Office', 'D', 'X', 'd'],
];

const PAGEBREAK_MARKDOWN = [
  '| Use | Residential | Rural | Notes |',
  '| --- | --- | --- | --- |',
  '| Dwelling | P | X | a |',
  '| Shop | X | D | b |',
  '',
  '| Use | Residential | Rural | Notes |',
  '| --- | --- | --- | --- |',
  '| Farm | X | P | c |',
  '| Office | D | X | d |',
].join('\n');

describe('TableStructureDetector', () => {
  const detector = new TableStructureDetector();

  it('rates a well-formed table as clean', () => {
    const finding = detector.analyze(
      'clean.pdf',
      '/docs/clean.pdf',
      CLEAN_MARKDOWN,
      sidecarWithTable(CLEAN_GRID, 3),
    );
    expect(finding.rating).toBe('clean');
    expect(finding.structuredTableCount).toBe(1);
    expect(finding.markdownTableCount).toBe(1);
    expect(finding.examples).toHaveLength(0);
  });

  it('rates the merged-cell fragmentation pattern as corrupt with corroborated evidence', () => {
    const finding = detector.analyze(
      'LPS12.pdf',
      '/docs/LPS12.pdf',
      CORRUPT_MARKDOWN,
      sidecarWithTable(CORRUPT_GRID, 14),
    );
    expect(finding.rating).toBe('corrupt');
    expect(finding.structuredTableCount).toBe(1);
    expect(finding.markdownTableCount).toBe(3);

    const checks = new Set(finding.examples.map(e => e.check));
    // Corrupt requires width-divergence plus at least one corroborating signal.
    expect(checks.has('topology')).toBe(true);
    expect(checks.has('column-homogeneity')).toBe(true);
    expect(checks.has('fragment-adjacency')).toBe(true);
    expect(finding.examples.length).toBeLessThanOrEqual(10);
  });

  it('resolves a stringified json_content payload', () => {
    const envelope = {
      json_content: JSON.stringify({
        tables: [
          {
            num_rows: CORRUPT_GRID.length,
            num_cols: 14,
            data: {
              num_rows: CORRUPT_GRID.length,
              num_cols: 14,
              grid: CORRUPT_GRID.map(row => row.map(text => ({ text }))),
            },
          },
        ],
      }),
    };
    const finding = detector.analyze('LPS12.pdf', '/docs/LPS12.pdf', CORRUPT_MARKDOWN, envelope);
    expect(finding.rating).toBe('corrupt');
  });

  it('never throws on a malformed or absent payload', () => {
    expect(() => detector.analyze('x.pdf', '/x.pdf', '', undefined)).not.toThrow();
    expect(detector.analyze('x.pdf', '/x.pdf', '', undefined).rating).toBe('clean');
    expect(detector.analyze('x.pdf', '/x.pdf', '', { json_content: 42 }).rating).toBe('clean');
    expect(
      detector.analyze('x.pdf', '/x.pdf', 'not a table', { json_content: { tables: 'nope' } }).rating,
    ).toBe('clean');
  });

  // ── Negative cases: legitimate tables must not be flagged ─────────

  it('does not flag a legitimate council code+description table (topology agrees)', () => {
    const finding = detector.analyze(
      'council.pdf',
      '/docs/council.pdf',
      COUNCIL_MARKDOWN,
      sidecarWithTable(COUNCIL_GRID, 5),
    );
    expect(finding.rating).toBe('clean');
    // A correctly-placed in-cell deferral and multi-word code-column headers
    // must not, on their own, elevate the rating: content signals are suppressed
    // without a structural signal.
    expect(finding.examples.some(e => e.check === 'column-homogeneity')).toBe(false);
    expect(finding.examples).toHaveLength(0);
  });

  it('does not flag a genuinely wide table whose grid and Markdown widths match', () => {
    const finding = detector.analyze(
      'wide.pdf',
      '/docs/wide.pdf',
      WIDE_CLEAN_MARKDOWN,
      sidecarWithTable(WIDE_CLEAN_GRID, 10),
    );
    expect(finding.rating).toBe('clean');
  });

  it('treats a page-break split (equal widths) as at most suspect, never corrupt', () => {
    const finding = detector.analyze(
      'split.pdf',
      '/docs/split.pdf',
      PAGEBREAK_MARKDOWN,
      sidecarWithTable(PAGEBREAK_GRID, 4),
    );
    expect(finding.rating).not.toBe('corrupt');
    expect(finding.rating).toBe('suspect');
  });
});

describe('buildTableCorruptionRecommendation', () => {
  const detector = new TableStructureDetector();
  const corruptFinding: TableStructureFinding = detector.analyze(
    'LPS12.pdf',
    '/docs/LPS12.pdf',
    CORRUPT_MARKDOWN,
    sidecarWithTable(CORRUPT_GRID, 14),
  );

  it('recommends a re-convert under default conversion options', () => {
    const rec = buildTableCorruptionRecommendation(corruptFinding, undefined);
    expect(rec).toBeDefined();
    expect(rec!.rating).toBe('corrupt');
    expect(rec!.remediation).toBeDefined();
    expect(rec!.remediation!.tool).toBe('indexing_update');
    expect(rec!.remediation!.args.source).toBe('LPS12.pdf');
    expect(rec!.remediation!.args.sourceConvertOptions.tableCellMatching).toBe(false);
  });

  it('does not recommend a re-convert when the flag was already applied and did not help', () => {
    const rec = buildTableCorruptionRecommendation(corruptFinding, { tableCellMatching: false });
    expect(rec).toBeDefined();
    expect(rec!.remediation).toBeUndefined();
    expect(rec!.message).toContain('did not resolve');
  });

  it('still recommends a re-convert when a prior conversion left cell-matching on', () => {
    const rec = buildTableCorruptionRecommendation(corruptFinding, { tableMode: 'accurate' });
    expect(rec).toBeDefined();
    expect(rec!.remediation).toBeDefined();
  });

  it('produces nothing for a clean finding', () => {
    const cleanFinding = detector.analyze(
      'clean.pdf',
      '/docs/clean.pdf',
      CLEAN_MARKDOWN,
      sidecarWithTable(CLEAN_GRID, 3),
    );
    expect(buildTableCorruptionRecommendation(cleanFinding, undefined)).toBeUndefined();
  });
});
