/**
 * Index source list types — tracks which documents have been indexed and their status.
 */

/** The complete source document inventory */
export interface IndexSourceList {
  version: string;
  repositoryId: string;
  sources: IndexSource[];
}

/** A single source document in the inventory */
export interface IndexSource {
  /** Path to the source document (relative to project root) */
  path: string;
  /** Document type (e.g., "spec-sheet", "om-manual", "performance-handbook") */
  type: string;
  /** Processing status */
  status: IndexSourceStatus;
  /** Per-worker extraction output file paths: { workerName: "extraction-notes/workerName/file.json" } */
  extractionFiles?: Record<string, string>;
  /** Path to the selected extraction output for downstream phases (set during extraction-review) */
  selectedExtraction?: string;
  /** Human-readable notes about the document */
  notes?: string;
  /** Workers assigned to extract this source */
  assignedWorkers?: string[];
  /** Estimated token usage for this document (set by analyze phase) */
  estimatedTokens?: DocumentTokenEstimate;
  /** Actual token usage from LLM response (set after extraction) */
  actualTokens?: { inputTokens: number; outputTokens: number };
  /** Total extraction processing time in milliseconds */
  processingTimeMs?: number;
  /** Last error message if extraction failed */
  lastError?: string;
  /** Number of extraction attempts */
  attempts?: number;
  /** Human-readable reason for the current status (especially useful for 'excluded') */
  statusReason?: string;
  /**
   * Absolute path to the derived text the extractor reads instead of the raw
   * source. Set when a binary/rich-format source has been converted to
   * Markdown. Absent for sources that are already plain text.
   */
  derivedTextPath?: string;
  /**
   * File extension of the original source (e.g. ".pdf", ".docx") when the
   * source needs conversion before extraction. Absent for plain-text sources.
   */
  originalFormat?: string;
}

/** Token usage estimate for a single document against its assigned worker */
export interface DocumentTokenEstimate {
  inputTokens: number;
  outputTokens: number;
  chunks: number;
}

/** Source document processing lifecycle */
export type IndexSourceStatus = 'needs-conversion' | 'converting' | 'pending' | 'extracting' | 'deduplicating' | 'extracted' | 'consolidated' | 'imported' | 'validated' | 'excluded';
