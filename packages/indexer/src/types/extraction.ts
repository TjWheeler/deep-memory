/**
 * Types for extraction worker output (Phase B).
 *
 * Each worker produces a self-contained ExtractionOutput for a single source document.
 * Entities and relationships are referenced by label (not GUID) — GUID assignment
 * happens during consolidation (Phase C).
 */

/** Metadata about LLM output truncation events during extraction */
export interface TruncationInfo {
  /** Number of LLM calls that were truncated (finish_reason: 'length') */
  truncatedChunks: number;
  /** Total LLM calls made for this document */
  totalChunks: number;
  /** Number of entities salvaged from truncated responses */
  entitiesSalvaged: number;
  /** Number of relationships salvaged from truncated responses */
  relationshipsSalvaged: number;
  /** Number of LLM calls where truncation occurred but salvage failed (data lost entirely) */
  unsalvageableChunks: number;
}

/** Complete output from an extraction worker for a single document */
export interface ExtractionOutput {
  /** Source document filename */
  source: string;
  /** Full path to the source document */
  sourcePath: string;
  /** ISO 8601 timestamp of extraction */
  extractedAt: string;
  /** Worker identifier */
  extractedBy: string;
  /** Entities extracted from the document */
  entities: ExtractedEntity[];
  /** Relationships extracted from the document */
  relationships: ExtractedRelationship[];
  /** Actual token usage from the LLM API (if reported) */
  usage?: { inputTokens: number; outputTokens: number };
  /** Truncation metadata — present when any LLM calls hit the output token limit */
  truncation?: TruncationInfo;
}

/** An entity extracted from a source document (no GUID yet) */
export interface ExtractedEntity {
  /** Vocabulary entity type (e.g., "Equipment", "Component", "Fluid") */
  entityType: string;
  /** Human-readable label following vocabulary naming conventions */
  label: string;
  /** Entity description/summary */
  summary?: string;
  /** Typed properties per the vocabulary schema */
  properties: Record<string, unknown>;
  /** Alternative names encountered in the document */
  aliases: string[];
  /** References to specific locations in the source document */
  sourceRefs: SourceRef[];
}

/** A relationship extracted from a source document (references entities by label) */
export interface ExtractedRelationship {
  /** Vocabulary relationship type (e.g., "COMPATIBLE_WITH", "HAS_COMPONENT") */
  type: string;
  /** Label of the source entity */
  sourceLabel: string;
  /** Label of the target entity */
  targetLabel: string;
  /** Typed properties per the vocabulary schema */
  properties: Record<string, unknown>;
  /** References to specific locations in the source document */
  sourceRefs: SourceRef[];
}

/** A reference to a specific location in a source document */
export interface SourceRef {
  /** Human-readable description of what this section contains */
  description: string;
  /** Start line number (1-indexed) */
  lineStart: number;
  /** End line number (1-indexed) */
  lineEnd: number;
}
