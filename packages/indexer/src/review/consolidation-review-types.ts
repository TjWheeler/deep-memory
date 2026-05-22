/**
 * Types for consolidation review diagnostics (Phase C.5).
 *
 * Analyzes merge decisions from consolidation to identify false merges,
 * overly generic aliases, and cross-source merge anomalies.
 * All diagnostics are domain-agnostic.
 */

import type { QualityRating } from './types.js';

/** Complete consolidation review report */
export interface ConsolidationReviewReport {
  generatedAt: string;
  totalEntities: number;
  totalMergeEvents: number;
  overallRating: QualityRating;
  mergeConfidence: MergeConfidenceReport;
  aliasSpecificity: AliasSpecificityReport;
  crossSourceMerges: CrossSourceMergeReport;
  typeConsistency: TypeConsistencyReport;
  statistics: MergeStatisticsReport;
}

/** Diagnostic 1: Merge confidence breakdown */
export interface MergeConfidenceReport {
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  rating: QualityRating;
  /** Low and medium confidence events for review (high-confidence omitted for brevity) */
  flaggedEvents: Array<{
    canonicalLabel: string;
    mergedLabel: string;
    entityType: string;
    matchedBy: string;
    confidence: number;
  }>;
}

/** Diagnostic 2: Alias specificity — flags aliases likely to cause false merges */
export interface AliasSpecificityReport {
  flaggedCount: number;
  rating: QualityRating;
  flaggedAliases: Array<{
    alias: string;
    entityLabel: string;
    entityType: string;
    reason: 'too-short' | 'too-generic' | 'ambiguous-across-types';
    /** For 'ambiguous-across-types': the other entity types this alias matches */
    matchedTypes?: string[];
  }>;
}

/** Diagnostic 3: Cross-source merge audit */
export interface CrossSourceMergeReport {
  totalCrossSourceEntities: number;
  /** Entities merged across 2+ source documents, sorted by source count descending */
  entities: Array<{
    label: string;
    entityType: string;
    sourceDocuments: string[];
    sourceCount: number;
    aliases: string[];
  }>;
}

/** Diagnostic 4: Type consistency — flags merges where property keys diverge */
export interface TypeConsistencyReport {
  flaggedCount: number;
  rating: QualityRating;
  flaggedMerges: Array<{
    canonicalLabel: string;
    mergedLabel: string;
    entityType: string;
    canonicalPropertyKeys: string[];
    mergedPropertyKeys: string[];
    overlapRatio: number;
  }>;
}

/** Diagnostic 5: Merge statistics */
export interface MergeStatisticsReport {
  mergeRateByType: Record<string, { total: number; merged: number; rate: number }>;
  mergeReasonDistribution: Record<string, number>;
  largestMergeClusters: Array<{
    label: string;
    entityType: string;
    aliasCount: number;
    sourceCount: number;
    aliases: string[];
  }>;
}
