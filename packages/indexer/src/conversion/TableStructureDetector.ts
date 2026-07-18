/**
 * Static table-structure detector.
 *
 * Compares a converted document's rendered Markdown against its structural
 * docling grid (the `{slug}.docling.json` sidecar) to spot the corruption that
 * merged/dense columns suffer when docling matches its table predictions back
 * to raw PDF cells: one wide logical table fragments into several narrow
 * Markdown sub-tables, prose deferrals ("Refer to Clause 3.3.6") scatter into
 * columns otherwise made of short codes, and single cells split across
 * neighbours.
 *
 * Pure computation — no LLM calls. Every parse step is defensive: a missing,
 * malformed, or absent payload yields a `clean` finding (or no finding at all)
 * rather than throwing, because the sidecar shape is an opaque docling-serve
 * artifact that may drift across schema versions. The detector only *raises a
 * recommendation*; the driving agent verifies and decides. The fix site is
 * conversion, not extraction: a flagged file is re-converted with
 * `tableCellMatching` disabled, then re-extracted.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { resolveRecord } from './ConversionReport.js';
import type { DoclingConvertOptions } from './types.js';

/** Which structural check produced a piece of evidence. */
export type TableStructureCheck =
  | 'topology'
  | 'rectangularity'
  | 'column-homogeneity'
  | 'fragment-adjacency';

/** Detector verdict for a single converted document. */
export type TableStructureRating = 'clean' | 'suspect' | 'corrupt';

/** One concrete observation supporting a rating. */
export interface TableStructureEvidence {
  /** The check that raised this observation. */
  check: TableStructureCheck;
  /** Human-readable description of the specific anomaly. */
  detail: string;
}

/** The detector's per-document result. */
export interface TableStructureFinding {
  /** Display name of the source (its basename). */
  source: string;
  /** Absolute source path. */
  path: string;
  /** Overall verdict — the worst signal across all checks. */
  rating: TableStructureRating;
  /** Number of tables recovered from the structural grid. */
  structuredTableCount: number;
  /** Number of tables parsed from the rendered Markdown. */
  markdownTableCount: number;
  /** Up to 10 evidence items, strongest checks first. */
  examples: TableStructureEvidence[];
}

/** A structured, executable re-convert step the agent can apply verbatim. */
export interface TableCorruptionRemediation {
  /** The MCP tool that performs the fix. */
  tool: 'indexing_update';
  /** Arguments that force a per-file re-convert with cell-matching disabled. */
  args: {
    source: string;
    sourceConvertOptions: { tableCellMatching: false };
  };
  /** What the remediation does and why. */
  description: string;
}

/**
 * A non-blocking recommendation surfaced when a converted document's tables
 * look corrupt. `remediation` is present only when a re-convert could plausibly
 * help — it is deliberately absent once a file has already been converted with
 * `tableCellMatching` disabled, so the same advice never loops.
 */
export interface TableCorruptionRecommendation {
  /** Display name of the source (its basename). */
  source: string;
  /** Absolute source path. */
  path: string;
  /** The detector rating that triggered this recommendation. */
  rating: TableStructureRating;
  /** Human-readable summary of what was seen and what to do. */
  message: string;
  /** Up to 10 evidence items from the detector. */
  evidence: TableStructureEvidence[];
  /** The executable re-convert step — absent when re-converting won't help. */
  remediation?: TableCorruptionRemediation;
}

/** Minimal source shape the detector reads. */
export interface TableStructureSourceInput {
  /** Absolute source path. */
  path: string;
  /** Absolute path to the derived Markdown, when the source was converted. */
  derivedTextPath?: string;
  /** Absolute path to the `{slug}.docling.json` structural sidecar. */
  derivedDoclingJsonPath?: string;
}

/**
 * Absolute column-count gap between the structural grid and the widest Markdown
 * table before the grid reads as "materially wider". Small deltas are tolerated
 * because a spanning header legitimately inflates the grid's `num_cols` above the
 * rendered column count on a faithful table.
 */
const COL_DIVERGENCE = 3;
/**
 * The grid must also be at least this multiple of the widest Markdown table's
 * width before divergence counts — so a span-inflated but faithful table (grid a
 * column or two wider) is not mistaken for fragmentation, while a 14-col grid
 * collapsing to 3-col Markdown sub-tables is.
 */
const WIDTH_RATIO = 1.5;
/** A cell this short or shorter is treated as a code, not prose. */
const CODE_MAX_LEN = 3;
/** A cell this long or longer is treated as prose. */
const PROSE_MIN_LEN = 16;
/** Fraction of a column that must be codes before a lone prose cell looks misplaced. */
const CODE_COLUMN_RATIO = 0.6;
/** Cap on evidence items carried on a finding. */
const MAX_EXAMPLES = 10;

interface StructuredTable {
  numRows: number;
  numCols: number;
  rows: string[][];
  /** True when `rows` came from the real 2-D `data.grid`, false from the flat-cell fallback. */
  fromGrid: boolean;
}

interface MarkdownTable {
  header: string[];
  rows: string[][];
}

/** Result of the topology comparison, split into its two independent signals. */
interface TopologyResult {
  /** Grid materially wider than the widest Markdown table — the fragmentation signature. */
  widthDivergence: boolean;
  /** Table counts disagree — on its own most often a benign page-break split. */
  countMismatch: boolean;
  evidence: TableStructureEvidence[];
}

/** Result of a check that either fires or does not, with its supporting evidence. */
interface SignalResult {
  fired: boolean;
  evidence: TableStructureEvidence[];
}

export class TableStructureDetector {
  /**
   * Read a converted source's Markdown and structural sidecar from disk and
   * analyze them. Never throws — unreadable files degrade to empty inputs.
   */
  public async analyzeSource(input: TableStructureSourceInput): Promise<TableStructureFinding> {
    const markdown = await this.readTextSafe(input.derivedTextPath);
    const sidecar = await this.readJsonSafe(input.derivedDoclingJsonPath);
    return this.analyze(basename(input.path), input.path, markdown, sidecar);
  }

  /**
   * Analyze a single document's converted outputs. Pure and total — the caller
   * passes the rendered Markdown and the parsed sidecar envelope (the opaque
   * docling `document` object), and gets back a rating with evidence.
   */
  public analyze(
    source: string,
    path: string,
    markdown: string,
    sidecar: unknown,
  ): TableStructureFinding {
    const structured = parseStructuredTables(sidecar);
    const markdownTables = parseMarkdownTables(markdown);

    // Two families of signal. Structural signals (topology width-divergence,
    // structured-grid rectangularity) can stand on their own; content signals
    // (column-homogeneity, fragment-adjacency) only corroborate — on a clean
    // table they fire on legitimate data, so they must never elevate the rating
    // without a structural signal already present.
    const topology = this.checkTopology(structured, markdownTables);
    const structuredRect = this.checkStructuredRectangularity(structured);
    const homogeneity = this.checkColumnHomogeneity(structured, markdownTables);
    const adjacency = this.checkFragmentAdjacency(structured, markdownTables);

    const corroborated = homogeneity.fired || adjacency.fired || structuredRect.fired;

    // `corrupt` needs two independent signals, one of them width-divergence.
    // A lone structural signal is `suspect`. Content signals alone stay `clean`.
    let rating: TableStructureRating;
    if (topology.widthDivergence && corroborated) {
      rating = 'corrupt';
    } else if (topology.widthDivergence || structuredRect.fired || topology.countMismatch) {
      rating = 'suspect';
    } else {
      rating = 'clean';
    }

    // Assemble evidence in strongest-first order. Content evidence is included
    // only when width-divergence corroborates it — otherwise it is suppressed
    // along with its (non-)contribution to the rating.
    const evidence: TableStructureEvidence[] = [...topology.evidence, ...structuredRect.evidence];
    if (topology.widthDivergence) {
      evidence.push(...homogeneity.evidence, ...adjacency.evidence);
    }

    return {
      source,
      path,
      rating,
      structuredTableCount: structured.length,
      markdownTableCount: markdownTables.length,
      examples: evidence.slice(0, MAX_EXAMPLES),
    };
  }

  private async readTextSafe(filePath?: string): Promise<string> {
    if (!filePath) return '';
    try {
      return await readFile(filePath, 'utf-8');
    } catch {
      return '';
    }
  }

  private async readJsonSafe(filePath?: string): Promise<unknown> {
    if (!filePath) return undefined;
    try {
      const raw = await readFile(filePath, 'utf-8');
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  }

  // ── Structural signal: Markdown ⇄ grid topology ─────────────────

  /**
   * Compare the structural grid against the rendered Markdown for the two
   * independent topology signals. Width-divergence (grid materially wider than
   * the widest Markdown table) is the fragmentation signature and is strong; a
   * bare table-count mismatch is weak (usually a page-break split). Column spans
   * are tolerated via {@link COL_DIVERGENCE} and {@link WIDTH_RATIO} so a faithful
   * spanned table does not read as divergent.
   */
  private checkTopology(structured: StructuredTable[], markdown: MarkdownTable[]): TopologyResult {
    const evidence: TableStructureEvidence[] = [];

    // Both sides must carry tables for a comparison to mean anything.
    if (structured.length === 0 || markdown.length === 0) {
      return { widthDivergence: false, countMismatch: false, evidence };
    }

    const gridCols = Math.max(...structured.map(t => t.numCols));
    const markdownCols = Math.max(...markdown.map(t => t.header.length));

    const widthDivergence =
      markdownCols > 0 &&
      gridCols - markdownCols >= COL_DIVERGENCE &&
      gridCols >= markdownCols * WIDTH_RATIO;
    const countMismatch = structured.length !== markdown.length;

    if (widthDivergence) {
      evidence.push({
        check: 'topology',
        detail:
          `Widest structural table has ${gridCols} columns but the widest Markdown table has ${markdownCols}; ` +
          `a wide grid collapsing to narrow Markdown tables is the merged-column fragmentation signature.`,
      });
    }
    if (countMismatch) {
      evidence.push({
        check: 'topology',
        detail:
          `Structural grid holds ${structured.length} table(s) but the Markdown rendered ${markdown.length}.` +
          (widthDivergence ? '' : ' With comparable column widths this is most likely a benign page-break split.'),
      });
    }

    return { widthDivergence, countMismatch, evidence };
  }

  // ── Structural signal: grid row rectangularity ──────────────────

  /**
   * Flag structural-grid rows whose cell count disagrees with the declared
   * `num_cols`. Only the real 2-D `data.grid` is trusted — the flat-cell
   * fallback reconstructs a padded rectangle, so its rows are rectangular by
   * construction and a trailing-empty column would otherwise read as ragged.
   */
  private checkStructuredRectangularity(structured: StructuredTable[]): SignalResult {
    const evidence: TableStructureEvidence[] = [];
    let fired = false;

    for (const table of structured) {
      if (!table.fromGrid) continue;
      if (table.numCols <= 0 || table.rows.length === 0) continue;
      const ragged = table.rows.filter(r => r.length !== table.numCols);
      if (ragged.length === 0) continue;
      fired = true;
      for (const row of ragged.slice(0, 3)) {
        evidence.push({
          check: 'rectangularity',
          detail: `Structural grid row has ${row.length} cells but the table declares ${table.numCols} columns.`,
        });
      }
    }

    return { fired, evidence };
  }

  // ── Corroborating signal: per-column value homogeneity ──────────

  /**
   * Corroborating only: a prose value sitting in a column otherwise made of
   * short codes. The header row is excluded on both the grid and Markdown paths
   * — a multi-word column header (e.g. "General Residential Zone") is not a
   * misplaced prose value.
   */
  private checkColumnHomogeneity(structured: StructuredTable[], markdown: MarkdownTable[]): SignalResult {
    const evidence: TableStructureEvidence[] = [];
    let fired = false;

    // Prefer the structural grid (clean cell text); fall back to Markdown. Body
    // rows only — the grid's first row is its header, and Markdown `rows` already
    // excludes the header.
    const tables: Array<{ numCols: number; body: string[][] }> =
      structured.length > 0
        ? structured.map(t => ({ numCols: t.numCols, body: t.rows.slice(1) }))
        : markdown.map(t => ({ numCols: t.header.length, body: t.rows }));

    for (const table of tables) {
      const colCount = table.numCols > 0
        ? table.numCols
        : Math.max(0, ...table.body.map(r => r.length));
      for (let c = 0; c < colCount; c++) {
        const values: string[] = [];
        for (const row of table.body) {
          const cell = row[c];
          if (cell !== undefined && cell.trim().length > 0) values.push(cell.trim());
        }
        if (values.length < 3) continue;

        const codes = values.filter(v => v.length <= CODE_MAX_LEN);
        if (codes.length / values.length < CODE_COLUMN_RATIO) continue;

        const prose = values.filter(v => v.length >= PROSE_MIN_LEN || wordCount(v) >= 3);
        if (prose.length === 0) continue;

        fired = true;
        for (const cell of prose.slice(0, 3)) {
          evidence.push({
            check: 'column-homogeneity',
            detail:
              `Column ${c} is otherwise short codes (e.g. "${codes[0]}") but carries a prose value "${cell}" — ` +
              `a deferral or spillover scattered into the wrong column.`,
          });
        }
      }
    }

    return { fired, evidence };
  }

  // ── Corroborating signal: fragment adjacency (split cells) ──────

  /**
   * Corroborating only: adjacent cells whose concatenation reconstructs a phrase
   * that appears intact elsewhere in the same table — the signature of a single
   * cell split across neighbours.
   */
  private checkFragmentAdjacency(structured: StructuredTable[], markdown: MarkdownTable[]): SignalResult {
    const evidence: TableStructureEvidence[] = [];
    let fired = false;

    const tableRows: string[][][] =
      structured.length > 0
        ? structured.map(t => t.rows)
        : markdown.map(t => [t.header, ...t.rows]);

    for (const rows of tableRows) {
      // Intact multi-word cells that a split pair could reconstruct.
      const intact = new Set<string>();
      for (const row of rows) {
        for (const cell of row) {
          const norm = normalize(cell);
          if (wordCount(norm) >= 3) intact.add(norm);
        }
      }
      if (intact.size === 0) continue;

      for (const row of rows) {
        for (let i = 0; i + 1 < row.length; i++) {
          const a = (row[i] ?? '').trim();
          const b = (row[i + 1] ?? '').trim();
          if (a.length === 0 || b.length === 0) continue;

          const pair = normalize(`${a} ${b}`);
          if (
            intact.has(pair) &&
            pair !== normalize(a) &&
            pair !== normalize(b)
          ) {
            fired = true;
            evidence.push({
              check: 'fragment-adjacency',
              detail: `Adjacent cells "${a}" + "${b}" reconstruct "${a} ${b}", which appears intact elsewhere in the table — a split cell.`,
            });
            continue;
          }

          const c = (row[i + 2] ?? '').trim();
          if (c.length === 0) continue;
          const triple = normalize(`${a} ${b} ${c}`);
          if (intact.has(triple) && triple !== pair) {
            fired = true;
            evidence.push({
              check: 'fragment-adjacency',
              detail: `Adjacent cells "${a}" + "${b}" + "${c}" reconstruct "${a} ${b} ${c}", which appears intact elsewhere in the table — a split cell.`,
            });
          }
        }
      }
    }

    return { fired, evidence };
  }
}

/**
 * Turn a detector finding into a non-blocking recommendation, gated on the
 * options the source was last converted with. A suspect/corrupt table under
 * default options earns an executable re-convert; the same table already
 * converted with `tableCellMatching` disabled earns only a note that the flag
 * did not resolve it, so the advice never loops. A clean finding earns nothing.
 */
export function buildTableCorruptionRecommendation(
  finding: TableStructureFinding,
  convertOptionsUsed: DoclingConvertOptions | undefined,
): TableCorruptionRecommendation | undefined {
  if (finding.rating === 'clean') return undefined;

  const alreadyDisabled = convertOptionsUsed?.tableCellMatching === false;

  if (alreadyDisabled) {
    return {
      source: finding.source,
      path: finding.path,
      rating: finding.rating,
      message:
        `Table structure in "${finding.source}" still looks ${finding.rating} even though it was already converted ` +
        `with tableCellMatching disabled. The flag did not resolve it; this table needs manual review or ` +
        `structure-aware extraction rather than another re-convert.`,
      evidence: finding.examples,
    };
  }

  return {
    source: finding.source,
    path: finding.path,
    rating: finding.rating,
    message:
      `Table structure in "${finding.source}" looks ${finding.rating} under default conversion options. ` +
      `Re-convert this one file with tableCellMatching disabled, then reset it to pending and re-extract.`,
    evidence: finding.examples,
    remediation: {
      tool: 'indexing_update',
      args: {
        source: finding.source,
        sourceConvertOptions: { tableCellMatching: false },
      },
      description:
        `Step 1 of the fix (re-convert): this call re-converts "${finding.source}" with table_cell_matching ` +
        `disabled — stopping docling matching table predictions back to raw PDF cells, the behaviour that ` +
        `fragments merged/dense columns. It is not the whole fix: after it completes, reset the source to ` +
        `pending and re-extract that one file. Conversion is the fix site, not extraction.`,
    },
  };
}

// ── Structured-grid parsing (defensive) ───────────────────────────

function parseStructuredTables(sidecar: unknown): StructuredTable[] {
  const envelope = resolveRecord(sidecar);
  if (!envelope) return [];
  const jsonContent = resolveRecord(envelope['json_content']);
  if (!jsonContent) return [];
  const rawTables = jsonContent['tables'];
  if (!Array.isArray(rawTables)) return [];

  const tables: StructuredTable[] = [];
  for (const raw of rawTables) {
    const table = parseStructuredTable(raw);
    if (table) tables.push(table);
  }
  return tables;
}

function parseStructuredTable(raw: unknown): StructuredTable | undefined {
  const table = resolveRecord(raw);
  if (!table) return undefined;
  const data = resolveRecord(table['data']);

  const numCols = firstNumber(table['num_cols'], data?.['num_cols']) ?? 0;
  const numRows = firstNumber(table['num_rows'], data?.['num_rows']) ?? 0;

  let rows: string[][] = [];
  let fromGrid = false;
  const grid = data?.['grid'];
  if (Array.isArray(grid)) {
    for (const gridRow of grid) {
      if (!Array.isArray(gridRow)) continue;
      rows.push(gridRow.map(cell => cellText(cell)));
    }
    if (rows.length > 0) fromGrid = true;
  }

  // Fall back to the flat cell list, reconstructing a grid from cell offsets.
  // Rows from this path are padded rectangles, so they are excluded from the
  // rectangularity signal via `fromGrid`.
  if (rows.length === 0 && data) {
    rows = gridFromFlatCells(data['table_cells']);
  }

  return {
    numRows: numRows > 0 ? numRows : rows.length,
    numCols: numCols > 0 ? numCols : (rows[0]?.length ?? 0),
    rows,
    fromGrid,
  };
}

/**
 * Reconstruct a 2-D grid from docling's flat `table_cells` list using each
 * cell's start row/column offsets. Best-effort — cells with missing offsets are
 * skipped rather than throwing.
 */
function gridFromFlatCells(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  const placed: Array<{ row: number; col: number; text: string }> = [];
  let maxRow = 0;
  let maxCol = 0;
  for (const raw of value) {
    const cell = resolveRecord(raw);
    if (!cell) continue;
    const row = firstNumber(cell['start_row_offset_idx']);
    const col = firstNumber(cell['start_col_offset_idx']);
    if (row === undefined || col === undefined) continue;
    placed.push({ row, col, text: cellText(cell) });
    if (row > maxRow) maxRow = row;
    if (col > maxCol) maxCol = col;
  }
  if (placed.length === 0) return [];

  const rows: string[][] = Array.from({ length: maxRow + 1 }, () =>
    Array.from({ length: maxCol + 1 }, () => ''),
  );
  for (const cell of placed) {
    const target = rows[cell.row];
    if (target) target[cell.col] = cell.text;
  }
  return rows;
}

function cellText(cell: unknown): string {
  if (typeof cell === 'string') return cell.trim();
  const rec = resolveRecord(cell);
  if (!rec) return '';
  const text = rec['text'];
  return typeof text === 'string' ? text.trim() : '';
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

// ── GFM pipe-table parsing ─────────────────────────────────────────

function parseMarkdownTables(md: string): MarkdownTable[] {
  if (md.length === 0) return [];
  const lines = md.split(/\r?\n/);
  const tables: MarkdownTable[] = [];

  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const delimiter = lines[i + 1];
    if (
      header !== undefined &&
      delimiter !== undefined &&
      isTableRow(header) &&
      isDelimiterRow(delimiter)
    ) {
      const headerCells = splitRow(header);
      i += 2;
      const rows: string[][] = [];
      for (; i < lines.length; i++) {
        const row = lines[i];
        if (row === undefined || !isTableRow(row)) break;
        rows.push(splitRow(row));
      }
      tables.push({ header: headerCells, rows });
    } else {
      i++;
    }
  }
  return tables;
}

function isTableRow(line: string): boolean {
  return line.includes('|');
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  return cells.every(c => /^:?-+:?$/.test(c.trim()));
}

function splitRow(line: string): string[] {
  const s = line.trim();
  const parts: string[] = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && s[k + 1] === '|') {
      cur += '|';
      k++;
      continue;
    }
    if (ch === '|') {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  parts.push(cur);

  // Drop the empty leading/trailing cells produced by surrounding pipes.
  const first = parts[0];
  if (first !== undefined && first.trim() === '') parts.shift();
  const last = parts[parts.length - 1];
  if (last !== undefined && last.trim() === '') parts.pop();

  return parts.map(p => p.trim());
}

// ── Shared helpers ─────────────────────────────────────────────────

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}
