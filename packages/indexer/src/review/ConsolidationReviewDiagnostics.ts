/**
 * Consolidation review diagnostics engine.
 *
 * Runs 5 automated checks against consolidation output:
 *   1. Merge confidence — breakdown by confidence band, flags low-confidence merges
 *   2. Alias specificity — flags short/generic aliases that could cause false merges
 *   3. Cross-source merge audit — lists entities merged across multiple source documents
 *   4. Type consistency — flags merges where property keys diverge significantly
 *   5. Merge statistics — merge rates by type, reason distribution, largest clusters
 *
 * All diagnostics are domain-agnostic — no hardcoded domain terms or logic.
 * Pure computation — no LLM calls, no external dependencies.
 */

import { StateManager } from '../orchestrator/StateManager.js';
import type { EntityRegistry } from '../types/registry.js';
import type { MergeLog } from '../consolidation/types.js';
import type { QualityRating } from './types.js';
import type {
  ConsolidationReviewReport,
  MergeConfidenceReport,
  AliasSpecificityReport,
  CrossSourceMergeReport,
  TypeConsistencyReport,
  MergeStatisticsReport,
} from './consolidation-review-types.js';
import type { QualityThresholds } from '../types/config.js';
import { DEFAULT_QUALITY_THRESHOLDS } from '../types/config.js';

/** Consolidation review thresholds — resolved at construction time from config or defaults */
type ConsolidationThresholds = QualityThresholds['consolidation'];

/** Maximum entries to include in flagged lists (keep reports manageable) */
const MAX_FLAGGED_ITEMS = 50;

export class ConsolidationReviewDiagnostics {
  private readonly thresholds: ConsolidationThresholds;

  constructor(state: StateManager, thresholds?: ConsolidationThresholds);
  constructor(private readonly state: StateManager, thresholds?: ConsolidationThresholds) {
    this.thresholds = thresholds ?? DEFAULT_QUALITY_THRESHOLDS.consolidation;
  }

  async run(): Promise<ConsolidationReviewReport> {
    const mergeLog = await this.state.getMergeLog<MergeLog>();
    const registry = await this.state.getRegistry();

    if (!registry) {
      throw new Error('Entity registry not found — run consolidation first');
    }
    if (!mergeLog) {
      throw new Error('Merge log not found — run consolidation with the updated indexer to generate merge tracking data');
    }

    const mergeConfidence = this.analyzeMergeConfidence(mergeLog);
    const aliasSpecificity = this.analyzeAliasSpecificity(registry);
    const crossSourceMerges = this.analyzeCrossSourceMerges(registry);
    const typeConsistency = this.analyzeTypeConsistency(mergeLog);
    const statistics = this.computeStatistics(mergeLog, registry);

    const overallRating = worstRating([
      mergeConfidence.rating,
      aliasSpecificity.rating,
      typeConsistency.rating,
    ]);

    const report: ConsolidationReviewReport = {
      generatedAt: new Date().toISOString(),
      totalEntities: registry.entities.length,
      totalMergeEvents: mergeLog.totalEvents,
      overallRating,
      mergeConfidence,
      aliasSpecificity,
      crossSourceMerges,
      typeConsistency,
      statistics,
    };

    await this.state.saveConsolidationReviewDiagnostics(report);
    return report;
  }

  // ── Diagnostic 1: Merge Confidence ──────────────────────────────

  private analyzeMergeConfidence(mergeLog: MergeLog): MergeConfidenceReport {
    let highConfidenceCount = 0;
    let mediumConfidenceCount = 0;
    let lowConfidenceCount = 0;
    const flaggedEvents: MergeConfidenceReport['flaggedEvents'] = [];

    for (const event of mergeLog.events) {
      if (event.confidence >= this.thresholds.mergeConfidence.high) {
        highConfidenceCount++;
      } else if (event.confidence >= this.thresholds.mergeConfidence.medium) {
        mediumConfidenceCount++;
        if (flaggedEvents.length < MAX_FLAGGED_ITEMS) {
          flaggedEvents.push({
            canonicalLabel: event.canonicalLabel,
            mergedLabel: event.mergedLabel,
            entityType: event.entityType,
            matchedBy: event.matchedBy,
            confidence: event.confidence,
          });
        }
      } else {
        lowConfidenceCount++;
        if (flaggedEvents.length < MAX_FLAGGED_ITEMS) {
          flaggedEvents.push({
            canonicalLabel: event.canonicalLabel,
            mergedLabel: event.mergedLabel,
            entityType: event.entityType,
            matchedBy: event.matchedBy,
            confidence: event.confidence,
          });
        }
      }
    }

    const rating: QualityRating =
      lowConfidenceCount === 0 && mediumConfidenceCount === 0 ? 'good' :
      lowConfidenceCount === 0 ? 'acceptable' :
      'needs-work';

    return { highConfidenceCount, mediumConfidenceCount, lowConfidenceCount, rating, flaggedEvents };
  }

  // ── Diagnostic 2: Alias Specificity ─────────────────────────────

  private analyzeAliasSpecificity(registry: EntityRegistry): AliasSpecificityReport {
    // Build a map from lowercase alias → set of entity types that use it
    const aliasTypeMap = new Map<string, Set<string>>();
    const aliasEntityMap = new Map<string, { label: string; entityType: string }>();

    for (const entry of registry.entities) {
      for (const alias of entry.aliases) {
        const key = alias.toLowerCase();
        if (!aliasTypeMap.has(key)) {
          aliasTypeMap.set(key, new Set());
          aliasEntityMap.set(key, { label: entry.label, entityType: entry.entityType });
        }
        aliasTypeMap.get(key)!.add(entry.entityType);
      }
    }

    const flaggedAliases: AliasSpecificityReport['flaggedAliases'] = [];

    for (const entry of registry.entities) {
      for (const alias of entry.aliases) {
        const key = alias.toLowerCase();

        // Check 1: Too short
        if (alias.length <= this.thresholds.shortAliasLength) {
          if (flaggedAliases.length < MAX_FLAGGED_ITEMS) {
            flaggedAliases.push({
              alias,
              entityLabel: entry.label,
              entityType: entry.entityType,
              reason: 'too-short',
            });
          }
          continue;
        }

        // Check 2: Ambiguous across entity types
        const types = aliasTypeMap.get(key);
        if (types && types.size > 1) {
          if (flaggedAliases.length < MAX_FLAGGED_ITEMS) {
            flaggedAliases.push({
              alias,
              entityLabel: entry.label,
              entityType: entry.entityType,
              reason: 'ambiguous-across-types',
              matchedTypes: [...types],
            });
          }
        }
      }
    }

    const rating: QualityRating =
      flaggedAliases.length === 0 ? 'good' :
      flaggedAliases.filter(f => f.reason === 'ambiguous-across-types').length === 0 ? 'acceptable' :
      'needs-work';

    return { flaggedCount: flaggedAliases.length, rating, flaggedAliases };
  }

  // ── Diagnostic 3: Cross-Source Merge Audit ──────────────────────

  private analyzeCrossSourceMerges(registry: EntityRegistry): CrossSourceMergeReport {
    const crossSource = registry.entities
      .filter(e => e.sourceDocuments.length >= 2)
      .map(e => ({
        label: e.label,
        entityType: e.entityType,
        sourceDocuments: e.sourceDocuments,
        sourceCount: e.sourceDocuments.length,
        aliases: e.aliases,
      }))
      .sort((a, b) => b.sourceCount - a.sourceCount);

    return {
      totalCrossSourceEntities: crossSource.length,
      entities: crossSource,
    };
  }

  // ── Diagnostic 4: Type Consistency ──────────────────────────────

  private analyzeTypeConsistency(mergeLog: MergeLog): TypeConsistencyReport {
    const flaggedMerges: TypeConsistencyReport['flaggedMerges'] = [];

    for (const event of mergeLog.events) {
      // Skip events where we don't have property keys for both sides
      if (event.canonicalPropertyKeys.length === 0 && event.mergedPropertyKeys.length === 0) {
        continue;
      }
      // Skip if one side has no keys (registry-level merges don't have canonical keys)
      if (event.canonicalPropertyKeys.length === 0 || event.mergedPropertyKeys.length === 0) {
        continue;
      }

      const overlap = jaccardSimilarity(event.canonicalPropertyKeys, event.mergedPropertyKeys);
      if (overlap < this.thresholds.propertyOverlapMinimum) {
        if (flaggedMerges.length < MAX_FLAGGED_ITEMS) {
          flaggedMerges.push({
            canonicalLabel: event.canonicalLabel,
            mergedLabel: event.mergedLabel,
            entityType: event.entityType,
            canonicalPropertyKeys: event.canonicalPropertyKeys,
            mergedPropertyKeys: event.mergedPropertyKeys,
            overlapRatio: Math.round(overlap * 100) / 100,
          });
        }
      }
    }

    const rating: QualityRating =
      flaggedMerges.length === 0 ? 'good' :
      flaggedMerges.length <= this.thresholds.typeConsistencyMaxAcceptable ? 'acceptable' :
      'needs-work';

    return { flaggedCount: flaggedMerges.length, rating, flaggedMerges };
  }

  // ── Diagnostic 5: Merge Statistics ──────────────────────────────

  private computeStatistics(mergeLog: MergeLog, registry: EntityRegistry): MergeStatisticsReport {
    // Merge rate by type
    const typeTotals = new Map<string, number>();
    const typeMerged = new Map<string, number>();

    for (const entry of registry.entities) {
      typeTotals.set(entry.entityType, (typeTotals.get(entry.entityType) ?? 0) + 1);
    }
    for (const event of mergeLog.events) {
      typeMerged.set(event.entityType, (typeMerged.get(event.entityType) ?? 0) + 1);
    }

    const mergeRateByType: Record<string, { total: number; merged: number; rate: number }> = {};
    for (const [type, total] of typeTotals) {
      const merged = typeMerged.get(type) ?? 0;
      mergeRateByType[type] = {
        total,
        merged,
        rate: total > 0 ? Math.round((merged / (total + merged)) * 100) / 100 : 0,
      };
    }

    // Merge reason distribution
    const mergeReasonDistribution: Record<string, number> = {};
    for (const event of mergeLog.events) {
      mergeReasonDistribution[event.matchedBy] = (mergeReasonDistribution[event.matchedBy] ?? 0) + 1;
    }

    // Largest merge clusters (entities with most aliases = most merges absorbed)
    const largestMergeClusters = registry.entities
      .filter(e => e.aliases.length > 0)
      .map(e => ({
        label: e.label,
        entityType: e.entityType,
        aliasCount: e.aliases.length,
        sourceCount: e.sourceDocuments.length,
        aliases: e.aliases,
      }))
      .sort((a, b) => b.aliasCount - a.aliasCount)
      .slice(0, 20);

    return { mergeRateByType, mergeReasonDistribution, largestMergeClusters };
  }
}

// ── Helpers ───────────────────────────────────────────────────────

function worstRating(ratings: QualityRating[]): QualityRating {
  if (ratings.includes('needs-work')) return 'needs-work';
  if (ratings.includes('acceptable')) return 'acceptable';
  return 'good';
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map(k => k.toLowerCase()));
  const setB = new Set(b.map(k => k.toLowerCase()));
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 1 : intersection.size / union.size;
}
