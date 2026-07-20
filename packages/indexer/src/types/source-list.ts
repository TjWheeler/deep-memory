/**
 * Index source list types — tracks which documents have been indexed and their status.
 */

import type { DoclingConvertOptions } from '../conversion/types.js';

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
  /**
   * sha256 of the raw source bytes at the last successful conversion. Used to
   * skip re-converting an unchanged source and to force reconversion when the
   * bytes on disk change. The digest matches the client's content-hash cache
   * key, so a hash computed here and one computed in the client agree.
   */
  sourceHash?: string;
  /**
   * Absolute path to the persisted structural JSON sidecar
   * (`state/converted/{slug}.docling.json`) written alongside the derived
   * Markdown. Retained as the structural substrate for later structure-aware
   * extraction. Absent for plain-text sources.
   */
  derivedDoclingJsonPath?: string;
  /**
   * Per-source OCR override. When set, it takes precedence over the global
   * `services.docling.doOcr` and the automatic text-yield heuristic — an
   * explicit decision, not a hint. Absent leaves the decision to the global
   * setting or the heuristic.
   */
  doOcr?: boolean;
  /**
   * Explicit per-source conversion overrides. When set, these take precedence
   * over the process-wide `services.docling.convertOptions` for this source —
   * an explicit decision, not a hint. Used to fix a single document whose
   * tables need different handling (e.g. `{ tableCellMatching: false }`).
   */
  sourceConvertOptions?: DoclingConvertOptions;
  /**
   * The effective conversion options actually used at the last successful
   * conversion (process default merged with any per-source override). Recorded
   * so the idempotency skip can reconvert when the effective options change,
   * not only when the source bytes change. Absent when the last conversion used
   * docling's defaults.
   */
  convertOptionsUsed?: DoclingConvertOptions;
  /**
   * Compact conversion diagnostics mirrored onto the entry so `indexing_status`
   * can surface per-doc timing/warnings without reading the full conversion
   * report. Populated by the convert step.
   */
  conversion?: {
    /** Wall-clock conversion time in milliseconds. */
    durationMs?: number;
    /** Page count read from the converted document. */
    pageCount?: number;
    /** Table count recovered from the converted document. */
    tableCount?: number;
    /** Whether OCR was applied to the final conversion. */
    ocrApplied?: boolean;
    /** Whether a low-yield first pass triggered a second OCR pass. */
    ocrFallbackApplied?: boolean;
    /** Warnings lifted from the conversion envelope. */
    warnings?: string[];
  };
}

/** Token usage estimate for a single document against its assigned worker */
export interface DocumentTokenEstimate {
  inputTokens: number;
  outputTokens: number;
  chunks: number;
}

/** Source document processing lifecycle */
export type IndexSourceStatus = 'needs-conversion' | 'converting' | 'pending' | 'extracting' | 'deduplicating' | 'extracted' | 'consolidated' | 'imported' | 'validated' | 'excluded';
