/**
 * Types for extraction review diagnostics.
 *
 * ReviewDiagnostics runs 5 automated checks against extraction outputs
 * and produces a structured report with per-document and aggregate metrics.
 */

import type { GovernanceMode } from '@utaba/deep-memory';
import type { ConformanceViolationClass } from './VocabularyConformanceGate.js';

/** Quality rating based on review guide thresholds */
export type QualityRating = 'good' | 'acceptable' | 'needs-work';

/**
 * Compact vocabulary-conformance summary carried in the review report. Lets any
 * consumer of the persisted report see how the extraction measured against the
 * domain vocabulary without re-running the conformance gate. Present only when
 * the review was run with a vocabulary context.
 */
export interface ConformanceSummary {
  mode: GovernanceMode;
  violationCount: number;
  countsByClass: Record<ConformanceViolationClass, number>;
}

/**
 * One entity type whose instance labels coincide with the controlled-value
 * vocabulary declared for that type (its closed-enum allowed values or open
 * recommended values). The signal that the extractor enumerated a naming guide
 * as entities instead of reading them from the source text.
 */
export interface EnumChecklistSmell {
  entityType: string;
  /** Distinct normalized instance labels of this type. */
  distinctLabelCount: number;
  /** Size of the declared controlled-value list for this type. */
  controlledValueCount: number;
  /** How many distinct labels matched a controlled value. */
  matchedCount: number;
  /** Fraction of distinct labels that are controlled values (0..1). */
  labelDominance: number;
  /** Fraction of the controlled-value list present as labels (0..1). */
  enumCoverage: number;
  /** Sample of the matched labels. */
  examples: string[];
}

/**
 * A group of relationships that all cite the same narrow source line range. Many
 * relationships hanging off one short passage is the signature of cross-product
 * fabrication — edges invented by pairing entities rather than read from text.
 */
export interface SharedSourceRefSmell {
  /** Source document the citation belongs to. */
  source: string;
  /** The shared narrow citation, expressed as a line range (e.g. "120-124"). */
  citation: string;
  /** Number of relationships sharing this exact narrow citation. */
  relationshipCount: number;
  /** Distinct relationship types sharing the citation. */
  relationshipTypes: string[];
}

/** Report-level fabrication smells detected across all analyzed documents. */
export interface FabricationSmells {
  enumChecklist: EnumChecklistSmell[];
  sharedSourceRefs: SharedSourceRefSmell[];
}

/**
 * Zero-property entities that are also relationship endpoints, surfaced
 * independently of the aggregate property-coverage percentage — a small number
 * of empty endpoint entities can hide behind an otherwise-high coverage figure.
 */
export interface ZeroPropertyEndpointReport {
  count: number;
  examples: Array<{ source: string; entityType: string; label: string }>;
}

/**
 * Optional vocabulary-derived context enabling the vocabulary-aware review
 * checks. Threaded in by the caller that has already parsed the vocabulary; when
 * absent, the vocabulary-dependent fields are simply omitted from the report.
 */
export interface ReviewVocabularyContext {
  /** Conformance results to surface as a summary in the report. */
  conformance?: ConformanceSummary;
  /**
   * Per entity type, the controlled-value vocabulary declared for that type —
   * the union of closed-enum allowed values and open recommended values across
   * the type's properties, verbatim. Compared normalized against instance
   * labels for the enum-checklist fabrication smell.
   */
  controlledValuesByType?: Record<string, string[]>;
}

/** Per-worker diagnostic summary used in multi-worker comparison */
export interface WorkerSummary {
  /** Worker name */
  workerName: string;
  /** Number of source documents this worker extracted */
  documentsAnalyzed: number;
  /** Aggregate metrics for this worker's outputs */
  aggregate: AggregateMetrics;
  /** Per-document results for this worker */
  documents: DocumentDiagnostics[];
}

/** Per-source comparison of worker outputs */
export interface SourceComparison {
  /** Source document filename */
  source: string;
  /** Each worker's diagnostics for this source */
  workers: Array<{
    workerName: string;
    overallRating: QualityRating;
    entityCount: number;
    relationshipCount: number;
    propertyCoveragePercent: number;
    orphanPercent: number;
    duplicateCount: number;
    badLabelCount: number;
  }>;
  /** Recommended worker for this specific source */
  recommended: string;
}

/** Multi-worker comparison produced when sources lack a selectedExtraction */
export interface WorkerComparison {
  /** Per-worker diagnostic summaries (aggregate) */
  workers: WorkerSummary[];
  /** Per-source file comparison with per-file recommendation */
  sourceComparisons: SourceComparison[];
  /** Recommended worker name based on aggregate diagnostic scores */
  recommended: string;
  /** Explanation of why this worker was recommended */
  reason: string;
}

/** Complete review diagnostics report */
export interface ReviewReport {
  /** ISO 8601 timestamp of when diagnostics were run */
  generatedAt: string;
  /** Number of extraction files analyzed */
  documentsAnalyzed: number;
  /** Aggregate metrics across all documents */
  aggregate: AggregateMetrics;
  /** Per-document diagnostic results */
  documents: DocumentDiagnostics[];
  /** Multi-worker comparison (present when no workerName was specified and sources lack selectedExtraction) */
  workerComparison?: WorkerComparison;
  /** Vocabulary-conformance summary (present only when a vocabulary context was supplied) */
  conformance?: ConformanceSummary;
  /** Fabrication smells detected across all documents. Present after any run; the cross-product `sharedSourceRefs` signal needs no vocabulary, while `enumChecklist` is populated only when a vocabulary context supplied controlled values. */
  fabricationSmells?: FabricationSmells;
  /** Zero-property entities that are relationship endpoints, surfaced regardless of aggregate coverage */
  zeroPropertyEndpoints?: ZeroPropertyEndpointReport;
}

/** Aggregate metrics across all analyzed documents */
export interface AggregateMetrics {
  totalEntities: number;
  totalRelationships: number;
  /** Entity type counts across all documents */
  entityTypeDistribution: Record<string, number>;
  /** Entities with zero properties */
  zeroPropertyCount: number;
  zeroPropertyPercent: number;
  propertyCoverageRating: QualityRating;
  /** Orphan relationships (source or target label not matching any entity) */
  orphanCount: number;
  orphanPercent: number;
  orphanRating: QualityRating;
  /** Exact duplicate entities (same entityType + label, case-insensitive) */
  duplicateCount: number;
  duplicateRating: QualityRating;
  /** Entities with short, garbage, or JSON-artifact labels */
  badLabelCount: number;
  /** Total documents with at least one truncated LLM call */
  truncatedDocumentCount: number;
  /** Total truncated LLM calls across all documents */
  truncatedChunkCount: number;
  /** Total LLM calls across all documents */
  totalChunkCount: number;
  /** Aggregate truncation rate as percentage */
  truncationPercent: number;
  /** Total entities salvaged from truncated responses */
  totalEntitiesSalvaged: number;
  /** Total relationships salvaged from truncated responses */
  totalRelationshipsSalvaged: number;
  /** Total LLM calls where truncation occurred but salvage failed */
  totalUnsalvageableChunks: number;
  /** Truncation quality rating */
  truncationRating: QualityRating;
  /** Overall quality rating (worst of all individual ratings) */
  overallRating: QualityRating;
}

/** Diagnostic results for a single extraction file */
export interface DocumentDiagnostics {
  /** Source document filename */
  source: string;
  /** Worker that performed the extraction */
  extractedBy: string;
  /** Total entities in this extraction */
  entityCount: number;
  /** Total relationships in this extraction */
  relationshipCount: number;
  /** Overall quality rating for this document */
  overallRating: QualityRating;

  /** Check 1: Entity type distribution */
  entityTypeDistribution: Record<string, number>;

  /** Check 2: Property coverage */
  propertyCheck: {
    zeroPropertyCount: number;
    zeroPropertyPercent: number;
    rating: QualityRating;
    /** Up to 10 examples of zero-property entities */
    examples: Array<{ entityType: string; label: string }>;
  };

  /** Check 3: Orphan relationships */
  orphanCheck: {
    orphanCount: number;
    orphanPercent: number;
    rating: QualityRating;
    /** Unique missing labels grouped by side (source vs target) */
    missingSourceLabels: Array<{ label: string; count: number }>;
    missingTargetLabels: Array<{ label: string; count: number }>;
    /** Up to 10 example orphan relationships */
    examples: OrphanExample[];
  };

  /** Check 4: Duplicate detection */
  duplicateCheck: {
    /** Exact duplicates under the normalized key (case, accents, whitespace, and `-`/`/` spacing folded away) */
    duplicateCount: number;
    rating: QualityRating;
    /** The duplicate entities found (representative label of each normalized group) */
    duplicates: Array<{ entityType: string; label: string; count: number }>;
    /**
     * Softer signal: distinct same-type pairs whose normalized token set is a
     * strict subset of another instance's (e.g. "Main Street" ⊂ "Main Street Bridge").
     * Not counted in duplicateCount — normalization alone will not merge these.
     */
    tokenSubsetCount: number;
    possibleDuplicates: Array<{ entityType: string; label: string; supersetLabel: string }>;
  };

  /** Check 5: Label quality */
  labelCheck: {
    badLabelCount: number;
    /** Up to 10 examples of bad labels */
    examples: Array<{ entityType: string; label: string; reason: string }>;
  };

  /** Check 6: Truncation detection */
  truncationCheck: {
    /** Whether any LLM calls for this document were truncated */
    wasTruncated: boolean;
    /** Number of chunks that were truncated */
    truncatedChunks: number;
    /** Total chunks processed for this document */
    totalChunks: number;
    /** Truncation rate as a percentage */
    truncationPercent: number;
    /** Entities salvaged from truncated responses */
    entitiesSalvaged: number;
    /** Relationships salvaged from truncated responses */
    relationshipsSalvaged: number;
    /** Chunks where truncation occurred but no data could be salvaged */
    unsalvageableChunks: number;
    /** Quality rating based on truncation severity */
    rating: QualityRating;
  };
}

/** A single orphan relationship example */
export interface OrphanExample {
  relationshipType: string;
  sourceLabel: string;
  targetLabel: string;
  /** Which side(s) are missing */
  missingSource: boolean;
  missingTarget: boolean;
}
