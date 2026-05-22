/**
 * Types for consolidation merge tracking.
 *
 * MergeEvents are recorded during consolidation to enable post-consolidation
 * review diagnostics. Each event captures why two entities were merged and
 * the confidence of the decision.
 */

/** How a merge was determined */
export type MergeMatchType = 'exact-label' | 'exact-slug' | 'alias' | 'label-similarity';

/** A single merge event recorded during consolidation */
export interface MergeEvent {
  /** The canonical entity label after merge */
  canonicalLabel: string;
  /** Entity type */
  entityType: string;
  /** The label that was merged into the canonical */
  mergedLabel: string;
  /** Why the merge happened */
  matchedBy: MergeMatchType;
  /** Confidence score (0-1). exact-label and exact-slug are always 1.0 */
  confidence: number;
  /** Source documents of the merged entity */
  mergedFromSources: string[];
  /** Source documents of the canonical entity at time of merge */
  canonicalSources: string[];
  /** Property keys of the merged entity (for type-consistency checking) */
  mergedPropertyKeys: string[];
  /** Property keys of the canonical entity (for type-consistency checking) */
  canonicalPropertyKeys: string[];
}

/** Complete merge log persisted after consolidation */
export interface MergeLog {
  generatedAt: string;
  totalEvents: number;
  events: MergeEvent[];
}
