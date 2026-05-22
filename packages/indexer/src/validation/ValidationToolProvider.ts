import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { LLMToolDefinition } from '../providers/LLMProvider.js';
import type { ValidationToolCall, ValidationToolResult } from './full-validation-types.js';

export type { LLMToolDefinition as ToolDefinition };

/** Search result from searching a source document */
interface SearchMatch {
  lineNumber: number;
  text: string;
  context: string[];
}

/** Heading found in a source document */
interface SourceHeading {
  level: number;
  text: string;
  lineNumber: number;
}

/**
 * Provides source document navigation tools to the validation worker LLM.
 *
 * Each tool maps to a function that reads/searches source documents.
 * The provider caches loaded documents to avoid redundant I/O within
 * a batch validation run.
 */
export class ValidationToolProvider {
  /** Cache of loaded source documents: path → lines */
  private readonly documentCache = new Map<string, string[]>();

  constructor(
    /** Primary source document path for the current batch */
    private readonly primarySourcePath: string,
    /** All source paths in the indexing process (for read_other_source) */
    private readonly allSourcePaths: string[],
  ) {}

  /**
   * Tool definitions for the LLM (Anthropic tool_use format).
   */
  static getToolDefinitions(): LLMToolDefinition[] {
    return [
      {
        name: 'read_source_lines',
        description: 'Read specific lines from the entity\'s source document. Line numbers are 1-indexed.',
        input_schema: {
          type: 'object' as const,
          properties: {
            lineStart: { type: 'number', description: 'Start line number (1-indexed, inclusive)' },
            lineEnd: { type: 'number', description: 'End line number (1-indexed, inclusive)' },
          },
          required: ['lineStart', 'lineEnd'],
        },
      },
      {
        name: 'search_source',
        description: 'Search for a term or pattern in the source document. Returns matching lines with surrounding context. Use this to find additional mentions of an entity or value.',
        input_schema: {
          type: 'object' as const,
          properties: {
            query: { type: 'string', description: 'Search term or regex pattern' },
            maxResults: { type: 'number', description: 'Maximum number of matches to return (default: 5)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'read_source_section',
        description: 'Read a named section/heading from the source document. Use list_source_headings first to discover available sections.',
        input_schema: {
          type: 'object' as const,
          properties: {
            heading: { type: 'string', description: 'Section heading text to match (case-insensitive partial match)' },
          },
          required: ['heading'],
        },
      },
      {
        name: 'list_source_headings',
        description: 'List all headings/sections in the source document. Returns heading level, text, and line number.',
        input_schema: {
          type: 'object' as const,
          properties: {},
          required: [],
        },
      },
      {
        name: 'read_other_source',
        description: 'Read lines from a different source document in this indexing process. Use this for cross-reference validation when an entity spans multiple source documents.',
        input_schema: {
          type: 'object' as const,
          properties: {
            sourceFilename: { type: 'string', description: 'Filename of the other source document' },
            lineStart: { type: 'number', description: 'Start line number (1-indexed, inclusive)' },
            lineEnd: { type: 'number', description: 'End line number (1-indexed, inclusive)' },
          },
          required: ['sourceFilename', 'lineStart', 'lineEnd'],
        },
      },
    ];
  }

  /**
   * Execute a tool call and return the result.
   */
  async executeTool(toolCallId: string, call: ValidationToolCall): Promise<ValidationToolResult> {
    try {
      switch (call.name) {
        case 'read_source_lines':
          return {
            toolCallId,
            content: await this.readSourceLines(
              call.input['lineStart'] as number,
              call.input['lineEnd'] as number,
            ),
          };

        case 'search_source':
          return {
            toolCallId,
            content: await this.searchSource(
              call.input['query'] as string,
              (call.input['maxResults'] as number | undefined) ?? 5,
            ),
          };

        case 'read_source_section':
          return {
            toolCallId,
            content: await this.readSourceSection(
              call.input['heading'] as string,
            ),
          };

        case 'list_source_headings':
          return {
            toolCallId,
            content: await this.listSourceHeadings(),
          };

        case 'read_other_source':
          return {
            toolCallId,
            content: await this.readOtherSource(
              call.input['sourceFilename'] as string,
              call.input['lineStart'] as number,
              call.input['lineEnd'] as number,
            ),
          };

        default:
          return {
            toolCallId,
            content: `Unknown tool: ${call.name}`,
            isError: true,
          };
      }
    } catch (error) {
      return {
        toolCallId,
        content: `Tool error: ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      };
    }
  }

  // ── Tool Implementations ────────────────────────────────────────────

  private async readSourceLines(lineStart: number, lineEnd: number): Promise<string> {
    const lines = await this.getDocumentLines(this.primarySourcePath);
    const clampedStart = Math.max(1, lineStart);
    const clampedEnd = Math.min(lines.length, lineEnd);

    if (clampedStart > lines.length) {
      return `No content: document has ${lines.length} lines, requested start line ${lineStart}`;
    }

    const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
    return selectedLines
      .map((line, i) => `${clampedStart + i}: ${line}`)
      .join('\n');
  }

  private async searchSource(query: string, maxResults: number): Promise<string> {
    const lines = await this.getDocumentLines(this.primarySourcePath);
    const matches: SearchMatch[] = [];

    let regex: RegExp;
    try {
      regex = new RegExp(query, 'i');
    } catch {
      // Fall back to literal string match if regex is invalid
      regex = new RegExp(escapeRegex(query), 'i');
    }

    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i]!)) {
        const contextStart = Math.max(0, i - 2);
        const contextEnd = Math.min(lines.length, i + 3);
        matches.push({
          lineNumber: i + 1,
          text: lines[i]!,
          context: lines.slice(contextStart, contextEnd).map(
            (line, j) => `${contextStart + j + 1}: ${line}`,
          ),
        });

        if (matches.length >= maxResults) break;
      }
    }

    if (matches.length === 0) {
      return `No matches found for "${query}" in the source document.`;
    }

    return matches.map(m =>
      `Match at line ${m.lineNumber}:\n${m.context.join('\n')}`,
    ).join('\n\n');
  }

  private async readSourceSection(heading: string): Promise<string> {
    const lines = await this.getDocumentLines(this.primarySourcePath);
    const headings = extractHeadings(lines);

    // Find the best matching heading (case-insensitive partial match)
    const lowerHeading = heading.toLowerCase();
    const match = headings.find(h => h.text.toLowerCase().includes(lowerHeading));

    if (!match) {
      return `No section found matching "${heading}". Use list_source_headings to see available sections.`;
    }

    // Find the end of this section (next heading at same or higher level)
    const startLine = match.lineNumber;
    let endLine = lines.length;

    for (const h of headings) {
      if (h.lineNumber > startLine && h.level <= match.level) {
        endLine = h.lineNumber - 1;
        break;
      }
    }

    // Cap section output at 100 lines to avoid overwhelming the context
    const maxLines = 100;
    const actualEnd = Math.min(endLine, startLine + maxLines - 1);
    const selectedLines = lines.slice(startLine - 1, actualEnd);
    const truncated = actualEnd < endLine;

    let result = selectedLines
      .map((line, i) => `${startLine + i}: ${line}`)
      .join('\n');

    if (truncated) {
      result += `\n\n[Section truncated — showing lines ${startLine}-${actualEnd} of ${startLine}-${endLine}. Use read_source_lines to read more.]`;
    }

    return result;
  }

  private async listSourceHeadings(): Promise<string> {
    const lines = await this.getDocumentLines(this.primarySourcePath);
    const headings = extractHeadings(lines);

    if (headings.length === 0) {
      return 'No headings found in the source document.';
    }

    return headings
      .map(h => `${'  '.repeat(h.level - 1)}${h.text} (line ${h.lineNumber})`)
      .join('\n');
  }

  private async readOtherSource(
    sourceFilename: string,
    lineStart: number,
    lineEnd: number,
  ): Promise<string> {
    // Find the matching source path
    const lowerFilename = sourceFilename.toLowerCase();
    const matchedPath = this.allSourcePaths.find(p => {
      const filename = basename(p).toLowerCase();
      return filename === lowerFilename || filename.includes(lowerFilename);
    });

    if (!matchedPath) {
      const available = this.allSourcePaths.map(p => basename(p)).join(', ');
      return `Source document "${sourceFilename}" not found. Available sources: ${available}`;
    }

    const lines = await this.getDocumentLines(matchedPath);
    const clampedStart = Math.max(1, lineStart);
    const clampedEnd = Math.min(lines.length, lineEnd);

    if (clampedStart > lines.length) {
      return `No content: document has ${lines.length} lines, requested start line ${lineStart}`;
    }

    const selectedLines = lines.slice(clampedStart - 1, clampedEnd);
    const filename = basename(matchedPath);
    return `[${filename}, lines ${clampedStart}-${clampedEnd}]\n` +
      selectedLines.map((line, i) => `${clampedStart + i}: ${line}`).join('\n');
  }

  // ── Document Cache ──────────────────────────────────────────────────

  private async getDocumentLines(path: string): Promise<string[]> {
    let lines = this.documentCache.get(path);
    if (!lines) {
      const content = await readFile(path, 'utf-8');
      lines = content.split('\n');
      this.documentCache.set(path, lines);
    }
    return lines;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────

/** Extract markdown headings from document lines */
function extractHeadings(lines: string[]): SourceHeading[] {
  const headings: SourceHeading[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^(#{1,6})\s+(.+)/);
    if (match) {
      headings.push({
        level: match[1]!.length,
        text: match[2]!.trim(),
        lineNumber: i + 1,
      });
    }
  }
  return headings;
}

/** Escape special regex characters in a string */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

