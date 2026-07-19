/**
 * Extraction review diagnostics engine.
 *
 * Per-document checks:
 *   - Entity type distribution
 *   - Property coverage (entities with 0 properties)
 *   - Orphan relationships (source/target label not matching any entity)
 *   - Duplicate detection (normalized label match, plus a softer token-subset signal)
 *   - Label quality (short, garbage, JSON artifacts)
 *   - Truncation (LLM output cut off at the token limit)
 *
 * Report-level signals across all documents:
 *   - Vocabulary-conformance summary (threaded in from the caller)
 *   - Fabrication smells (labels enumerating a controlled vocabulary; many
 *     relationships citing one narrow passage)
 *   - Zero-property entities that are relationship endpoints
 *
 * Pure computation — no LLM calls, no external dependencies.
 * Uses the source list to determine which extraction files are active
 * (skipping excluded sources and backup files). The vocabulary-dependent
 * report-level signals are produced only when a vocabulary context is supplied.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { StateManager } from '../orchestrator/StateManager.js';
import type { ExtractionOutput, ExtractedEntity, ExtractedRelationship, TruncationInfo } from '../types/extraction.js';
import type {
  ReviewReport,
  AggregateMetrics,
  DocumentDiagnostics,
  OrphanExample,
  QualityRating,
  WorkerSummary,
  WorkerComparison,
  SourceComparison,
  ReviewVocabularyContext,
  FabricationSmells,
  EnumChecklistSmell,
  SharedSourceRefSmell,
  ZeroPropertyEndpointReport,
} from './types.js';
import type { QualityThresholds } from '../types/config.js';
import { DEFAULT_QUALITY_THRESHOLDS } from '../types/config.js';

/** Extraction review thresholds — resolved at construction time from config or defaults */
type ExtractionThresholds = QualityThresholds['extraction'];

/**
 * A citation spanning at most this many source lines is treated as "narrow"
 * enough that many relationships sharing it is suspicious rather than incidental
 * (a genuinely dense table cell cites a small range).
 */
const NARROW_CITATION_MAX_SPAN = 5;

/**
 * Minimum number of relationships sharing one narrow citation before it is
 * reported as a cross-product-fabrication smell.
 */
const SHARED_SOURCEREF_MIN_GROUP = 10;

/**
 * The enum-checklist smell only fires for a controlled-value list of at least
 * this size — a two- or three-value list matching a couple of labels is not
 * distinctive enough to call fabrication.
 */
const ENUM_CHECKLIST_MIN_CONTROLLED_VALUES = 4;

/** Fraction of a type's distinct labels that must be controlled values to flag. */
const ENUM_CHECKLIST_LABEL_DOMINANCE = 0.8;

/** Fraction of the controlled-value list that must appear as labels to flag. */
const ENUM_CHECKLIST_ENUM_COVERAGE = 0.6;

/** Cap on examples carried in the softer per-document token-subset signal. */
const TOKEN_SUBSET_EXAMPLE_CAP = 10;

export class ReviewDiagnostics {
  private readonly thresholds: ExtractionThresholds;
  private readonly vocabularyContext: ReviewVocabularyContext | undefined;

  public constructor(
    state: StateManager,
    thresholds?: ExtractionThresholds,
    vocabularyContext?: ReviewVocabularyContext,
  );
  public constructor(
    private readonly state: StateManager,
    thresholds?: ExtractionThresholds,
    vocabularyContext?: ReviewVocabularyContext,
  ) {
    this.thresholds = thresholds ?? DEFAULT_QUALITY_THRESHOLDS.extraction;
    this.vocabularyContext = vocabularyContext;
  }

  /**
   * Run all diagnostic checks against extraction outputs.
   *
   * Uses the source list to identify active extraction files.
   * If sourceFilter is provided, only analyzes matching sources.
   * If workerName is provided, reads that worker's outputs instead of selected outputs
   * (useful for comparing workers during extraction-review).
   *
   * When no workerName is provided and sources lack selectedExtraction,
   * runs diagnostics per worker and produces a comparison with recommendation.
   */
  async run(sourceFilter?: string[], workerName?: string): Promise<ReviewReport> {
    // Specific worker requested — use that worker's outputs
    if (workerName) {
      return this.runForWorker(workerName, sourceFilter);
    }

    // Check if we need multi-worker comparison
    const needsComparison = await this.needsWorkerComparison(sourceFilter);
    if (needsComparison) {
      return this.runWorkerComparison(sourceFilter);
    }

    // Default path: use selected extraction outputs
    const outputs = await this.getActiveExtractionOutputs(sourceFilter);
    return this.buildReport(outputs);
  }

  /**
   * Run diagnostics for a specific worker's outputs.
   */
  private async runForWorker(workerName: string, sourceFilter?: string[]): Promise<ReviewReport> {
    let outputs = await this.state.getExtractionOutputsByWorker(workerName);

    // Apply source-level filtering (excluded sources + sourceFilter)
    const sourceList = await this.state.getSourceList();
    if (sourceList) {
      const excludedPaths = new Set(
        sourceList.sources.filter(s => s.status === 'excluded').map(s => s.path),
      );
      outputs = outputs.filter(o => !excludedPaths.has(o.sourcePath));
    }
    if (sourceFilter && sourceFilter.length > 0) {
      outputs = outputs.filter(o =>
        sourceFilter.some(f => o.source.includes(f) || o.sourcePath.includes(f)),
      );
    }

    return this.buildReport(outputs);
  }

  /**
   * Check if sources need a multi-worker comparison (no workerName given,
   * sources have extractionFiles from multiple workers but no selectedExtraction).
   */
  private async needsWorkerComparison(sourceFilter?: string[]): Promise<boolean> {
    const sourceList = await this.state.getSourceList();
    if (!sourceList) return false;

    let activeSources = sourceList.sources.filter(s => s.status !== 'excluded');
    if (sourceFilter && sourceFilter.length > 0) {
      activeSources = activeSources.filter(s =>
        sourceFilter.some(f => s.path.includes(f)),
      );
    }

    // If any active source has extractionFiles but no selectedExtraction, we need comparison
    const unselected = activeSources.filter(s => s.extractionFiles && !s.selectedExtraction);
    return unselected.length > 0;
  }

  /**
   * Run diagnostics per worker and produce a comparison report with recommendation.
   */
  private async runWorkerComparison(sourceFilter?: string[]): Promise<ReviewReport> {
    const workerNames = await this.state.getWorkerNames();
    if (workerNames.length === 0) {
      // No workers found — fall back to empty report
      return this.buildReport([]);
    }

    const workerSummaries: WorkerSummary[] = [];
    const outputsByWorker = new Map<string, ExtractionOutput[]>();
    for (const name of workerNames) {
      let outputs = await this.state.getExtractionOutputsByWorker(name);

      // Apply source-level filtering
      const sourceList = await this.state.getSourceList();
      if (sourceList) {
        const excludedPaths = new Set(
          sourceList.sources.filter(s => s.status === 'excluded').map(s => s.path),
        );
        outputs = outputs.filter(o => !excludedPaths.has(o.sourcePath));
      }
      if (sourceFilter && sourceFilter.length > 0) {
        outputs = outputs.filter(o =>
          sourceFilter.some(f => o.source.includes(f) || o.sourcePath.includes(f)),
        );
      }
      outputsByWorker.set(name, outputs);

      const documents: DocumentDiagnostics[] = [];
      for (const output of outputs) {
        documents.push(this.analyzeDocument(output));
      }
      const aggregate = this.computeAggregate(documents);

      workerSummaries.push({
        workerName: name,
        documentsAnalyzed: documents.length,
        aggregate,
        documents,
      });
    }

    const sourceComparisons = this.buildSourceComparisons(workerSummaries);
    const { recommended, reason } = this.recommendWorker(workerSummaries);

    const comparison: WorkerComparison = {
      workers: workerSummaries,
      sourceComparisons,
      recommended,
      reason,
    };

    // Use the recommended worker's data as the primary report
    const best = workerSummaries.find(w => w.workerName === recommended) ?? workerSummaries[0]!;

    const report: ReviewReport = {
      generatedAt: new Date().toISOString(),
      documentsAnalyzed: best.documentsAnalyzed,
      aggregate: best.aggregate,
      documents: best.documents,
      workerComparison: comparison,
    };

    // Attach the report-level signals from the recommended worker's outputs, so
    // the unselected multi-worker state gets the same conformance / fabrication /
    // endpoint signals as a selected single-worker report.
    this.attachReportLevelSignals(report, outputsByWorker.get(best.workerName) ?? []);

    await this.state.saveReviewDiagnostics(report);
    return report;
  }

  /**
   * Build and persist a standard report from a set of extraction outputs.
   */
  private async buildReport(outputs: ExtractionOutput[]): Promise<ReviewReport> {
    const documents: DocumentDiagnostics[] = [];
    for (const output of outputs) {
      documents.push(this.analyzeDocument(output));
    }

    const aggregate = this.computeAggregate(documents);

    const report: ReviewReport = {
      generatedAt: new Date().toISOString(),
      documentsAnalyzed: documents.length,
      aggregate,
      documents,
    };

    this.attachReportLevelSignals(report, outputs);

    await this.state.saveReviewDiagnostics(report);
    return report;
  }

  /**
   * Attach the corpus-wide signals that need the raw outputs rather than the
   * per-document aggregates: the conformance summary (threaded in from the
   * caller), the fabrication smells, and the zero-property endpoint check. Runs
   * on every report path so no exit misses them.
   */
  private attachReportLevelSignals(report: ReviewReport, outputs: ExtractionOutput[]): void {
    const conformance = this.vocabularyContext?.conformance;
    if (conformance) {
      report.conformance = conformance;
    }
    if (this.vocabularyContext?.controlledValuesByType) {
      report.fabricationSmells = this.detectFabricationSmells(
        outputs,
        this.vocabularyContext.controlledValuesByType,
      );
    } else {
      // Even without a vocabulary the cross-product smell is computable — it
      // reads only relationship citations. Only the enum-checklist smell needs
      // the controlled-value vocabulary.
      report.fabricationSmells = {
        enumChecklist: [],
        sharedSourceRefs: this.detectSharedSourceRefs(outputs),
      };
    }
    report.zeroPropertyEndpoints = this.detectZeroPropertyEndpoints(outputs);
  }

  /** Pivot worker-grouped diagnostics into source-grouped comparisons */
  private buildSourceComparisons(workerSummaries: WorkerSummary[]): SourceComparison[] {
    // Collect all unique source names across all workers
    const sourceMap = new Map<string, Map<string, DocumentDiagnostics>>();
    for (const worker of workerSummaries) {
      for (const doc of worker.documents) {
        let workerMap = sourceMap.get(doc.source);
        if (!workerMap) {
          workerMap = new Map();
          sourceMap.set(doc.source, workerMap);
        }
        workerMap.set(worker.workerName, doc);
      }
    }

    const comparisons: SourceComparison[] = [];
    for (const [source, workerMap] of sourceMap) {
      const workers: SourceComparison['workers'] = [];
      let bestWorker = '';
      let bestScore = -Infinity;

      for (const [workerName, doc] of workerMap) {
        const coveragePercent = 100 - doc.propertyCheck.zeroPropertyPercent;
        workers.push({
          workerName,
          overallRating: doc.overallRating,
          entityCount: doc.entityCount,
          relationshipCount: doc.relationshipCount,
          propertyCoveragePercent: Math.round(coveragePercent * 10) / 10,
          orphanPercent: doc.orphanCheck.orphanPercent,
          duplicateCount: doc.duplicateCheck.duplicateCount,
          badLabelCount: doc.labelCheck.badLabelCount,
        });

        const score = this.scoreDocument(doc);
        if (score > bestScore) {
          bestScore = score;
          bestWorker = workerName;
        }
      }

      comparisons.push({ source, workers, recommended: bestWorker });
    }

    return comparisons;
  }

  /** Score a single document for per-source ranking (higher is better) */
  private scoreDocument(doc: DocumentDiagnostics): number {
    const ratingScore = doc.overallRating === 'good' ? 3 : doc.overallRating === 'acceptable' ? 2 : 1;
    const coverageScore = 100 - doc.propertyCheck.zeroPropertyPercent;
    return ratingScore * 1000 + coverageScore - doc.orphanCheck.orphanPercent - doc.duplicateCheck.duplicateCount;
  }

  /** Score a worker summary for ranking (higher is better) */
  private scoreWorker(summary: WorkerSummary): number {
    const a = summary.aggregate;
    const ratingScore = a.overallRating === 'good' ? 3 : a.overallRating === 'acceptable' ? 2 : 1;
    const coverageScore = 100 - a.zeroPropertyPercent;
    const orphanPenalty = a.orphanPercent;
    const duplicatePenalty = a.duplicateCount;
    // Primary: rating tier, secondary: coverage minus penalties
    return ratingScore * 1000 + coverageScore - orphanPenalty - duplicatePenalty;
  }

  /** Pick the best worker based on diagnostic scores */
  private recommendWorker(summaries: WorkerSummary[]): { recommended: string; reason: string } {
    if (summaries.length === 0) {
      return { recommended: '', reason: 'No workers found.' };
    }
    if (summaries.length === 1) {
      return { recommended: summaries[0]!.workerName, reason: 'Only one worker available.' };
    }

    const scored = summaries
      .map(s => ({ name: s.workerName, score: this.scoreWorker(s), summary: s }))
      .sort((a, b) => b.score - a.score);

    const best = scored[0]!;
    const runnerUp = scored[1]!;
    const ba = best.summary.aggregate;
    const ra = runnerUp.summary.aggregate;

    const parts: string[] = [
      `${best.name} scored highest (${ba.overallRating})`,
    ];
    if (ba.overallRating !== ra.overallRating) {
      parts.push(`vs ${runnerUp.name} (${ra.overallRating})`);
    } else {
      parts.push(`vs ${runnerUp.name}: better property coverage (${(100 - ba.zeroPropertyPercent).toFixed(1)}% vs ${(100 - ra.zeroPropertyPercent).toFixed(1)}%), fewer orphans (${ba.orphanPercent}% vs ${ra.orphanPercent}%)`);
    }

    return { recommended: best.name, reason: parts.join(' ') };
  }

  /**
   * Load a previously saved review diagnostics report, or null if none exists.
   */
  async getReport(): Promise<ReviewReport | null> {
    return this.state.getReviewDiagnostics();
  }

  // ── Per-Document Analysis ───────────────────────────────────────

  private analyzeDocument(output: ExtractionOutput): DocumentDiagnostics {
    const entities = output.entities;
    const relationships = output.relationships;

    const entityTypeDistribution = this.checkEntityTypeDistribution(entities);
    const propertyCheck = this.checkPropertyCoverage(entities);
    const orphanCheck = this.checkOrphanRelationships(entities, relationships);
    const duplicateCheck = this.checkDuplicates(entities);
    const labelCheck = this.checkLabelQuality(entities);
    const truncationCheck = this.checkTruncation(output.truncation);

    // Overall rating is the worst of property, orphan, duplicate, and truncation checks
    const overallRating = worstRating([
      propertyCheck.rating,
      orphanCheck.rating,
      duplicateCheck.rating,
      truncationCheck.rating,
    ]);

    return {
      source: output.source,
      extractedBy: output.extractedBy,
      entityCount: entities.length,
      relationshipCount: relationships.length,
      overallRating,
      entityTypeDistribution,
      propertyCheck,
      orphanCheck,
      duplicateCheck,
      labelCheck,
      truncationCheck,
    };
  }

  // ── Check 1: Entity Type Distribution ───────────────────────────

  private checkEntityTypeDistribution(entities: ExtractedEntity[]): Record<string, number> {
    const dist: Record<string, number> = {};
    for (const e of entities) {
      dist[e.entityType] = (dist[e.entityType] ?? 0) + 1;
    }
    return dist;
  }

  // ── Check 2: Property Coverage ──────────────────────────────────

  private checkPropertyCoverage(entities: ExtractedEntity[]): DocumentDiagnostics['propertyCheck'] {
    const zeroProp = entities.filter(e => !e.properties || Object.keys(e.properties).length === 0);
    const percent = entities.length > 0 ? (zeroProp.length / entities.length) * 100 : 0;
    const coveragePercent = 100 - percent;

    return {
      zeroPropertyCount: zeroProp.length,
      zeroPropertyPercent: round2(percent),
      rating: this.ratePropertyCoverage(coveragePercent),
      examples: zeroProp.slice(0, 10).map(e => ({ entityType: e.entityType, label: e.label })),
    };
  }

  // ── Check 3: Orphan Relationships ───────────────────────────────

  private checkOrphanRelationships(
    entities: ExtractedEntity[],
    relationships: ExtractedRelationship[],
  ): DocumentDiagnostics['orphanCheck'] {
    // Build lookup set from entity labels + aliases (case-insensitive)
    const labelSet = new Set<string>();
    for (const e of entities) {
      labelSet.add(e.label.toLowerCase());
      if (e.aliases) {
        for (const alias of e.aliases) {
          labelSet.add(alias.toLowerCase());
        }
      }
    }

    const orphans: OrphanExample[] = [];
    const missingSrcCounts = new Map<string, number>();
    const missingTgtCounts = new Map<string, number>();

    for (const rel of relationships) {
      const srcMatch = labelSet.has(rel.sourceLabel.toLowerCase());
      const tgtMatch = labelSet.has(rel.targetLabel.toLowerCase());

      if (!srcMatch || !tgtMatch) {
        orphans.push({
          relationshipType: rel.type,
          sourceLabel: rel.sourceLabel,
          targetLabel: rel.targetLabel,
          missingSource: !srcMatch,
          missingTarget: !tgtMatch,
        });

        if (!srcMatch) {
          missingSrcCounts.set(rel.sourceLabel, (missingSrcCounts.get(rel.sourceLabel) ?? 0) + 1);
        }
        if (!tgtMatch) {
          missingTgtCounts.set(rel.targetLabel, (missingTgtCounts.get(rel.targetLabel) ?? 0) + 1);
        }
      }
    }

    const orphanPercent = relationships.length > 0 ? (orphans.length / relationships.length) * 100 : 0;

    return {
      orphanCount: orphans.length,
      orphanPercent: round2(orphanPercent),
      rating: this.rateOrphanRate(orphanPercent),
      missingSourceLabels: sortedEntries(missingSrcCounts),
      missingTargetLabels: sortedEntries(missingTgtCounts),
      examples: orphans.slice(0, 10),
    };
  }

  // ── Check 4: Duplicate Detection ────────────────────────────────

  private checkDuplicates(entities: ExtractedEntity[]): DocumentDiagnostics['duplicateCheck'] {
    // Exact duplicates under a normalized key: case, accents, whitespace runs,
    // and spacing around `-`/`/` are folded so variants like "Café / Bar" and
    // "cafe/bar" collapse to one group.
    const counts = new Map<string, { entityType: string; label: string; count: number }>();

    for (const e of entities) {
      const key = `${e.entityType.toLowerCase()}:${normalizeLabel(e.label)}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count++;
      } else {
        counts.set(key, { entityType: e.entityType, label: e.label, count: 1 });
      }
    }

    const duplicates = [...counts.values()].filter(c => c.count > 1);
    const totalDuplicateCount = duplicates.reduce((sum, d) => sum + d.count - 1, 0);

    const { count: tokenSubsetCount, examples: possibleDuplicates } =
      this.detectTokenSubsets(entities);

    return {
      duplicateCount: totalDuplicateCount,
      rating: totalDuplicateCount === 0 ? 'good' : 'needs-work',
      duplicates,
      tokenSubsetCount,
      possibleDuplicates,
    };
  }

  /**
   * Softer duplicate signal for variant pairs that differ by a descriptor word
   * rather than by punctuation — one normalized label's word set is a strict
   * subset of another same-type label's (e.g. "Main Street" vs "Main Street Bridge").
   * Normalization alone never merges these, so they are reported separately and
   * never folded into duplicateCount. No descriptor word is assumed; the test is
   * purely set-theoretic on the tokens.
   */
  private detectTokenSubsets(
    entities: ExtractedEntity[],
  ): { count: number; examples: Array<{ entityType: string; label: string; supersetLabel: string }> } {
    // Reduce to distinct normalized labels per type, keeping a representative
    // original label, so the comparison is bounded by distinct names.
    const byType = new Map<string, Map<string, { label: string; tokens: Set<string> }>>();
    for (const e of entities) {
      const normalized = normalizeLabel(e.label);
      if (normalized.length === 0) continue;
      let group = byType.get(e.entityType);
      if (!group) {
        group = new Map();
        byType.set(e.entityType, group);
      }
      if (!group.has(normalized)) {
        group.set(normalized, { label: e.label, tokens: new Set(normalized.split(' ')) });
      }
    }

    const examples: Array<{ entityType: string; label: string; supersetLabel: string }> = [];
    let count = 0;
    for (const [entityType, group] of byType) {
      const items = [...group.values()];
      for (let i = 0; i < items.length; i++) {
        for (let j = 0; j < items.length; j++) {
          if (i === j) continue;
          const sub = items[i]!;
          const sup = items[j]!;
          if (sub.tokens.size >= sup.tokens.size) continue;
          if (isStrictTokenSubset(sub.tokens, sup.tokens)) {
            count++;
            if (examples.length < TOKEN_SUBSET_EXAMPLE_CAP) {
              examples.push({ entityType, label: sub.label, supersetLabel: sup.label });
            }
          }
        }
      }
    }

    return { count, examples };
  }

  // ── Check 5: Label Quality ──────────────────────────────────────

  private checkLabelQuality(entities: ExtractedEntity[]): DocumentDiagnostics['labelCheck'] {
    const bad: Array<{ entityType: string; label: string; reason: string }> = [];

    for (const e of entities) {
      const label = e.label;

      if (label.length <= 2) {
        bad.push({ entityType: e.entityType, label, reason: 'too-short' });
      } else if (/[\[\]{}"\\]/.test(label)) {
        bad.push({ entityType: e.entityType, label, reason: 'json-artifact' });
      } else if (/^\d+$/.test(label)) {
        bad.push({ entityType: e.entityType, label, reason: 'numeric-only' });
      }
    }

    return {
      badLabelCount: bad.length,
      examples: bad.slice(0, 10),
    };
  }

  // ── Check 6: Truncation Detection ─────────────────────────────

  private checkTruncation(truncation?: TruncationInfo): DocumentDiagnostics['truncationCheck'] {
    if (!truncation) {
      return {
        wasTruncated: false,
        truncatedChunks: 0,
        totalChunks: 0,
        truncationPercent: 0,
        entitiesSalvaged: 0,
        relationshipsSalvaged: 0,
        unsalvageableChunks: 0,
        rating: 'good',
      };
    }

    const truncationPercent = truncation.totalChunks > 0
      ? (truncation.truncatedChunks / truncation.totalChunks) * 100
      : 0;

    return {
      wasTruncated: true,
      truncatedChunks: truncation.truncatedChunks,
      totalChunks: truncation.totalChunks,
      truncationPercent: round2(truncationPercent),
      entitiesSalvaged: truncation.entitiesSalvaged,
      relationshipsSalvaged: truncation.relationshipsSalvaged,
      unsalvageableChunks: truncation.unsalvageableChunks,
      rating: this.rateTruncation(truncationPercent, truncation.unsalvageableChunks),
    };
  }

  // ── Report-Level Fabrication & Endpoint Signals ─────────────────

  private detectFabricationSmells(
    outputs: ExtractionOutput[],
    controlledValuesByType: Record<string, string[]>,
  ): FabricationSmells {
    return {
      enumChecklist: this.detectEnumChecklist(outputs, controlledValuesByType),
      sharedSourceRefs: this.detectSharedSourceRefs(outputs),
    };
  }

  /**
   * Flag entity types whose instance labels coincide with the type's declared
   * controlled vocabulary — the extractor read a naming guide as a checklist and
   * instantiated one entity per listed value rather than reading them from the
   * source. Both instance labels and controlled values are compared normalized.
   */
  private detectEnumChecklist(
    outputs: ExtractionOutput[],
    controlledValuesByType: Record<string, string[]>,
  ): EnumChecklistSmell[] {
    // Distinct normalized labels per entity type, keeping a representative label.
    const labelsByType = new Map<string, Map<string, string>>();
    for (const output of outputs) {
      for (const entity of output.entities) {
        const normalized = normalizeLabel(entity.label);
        if (normalized.length === 0) continue;
        let group = labelsByType.get(entity.entityType);
        if (!group) {
          group = new Map();
          labelsByType.set(entity.entityType, group);
        }
        if (!group.has(normalized)) group.set(normalized, entity.label);
      }
    }

    const smells: EnumChecklistSmell[] = [];
    for (const [entityType, rawValues] of Object.entries(controlledValuesByType)) {
      const controlled = new Set(rawValues.map(normalizeLabel).filter(v => v.length > 0));
      if (controlled.size < ENUM_CHECKLIST_MIN_CONTROLLED_VALUES) continue;

      const labels = labelsByType.get(entityType);
      if (!labels || labels.size === 0) continue;

      const matched: string[] = [];
      for (const [normalized, original] of labels) {
        if (controlled.has(normalized)) matched.push(original);
      }
      if (matched.length === 0) continue;

      const labelDominance = matched.length / labels.size;
      const enumCoverage = matched.length / controlled.size;
      if (labelDominance < ENUM_CHECKLIST_LABEL_DOMINANCE) continue;
      if (enumCoverage < ENUM_CHECKLIST_ENUM_COVERAGE) continue;

      smells.push({
        entityType,
        distinctLabelCount: labels.size,
        controlledValueCount: controlled.size,
        matchedCount: matched.length,
        labelDominance: round2(labelDominance),
        enumCoverage: round2(enumCoverage),
        examples: matched.slice(0, 10),
      });
    }
    return smells;
  }

  /**
   * Flag groups of relationships that all cite the same narrow source line range
   * within one document — the cross-product-fabrication signature. A citation is
   * "narrow" when its overall span is small; a group is a smell when enough
   * relationships share the identical narrow citation.
   */
  private detectSharedSourceRefs(outputs: ExtractionOutput[]): SharedSourceRefSmell[] {
    interface Group { count: number; types: Set<string> }
    const groups = new Map<string, Group>();

    for (const output of outputs) {
      for (const rel of output.relationships) {
        if (!rel.sourceRefs || rel.sourceRefs.length === 0) continue;
        let minStart = Infinity;
        let maxEnd = -Infinity;
        for (const ref of rel.sourceRefs) {
          if (ref.lineStart < minStart) minStart = ref.lineStart;
          if (ref.lineEnd > maxEnd) maxEnd = ref.lineEnd;
        }
        if (!Number.isFinite(minStart) || !Number.isFinite(maxEnd)) continue;
        if (maxEnd - minStart > NARROW_CITATION_MAX_SPAN) continue;

        const citation = `${minStart}-${maxEnd}`;
        const key = `${output.source}|${citation}`;
        let group = groups.get(key);
        if (!group) {
          group = { count: 0, types: new Set() };
          groups.set(key, group);
        }
        group.count++;
        group.types.add(rel.type);
      }
    }

    const smells: SharedSourceRefSmell[] = [];
    for (const [key, group] of groups) {
      if (group.count < SHARED_SOURCEREF_MIN_GROUP) continue;
      const sep = key.indexOf('|');
      smells.push({
        source: key.slice(0, sep),
        citation: key.slice(sep + 1),
        relationshipCount: group.count,
        relationshipTypes: [...group.types],
      });
    }
    return smells.sort((a, b) => b.relationshipCount - a.relationshipCount);
  }

  /**
   * Flag zero-property entities that appear as a relationship endpoint. These are
   * surfaced regardless of the aggregate property-coverage percentage: a high
   * corpus-wide coverage figure can hide a handful of empty entities that only
   * exist to anchor relationships.
   */
  private detectZeroPropertyEndpoints(outputs: ExtractionOutput[]): ZeroPropertyEndpointReport {
    const examples: ZeroPropertyEndpointReport['examples'] = [];
    let count = 0;

    for (const output of outputs) {
      const endpoints = new Set<string>();
      for (const rel of output.relationships) {
        endpoints.add(normalizeLabel(rel.sourceLabel));
        endpoints.add(normalizeLabel(rel.targetLabel));
      }
      for (const entity of output.entities) {
        const hasProps = entity.properties && Object.keys(entity.properties).length > 0;
        if (hasProps) continue;
        const matchesEndpoint =
          endpoints.has(normalizeLabel(entity.label)) ||
          (entity.aliases ?? []).some(a => endpoints.has(normalizeLabel(a)));
        if (!matchesEndpoint) continue;
        count++;
        if (examples.length < 20) {
          examples.push({ source: output.source, entityType: entity.entityType, label: entity.label });
        }
      }
    }

    return { count, examples };
  }

  // ── Aggregate Computation ───────────────────────────────────────

  private computeAggregate(documents: DocumentDiagnostics[]): AggregateMetrics {
    let totalEntities = 0;
    let totalRelationships = 0;
    let zeroPropertyCount = 0;
    let orphanCount = 0;
    let duplicateCount = 0;
    let badLabelCount = 0;
    let truncatedDocumentCount = 0;
    let truncatedChunkCount = 0;
    let totalChunkCount = 0;
    let totalEntitiesSalvaged = 0;
    let totalRelationshipsSalvaged = 0;
    let totalUnsalvageableChunks = 0;
    const entityTypeDistribution: Record<string, number> = {};

    for (const doc of documents) {
      totalEntities += doc.entityCount;
      totalRelationships += doc.relationshipCount;
      zeroPropertyCount += doc.propertyCheck.zeroPropertyCount;
      orphanCount += doc.orphanCheck.orphanCount;
      duplicateCount += doc.duplicateCheck.duplicateCount;
      badLabelCount += doc.labelCheck.badLabelCount;

      if (doc.truncationCheck.wasTruncated) truncatedDocumentCount++;
      truncatedChunkCount += doc.truncationCheck.truncatedChunks;
      totalChunkCount += doc.truncationCheck.totalChunks;
      totalEntitiesSalvaged += doc.truncationCheck.entitiesSalvaged;
      totalRelationshipsSalvaged += doc.truncationCheck.relationshipsSalvaged;
      totalUnsalvageableChunks += doc.truncationCheck.unsalvageableChunks;

      for (const [type, count] of Object.entries(doc.entityTypeDistribution)) {
        entityTypeDistribution[type] = (entityTypeDistribution[type] ?? 0) + count;
      }
    }

    const zeroPropertyPercent = totalEntities > 0 ? (zeroPropertyCount / totalEntities) * 100 : 0;
    const orphanPercent = totalRelationships > 0 ? (orphanCount / totalRelationships) * 100 : 0;
    const coveragePercent = 100 - zeroPropertyPercent;
    const truncationPercent = totalChunkCount > 0 ? (truncatedChunkCount / totalChunkCount) * 100 : 0;

    const propertyCoverageRating = this.ratePropertyCoverage(coveragePercent);
    const orphanRating = this.rateOrphanRate(orphanPercent);
    const duplicateRating: QualityRating = duplicateCount === 0 ? 'good' : 'needs-work';
    const truncationRating = this.rateTruncation(truncationPercent, totalUnsalvageableChunks);

    return {
      totalEntities,
      totalRelationships,
      entityTypeDistribution,
      zeroPropertyCount,
      zeroPropertyPercent: round2(zeroPropertyPercent),
      propertyCoverageRating,
      orphanCount,
      orphanPercent: round2(orphanPercent),
      orphanRating,
      duplicateCount,
      duplicateRating,
      badLabelCount,
      truncatedDocumentCount,
      truncatedChunkCount,
      totalChunkCount,
      truncationPercent: round2(truncationPercent),
      totalEntitiesSalvaged,
      totalRelationshipsSalvaged,
      totalUnsalvageableChunks,
      truncationRating,
      overallRating: worstRating([propertyCoverageRating, orphanRating, duplicateRating, truncationRating]),
    };
  }

  // ── Extraction Output Loading ───────────────────────────────────

  /**
   * Get extraction outputs for active (non-excluded) sources only.
   *
   * Reads extraction files using the source's `selectedExtraction` path.
   * Sources without a selection are skipped.
   */
  private async getActiveExtractionOutputs(sourceFilter?: string[]): Promise<ExtractionOutput[]> {
    const sourceList = await this.state.getSourceList();
    if (!sourceList) return [];

    // Get active sources (not excluded) that have a selected extraction
    let activeSources = sourceList.sources.filter(s => s.status !== 'excluded' && s.selectedExtraction);

    // Apply optional source filter
    if (sourceFilter && sourceFilter.length > 0) {
      activeSources = activeSources.filter(s =>
        sourceFilter.some(f => s.path.includes(f)),
      );
    }

    const stateDir = this.getStateDir();
    const outputs: ExtractionOutput[] = [];
    for (const source of activeSources) {
      try {
        const filePath = join(stateDir, source.selectedExtraction!);
        const content = await readFile(filePath, 'utf-8');
        outputs.push(JSON.parse(content) as ExtractionOutput);
      } catch {
        // File may not exist yet or be corrupt — skip silently
      }
    }
    return outputs;
  }

  /** Get the state directory path from the StateManager */
  private getStateDir(): string {
    return this.state.getStateDirPath();
  }

  // ── Rating Helpers (use configured thresholds) ──────────────────

  private ratePropertyCoverage(coveragePercent: number): QualityRating {
    if (coveragePercent >= this.thresholds.propertyCoverage.good) return 'good';
    if (coveragePercent >= this.thresholds.propertyCoverage.acceptable) return 'acceptable';
    return 'needs-work';
  }

  private rateOrphanRate(orphanPercent: number): QualityRating {
    if (orphanPercent <= this.thresholds.orphanRate.good) return 'good';
    if (orphanPercent <= this.thresholds.orphanRate.acceptable) return 'acceptable';
    return 'needs-work';
  }

  private rateTruncation(truncationPercent: number, unsalvageableChunks: number): QualityRating {
    if (unsalvageableChunks > 0) return 'needs-work';
    if (truncationPercent <= this.thresholds.truncationRate.good) return 'good';
    if (truncationPercent <= this.thresholds.truncationRate.acceptable) return 'acceptable';
    return 'needs-work';
  }
}

function worstRating(ratings: QualityRating[]): QualityRating {
  if (ratings.includes('needs-work')) return 'needs-work';
  if (ratings.includes('acceptable')) return 'acceptable';
  return 'good';
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Generic label normalizer for comparison: case-fold, strip diacritics (NFD +
 * drop combining marks), remove spacing around `-`/`/` separators, and collapse
 * whitespace runs. Domain-agnostic — it knows nothing about any vocabulary.
 */
function normalizeLabel(label: string): string {
  return label
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s*([/-])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when every token in `sub` is present in `sup` and `sup` has strictly more. */
function isStrictTokenSubset(sub: Set<string>, sup: Set<string>): boolean {
  if (sub.size >= sup.size) return false;
  for (const token of sub) {
    if (!sup.has(token)) return false;
  }
  return true;
}

/** Convert a Map<string, number> to sorted array of {label, count} descending by count */
function sortedEntries(map: Map<string, number>): Array<{ label: string; count: number }> {
  return [...map.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}
