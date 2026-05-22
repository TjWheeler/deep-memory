import { basename } from 'node:path';
import type { IndexSource } from '../types/source-list.js';

/**
 * A logical segment of a document — may be a heading-based chapter,
 * a page-delimited section, or a paragraph-boundary chunk.
 */
export interface Chapter {
  /** Zero-based index within the document */
  index: number;
  /** A label for this segment — heading text, page range, or "Segment N" */
  heading: string;
  /** Heading level (1-3 for markdown headings, 0 for non-heading segments) */
  headingLevel: number;
  /** Raw content (without line numbers) */
  content: string;
  /** 1-indexed line number where this segment begins in the original document */
  lineStart: number;
  /** 1-indexed line number where this segment ends in the original document */
  lineEnd: number;
}

/**
 * A concise overview of the document structure, passed as context to each extraction.
 */
export interface DocumentOverview {
  /** Document title — first heading, or filename */
  title: string;
  /** Segment/heading structure summary */
  headingStructure: string;
  /** Source path and type metadata */
  metadata: string;
  /** Total number of segments */
  totalChapters: number;
}

const ATX_HEADING_RE = /^(#{1,3})\s+(.+)$/;
const SETEXT_H1_RE = /^={3,}\s*$/;
const SETEXT_H2_RE = /^-{3,}\s*$/;
const PAGE_MARKER_RE = /^--\s*\d+\s+of\s+\d+\s*--$/;

// ── Split boundary detection ───────────────────────────────────────

interface SplitPoint {
  /** Line index (0-based) where this boundary occurs */
  lineIndex: number;
  /** Priority: higher = better place to split. Headings > pages > blank gaps > paragraphs */
  priority: number;
  /** Label for the segment starting at this point */
  label: string;
  /** Heading level if this is a heading boundary, 0 otherwise */
  level: number;
}

/**
 * Scan a document for all potential split points, ranked by priority.
 */
function findSplitPoints(lines: string[]): SplitPoint[] {
  const points: SplitPoint[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // ATX headings (# ## ###) — highest priority
    const atxMatch = ATX_HEADING_RE.exec(line);
    if (atxMatch) {
      points.push({
        lineIndex: i,
        priority: 40 - atxMatch[1]!.length * 10, // H1=30, H2=20, H3=10
        label: line,
        level: atxMatch[1]!.length,
      });
      continue;
    }

    // Setext headings (underline with === or ---)
    if (i > 0) {
      const prevLine = lines[i - 1]!.trim();
      if (prevLine.length > 0) {
        if (SETEXT_H1_RE.test(trimmed)) {
          points.push({ lineIndex: i - 1, priority: 30, label: `# ${prevLine}`, level: 1 });
          continue;
        }
        if (SETEXT_H2_RE.test(trimmed)) {
          points.push({ lineIndex: i - 1, priority: 20, label: `## ${prevLine}`, level: 2 });
          continue;
        }
      }
    }

    // Page markers (-- N of M --) — medium-high priority
    if (PAGE_MARKER_RE.test(trimmed)) {
      points.push({ lineIndex: i, priority: 15, label: trimmed, level: 0 });
      continue;
    }

    // Blank line gaps (2+ consecutive blank lines) — medium priority
    if (trimmed === '' && i > 0 && lines[i - 1]!.trim() === '') {
      // Only mark the start of a blank gap
      if (i < 2 || lines[i - 2]!.trim() !== '') {
        points.push({ lineIndex: i, priority: 5, label: '', level: 0 });
      }
    }
  }

  return points;
}

// ── Main splitting logic ───────────────────────────────────────────

/**
 * Split a document into logical segments for progressive extraction.
 *
 * Uses a cascading strategy:
 * 1. If markdown headings exist, split on headings
 * 2. Otherwise split on page markers, blank line gaps, or paragraph boundaries
 * 3. Segments smaller than MIN_SEGMENT_CHARS are merged with the next segment
 * 4. Segments larger than maxChunkSize are sub-split at the best available boundary
 *
 * @param content The full document text
 * @param maxChunkSize Maximum characters per segment (default 30,000)
 */
export function splitIntoChapters(content: string, maxChunkSize: number = 30_000): Chapter[] {
  const lines = content.split('\n');
  if (lines.length === 0) return [];

  const splitPoints = findSplitPoints(lines);

  // If no meaningful split points, return the whole document as one segment
  if (splitPoints.length === 0) {
    return [{
      index: 0,
      heading: 'Document',
      headingLevel: 0,
      content,
      lineStart: 1,
      lineEnd: lines.length,
    }];
  }

  // Choose the best split tier: use the highest-priority points that produce
  // reasonable segment sizes. Start with headings, fall back to pages, then gaps.
  const tiers = [
    splitPoints.filter(p => p.priority >= 20),  // H1 + H2 headings
    splitPoints.filter(p => p.priority >= 10),  // + H3 headings
    splitPoints.filter(p => p.priority >= 15),  // page markers (without headings)
    splitPoints.filter(p => p.priority >= 5),   // + blank gaps
    splitPoints,                                 // everything
  ];

  // Pick the first tier that produces at least 2 split points
  let chosen = splitPoints;
  for (const tier of tiers) {
    if (tier.length >= 2) {
      chosen = tier;
      break;
    }
  }

  // Sort by line position
  chosen.sort((a, b) => a.lineIndex - b.lineIndex);

  // Build raw segments from split points
  const rawSegments: Chapter[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const start = chosen[i]!.lineIndex;
    const end = i + 1 < chosen.length ? chosen[i + 1]!.lineIndex : lines.length;
    const segmentLines = lines.slice(start, end);
    const content = segmentLines.join('\n');

    rawSegments.push({
      index: i,
      heading: chosen[i]!.label || `Segment ${i + 1}`,
      headingLevel: chosen[i]!.level,
      content,
      lineStart: start + 1, // 1-indexed
      lineEnd: end,         // 1-indexed (exclusive becomes inclusive of last line)
    });
  }

  // Handle preamble — content before the first split point
  if (chosen[0]!.lineIndex > 0) {
    const preambleLines = lines.slice(0, chosen[0]!.lineIndex);
    const preambleContent = preambleLines.join('\n').trimEnd();
    if (preambleContent.length > 0) {
      rawSegments.unshift({
        index: 0,
        heading: 'Preamble',
        headingLevel: 0,
        content: preambleContent,
        lineStart: 1,
        lineEnd: chosen[0]!.lineIndex,
      });
    }
  }

  // Greedily merge consecutive segments up to maxChunkSize.
  // This ensures we produce the fewest segments possible while respecting the size limit.
  const merged: Chapter[] = [];
  let accumulator: Chapter | null = null;

  for (const seg of rawSegments) {
    if (!accumulator) {
      accumulator = { ...seg };
      continue;
    }

    const combinedSize = accumulator.content.length + 1 + seg.content.length;
    if (combinedSize <= maxChunkSize) {
      // Merge — still fits within budget
      accumulator.content += '\n' + seg.content;
      accumulator.lineEnd = seg.lineEnd;
    } else {
      // Emit current accumulator, start new one
      merged.push(accumulator);
      accumulator = { ...seg };
    }
  }
  if (accumulator) {
    merged.push(accumulator);
  }

  // Sub-split any segment that exceeds maxChunkSize
  const final: Chapter[] = [];
  for (const seg of merged) {
    if (seg.content.length <= maxChunkSize) {
      final.push(seg);
    } else {
      // Split oversized segment at the best available internal boundaries
      const subSegments = subSplitSegment(seg, maxChunkSize);
      final.push(...subSegments);
    }
  }

  // Re-index
  for (let i = 0; i < final.length; i++) {
    final[i]!.index = i;
  }

  return final;
}

/**
 * Sub-split an oversized segment at internal boundaries (blank gaps, page markers).
 * Falls back to splitting at paragraph boundaries if no better points exist.
 */
function subSplitSegment(segment: Chapter, maxChunkSize: number): Chapter[] {
  const lines = segment.content.split('\n');
  const internalPoints = findSplitPoints(lines);

  // Filter to points that would create segments within budget
  // Use a greedy approach: accumulate lines until we'd exceed the limit,
  // then split at the best boundary within the accumulated range.
  const result: Chapter[] = [];
  let chunkStart = 0;
  let chunkChars = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineChars = lines[i]!.length + 1;

    if (chunkChars + lineChars > maxChunkSize && chunkStart < i) {
      // Find the best split point within [chunkStart, i]
      const bestPoint = internalPoints
        .filter(p => p.lineIndex > chunkStart && p.lineIndex <= i)
        .sort((a, b) => b.priority - a.priority)[0];

      const splitAt = bestPoint ? bestPoint.lineIndex : i;
      const chunkContent = lines.slice(chunkStart, splitAt).join('\n');

      result.push({
        index: result.length,
        heading: result.length === 0 ? segment.heading : `${segment.heading} (continued)`,
        headingLevel: segment.headingLevel,
        content: chunkContent,
        lineStart: segment.lineStart + chunkStart,
        lineEnd: segment.lineStart + splitAt - 1,
      });

      chunkStart = splitAt;
      chunkChars = lines.slice(splitAt, i + 1).reduce((sum, l) => sum + l.length + 1, 0);
    } else {
      chunkChars += lineChars;
    }
  }

  // Emit final chunk
  if (chunkStart < lines.length) {
    const chunkContent = lines.slice(chunkStart).join('\n');
    result.push({
      index: result.length,
      heading: result.length === 0 ? segment.heading : `${segment.heading} (continued)`,
      headingLevel: segment.headingLevel,
      content: chunkContent,
      lineStart: segment.lineStart + chunkStart,
      lineEnd: segment.lineStart + lines.length - 1,
    });
  }

  return result;
}

// ── Overview generation ────────────────────────────────────────────

/**
 * Generate a concise document overview from the segment structure.
 */
export function generateOverview(source: IndexSource, chapters: Chapter[]): DocumentOverview {
  const filename = basename(source.path);

  // Title: first heading, or filename
  const firstHeading = chapters.find(c => c.headingLevel > 0);
  const title = firstHeading
    ? firstHeading.heading.replace(/^#+\s+/, '')
    : filename;

  // Build structure summary — show headings if available, otherwise segment labels
  const structureLines: string[] = [];
  for (const ch of chapters) {
    if (ch.headingLevel > 0) {
      const indent = '  '.repeat(ch.headingLevel - 1);
      const clean = ch.heading.replace(/^#+\s+/, '');
      structureLines.push(`${indent}${clean}`);
    } else if (ch.heading !== 'Preamble') {
      structureLines.push(ch.heading);
    }
  }
  const headingStructure = structureLines.length > 0
    ? structureLines.join('\n')
    : `${chapters.length} segments (no heading structure detected)`;

  const metadata = `Path: ${source.path}\nType: ${source.type}${source.notes ? `\nNotes: ${source.notes}` : ''}`;

  return {
    title,
    headingStructure,
    metadata,
    totalChapters: chapters.length,
  };
}

/**
 * Add line numbers to chapter content for sourceRef tracking.
 * Line numbers are absolute (based on the chapter's position in the original document).
 */
export function addChapterLineNumbers(chapter: Chapter): string {
  return chapter.content
    .split('\n')
    .map((line, i) => `${chapter.lineStart + i}\t${line}`)
    .join('\n');
}

/**
 * Returns true if the document has enough structure to benefit from
 * progressive extraction (headings, page markers, or sufficient size).
 */
export function isMarkdownStructured(content: string): boolean {
  const points = findSplitPoints(content.split('\n'));
  return points.length >= 2;
}
