import { BaseToolController } from './base/BaseToolController.js';
import { StateManager, Phase, IndexingOrchestrator } from '@utaba/deep-memory-indexer';
import type { PipelinePhase, DocumentDiagnostics, ConsolidationReviewReport, FullValidationProgress, FullValidationReport, ConversionReport, TableCorruptionRecommendation } from '@utaba/deep-memory-indexer';
import { resolveStateDir, resolveConfig } from './resolveProcess.js';

interface DiagnoseCheck {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  detail: string;
  items?: unknown[];
}

export class DiagnoseTool extends BaseToolController {
  get name() { return 'indexing_diagnose'; }
  get description() { return 'Phase-aware quality gate: "Is there anything wrong?" Runs structural/statistical diagnostic checks appropriate to the current pipeline phase and returns actionable findings with example offenders (orphan relationships, bad labels, zero-property entities). No LLM calls. For LLM-based verification of every entity/relationship against source text, advance to the full-validation phase and run indexing_execute.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory (contains config.json).' },
        sourceFilter: {
          type: 'array',
          items: { type: 'string' },
          description: 'Limit diagnostics to specific source(s) by filename or path substring.',
        },
        workerName: { type: 'string', description: 'Run diagnostics on a specific worker\'s outputs (for comparing workers during extraction-review).' },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const phase = await state.getCurrentPhase();

    switch (phase) {
      case Phase.PREPARE:
        return this.diagnosePrepare(params, state, phase);
      case Phase.EXTRACT:
      case Phase.EXTRACTION_REVIEW:
        return this.diagnoseExtraction(params, state, phase, params['workerName'] as string | undefined);
      case 'full-validation' as PipelinePhase:
        return this.diagnoseFullValidation(state, phase);
      case Phase.CONSOLIDATE:
      case 'consolidation-review' as PipelinePhase:
        return this.diagnoseConsolidation(params, phase);
      case Phase.IMPORT:
      case Phase.IMPORT_REVIEW:
        return this.diagnoseImport(state, phase);
      case Phase.EMBEDDINGS:
      case Phase.COMPLETE:
        return this.diagnoseEmbeddings(state, phase);
      default:
        return {
          currentPhase: phase,
          checks: [],
          summary: { passed: 0, warnings: 0, failures: 0 },
          guidance: `No diagnostics available for phase "${phase}".`,
        };
    }
  }

  private async diagnosePrepare(params: Record<string, unknown>, state: StateManager, phase: PipelinePhase) {
    const checks: DiagnoseCheck[] = [];
    const sourceList = await state.getSourceList();

    if (!sourceList) {
      checks.push({
        name: 'source-list',
        status: 'fail',
        detail: 'No source list found. Run indexing_execute to prepare sources first.',
      });
    } else {
      const total = sourceList.sources.length;
      checks.push({
        name: 'source-inventory',
        status: total > 0 ? 'pass' : 'fail',
        detail: `${total} source documents inventoried.`,
      });
    }

    // Conversion diagnostics, sourced from the persisted report. No LLM work —
    // consistent with the tool's contract. Present only after a convert run.
    const conversionReport = await state.getConversionReport<ConversionReport>();
    if (conversionReport && conversionReport.entries.length > 0) {
      this.addConversionChecks(checks, conversionReport);
      await this.addTableStructureCheck(params, checks);
    }

    return this.buildResponse(phase, checks, 'Run indexing_execute to prepare sources and begin extraction.');
  }

  /**
   * Defense-in-depth table-structure check: runs the same static detector the
   * analyze tool uses over the persisted docling sidecars and reports `warn`
   * when any converted document looks suspect/corrupt, `pass` when all are
   * clean. Post-extraction-safe — it only reads the sidecars on disk. The
   * per-file re-convert remediation rides in the check detail and items.
   */
  private async addTableStructureCheck(params: Record<string, unknown>, checks: DiagnoseCheck[]): Promise<void> {
    let recommendations: TableCorruptionRecommendation[];
    try {
      const { config } = await resolveConfig(params);
      const orchestrator = new IndexingOrchestrator(config);
      recommendations = await orchestrator.detectTableCorruption();
    } catch (error) {
      checks.push({
        name: 'table-structure',
        status: 'warn',
        detail: `Could not run table-structure detection: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }

    if (recommendations.length === 0) {
      checks.push({
        name: 'table-structure',
        status: 'pass',
        detail: 'No table-structure corruption detected in converted documents.',
      });
      return;
    }

    checks.push({
      name: 'table-structure',
      status: 'warn',
      detail:
        `${recommendations.length} converted document(s) show possible table-structure corruption. ` +
        `Re-convert each flagged file with sourceConvertOptions { tableCellMatching: false } via indexing_update, ` +
        `then reset it to pending and re-extract. Conversion is the fix site, not extraction.`,
      items: recommendations.map(r => ({
        source: r.source,
        rating: r.rating,
        message: r.message,
        evidence: r.evidence.slice(0, 5),
        remediation: r.remediation,
      })),
    });
  }

  /**
   * Append conversion-quality checks read from the conversion report: warnings
   * carried per document, table counts (so a PDF that dropped all its tables is
   * visible), and conversions running far slower than their peers (the signal
   * that a document is OCR-bound or otherwise pathological).
   */
  private addConversionChecks(checks: DiagnoseCheck[], report: ConversionReport): void {
    const converted = report.entries.filter(e => e.status === 'converted');

    // 1) Warnings carried by any conversion.
    const withWarnings = report.entries.filter(e => e.warnings.length > 0);
    checks.push({
      name: 'conversion-warnings',
      status: withWarnings.length > 0 ? 'warn' : 'pass',
      detail: withWarnings.length > 0
        ? `${withWarnings.length} conversion(s) carried warnings. For a text-light PDF that should not run OCR (e.g. a slide or diagram deck), set "doOcr": false on that source to suppress the OCR fallback.`
        : 'No conversion warnings.',
      items: withWarnings.length > 0
        ? withWarnings.map(e => ({ source: e.docSlug, warnings: e.warnings.slice(0, 5) }))
        : undefined,
    });

    // 2) Tables recovered per document — a doc reporting zero tables may have
    //    dropped them, which is worth an operator's eye.
    checks.push({
      name: 'tables-extracted',
      status: 'pass',
      detail: `${report.summary.totalTables} table(s) recovered across ${converted.length} converted document(s).`,
      items: converted.length > 0
        ? converted.map(e => ({ source: e.docSlug, tables: e.tableCount ?? 0, pages: e.pageCount }))
        : undefined,
    });

    // 3) Conversions far slower than the median — OCR-bound or pathological.
    const durations = converted.map(e => e.durationMs).filter(ms => ms > 0).sort((a, b) => a - b);
    if (durations.length >= 3) {
      const median = durations[Math.floor(durations.length / 2)]!;
      const slow = converted.filter(e => median > 0 && e.durationMs > median * 3);
      checks.push({
        name: 'slow-conversions',
        status: slow.length > 0 ? 'warn' : 'pass',
        detail: slow.length > 0
          ? `${slow.length} conversion(s) ran more than 3× the median (${median}ms) — likely OCR-bound. If such a document is born-digital, set "doOcr": false on it to skip the OCR pass.`
          : `All conversions ran within a normal range of the median (${median}ms).`,
        items: slow.length > 0
          ? slow.map(e => ({ source: e.docSlug, durationMs: e.durationMs, ocrApplied: e.doOcr }))
          : undefined,
      });
    }
  }

  private async diagnoseExtraction(
    params: Record<string, unknown>,
    _state: StateManager,
    phase: PipelinePhase,
    workerName?: string,
  ) {
    const checks: DiagnoseCheck[] = [];
    const sourceFilter = params['sourceFilter'] as string[] | undefined;

    // Structural validation + review diagnostics — no LLM work.
    // LLM-based verification of every entity/relationship belongs to the full-validation phase.
    try {
      const { config } = await resolveConfig(params);
      const orchestrator = new IndexingOrchestrator(config);

      // Run Tier 1 validation
      const validationResults = await orchestrator.validate();
      const passed = validationResults.filter(r => r.overallVerdict === 'pass').length;
      const warnings = validationResults.filter(r => r.overallVerdict === 'warnings').length;
      const failed = validationResults.filter(r => r.overallVerdict === 'fail').length;
      const totalErrors = validationResults.reduce((sum, r) => sum + r.errors.length, 0);
      const totalWarnings = validationResults.reduce((sum, r) => sum + r.warnings.length, 0);

      checks.push({
        name: 'tier1-validation',
        status: failed > 0 ? 'fail' : warnings > 0 ? 'warn' : 'pass',
        detail: `${validationResults.length} extractions: ${passed} passed, ${warnings} with warnings, ${failed} failed (${totalErrors} errors, ${totalWarnings} warnings)`,
        items: failed > 0 ? validationResults.filter(r => r.overallVerdict === 'fail').map(r => ({
          source: r.source,
          errors: r.errors.slice(0, 5),
        })) : undefined,
      });

      // Run review diagnostics (optionally for a specific worker)
      const report = await orchestrator.reviewDiagnostics(sourceFilter, workerName);
      const a = report.aggregate;

      checks.push({
        name: 'property-coverage',
        status: a.propertyCoverageRating === 'good' ? 'pass' : a.propertyCoverageRating === 'acceptable' ? 'warn' : 'fail',
        detail: `${(100 - a.zeroPropertyPercent).toFixed(1)}% entities have properties (${a.zeroPropertyCount} with zero)`,
      });

      // Collect orphan examples and missing-label counts across all documents in the report.
      // ReviewDiagnostics already captures these at the per-document level; surface them here
      // so callers don't have to open the raw extraction files to see the offenders.
      const orphanExamples: Array<{ source: string; relationshipType: string; sourceLabel: string; targetLabel: string; missingSource: boolean; missingTarget: boolean }> = [];
      const missingSourceLabelCounts = new Map<string, number>();
      const missingTargetLabelCounts = new Map<string, number>();
      for (const doc of report.documents) {
        for (const ex of doc.orphanCheck.examples) {
          orphanExamples.push({ source: doc.source, ...ex });
        }
        for (const ml of doc.orphanCheck.missingSourceLabels) {
          missingSourceLabelCounts.set(ml.label, (missingSourceLabelCounts.get(ml.label) ?? 0) + ml.count);
        }
        for (const ml of doc.orphanCheck.missingTargetLabels) {
          missingTargetLabelCounts.set(ml.label, (missingTargetLabelCounts.get(ml.label) ?? 0) + ml.count);
        }
      }
      const topMissingSources = [...missingSourceLabelCounts.entries()]
        .sort((a1, b1) => b1[1] - a1[1])
        .slice(0, 10)
        .map(([label, count]) => ({ label, count }));
      const topMissingTargets = [...missingTargetLabelCounts.entries()]
        .sort((a1, b1) => b1[1] - a1[1])
        .slice(0, 10)
        .map(([label, count]) => ({ label, count }));

      checks.push({
        name: 'orphan-relationships',
        status: a.orphanRating === 'good' ? 'pass' : a.orphanRating === 'acceptable' ? 'warn' : 'fail',
        detail: `${a.orphanCount} / ${a.totalRelationships} orphan relationships (${a.orphanPercent}%)`,
        items: orphanExamples.length > 0 ? [
          { kind: 'examples', relationships: orphanExamples.slice(0, 20) },
          { kind: 'missingSourceLabels', labels: topMissingSources },
          { kind: 'missingTargetLabels', labels: topMissingTargets },
        ] : undefined,
      });

      // Status reflects only normalized exact duplicates. Token-subset pairs are
      // candidates, not confirmed duplicates — compound/hierarchical names
      // legitimately nest (e.g. "Main Street" within "Main Street Bridge") — so
      // they must not downgrade the corpus rating.
      checks.push({
        name: 'duplicates',
        status: a.duplicateRating === 'good' ? 'pass' : 'warn',
        detail: `${a.duplicateCount} normalized-duplicate entities detected`,
        items: report.documents
          .flatMap(d => d.duplicateCheck.duplicates.map(dup => ({ source: d.source, ...dup })))
          .slice(0, 20),
      });

      // Separate, informational listing of token-subset pairs: candidates for the
      // agent to verify, kept out of the pass/fail rating above.
      const tokenSubsetTotal = report.documents.reduce((sum, d) => sum + d.duplicateCheck.tokenSubsetCount, 0);
      if (tokenSubsetTotal > 0) {
        const possibleDuplicateExamples = report.documents
          .flatMap(d => d.duplicateCheck.possibleDuplicates.map(pd => ({ source: d.source, ...pd })));
        checks.push({
          name: 'possible-duplicates',
          status: 'pass',
          detail: `${tokenSubsetTotal} possible duplicate(s) by token-subset — one label's words are contained in another's (e.g. "Main Street" within "Main Street Bridge"). Candidates to verify, not counted as duplicates.`,
          items: possibleDuplicateExamples.slice(0, 20),
        });
      }

      const badLabelExamples = report.documents
        .flatMap(d => d.labelCheck.examples.map(ex => ({ source: d.source, ...ex })));
      checks.push({
        name: 'label-quality',
        status: a.badLabelCount === 0 ? 'pass' : 'warn',
        detail: `${a.badLabelCount} entities with bad labels`,
        items: badLabelExamples.length > 0 ? badLabelExamples.slice(0, 20) : undefined,
      });

      const zeroPropertyExamples = report.documents
        .flatMap(d => d.propertyCheck.examples.map(ex => ({ source: d.source, ...ex })));
      if (zeroPropertyExamples.length > 0) {
        checks.push({
          name: 'zero-property-entities',
          status: 'warn',
          detail: `${a.zeroPropertyCount} entities with zero properties`,
          items: zeroPropertyExamples.slice(0, 20),
        });
      }

      // Zero-property entities that anchor relationships — surfaced regardless of
      // the aggregate coverage rating, which can otherwise average these away.
      const endpoints = report.zeroPropertyEndpoints;
      if (endpoints && endpoints.count > 0) {
        checks.push({
          name: 'zero-property-endpoints',
          status: 'warn',
          detail: `${endpoints.count} zero-property entit${endpoints.count === 1 ? 'y is a' : 'ies are'} relationship endpoint(s) — placeholder nodes that exist only to anchor edges.`,
          items: endpoints.examples.slice(0, 20),
        });
      }

      // Fabrication smells: labels enumerating a controlled vocabulary, and many
      // relationships hanging off one narrow source passage.
      const smells = report.fabricationSmells;
      if (smells && smells.enumChecklist.length > 0) {
        checks.push({
          name: 'controlled-vocabulary-as-entities',
          status: 'warn',
          detail: `${smells.enumChecklist.length} entity type(s) whose labels enumerate the type's controlled vocabulary rather than being read from source — a fabrication smell.`,
          items: smells.enumChecklist.map(s => ({
            entityType: s.entityType,
            matched: `${s.matchedCount}/${s.distinctLabelCount} labels match ${s.controlledValueCount} controlled values`,
            examples: s.examples,
          })),
        });
      }
      if (smells && smells.sharedSourceRefs.length > 0) {
        checks.push({
          name: 'cross-product-relationships',
          status: 'warn',
          detail: `${smells.sharedSourceRefs.length} narrow source passage(s) cited by many relationships — a cross-product fabrication smell.`,
          items: smells.sharedSourceRefs.slice(0, 20),
        });
      }

      // Check 6: Truncation detection
      if (a.truncatedChunkCount > 0 || a.totalUnsalvageableChunks > 0) {
        checks.push({
          name: 'truncation',
          status: a.truncationRating === 'good' ? 'pass' : a.truncationRating === 'acceptable' ? 'warn' : 'fail',
          detail: `${a.truncatedChunkCount} / ${a.totalChunkCount} LLM calls truncated (${a.truncationPercent}%). ` +
            `${a.totalEntitiesSalvaged} entities and ${a.totalRelationshipsSalvaged} relationships salvaged from partial output.` +
            (a.totalUnsalvageableChunks > 0 ? ` ${a.totalUnsalvageableChunks} chunks lost entirely — increase maxOutputTokens.` : ' Increase maxOutputTokens to avoid data loss.'),
        });
      } else if (a.totalChunkCount > 0) {
        checks.push({
          name: 'truncation',
          status: 'pass',
          detail: `No LLM output truncation detected across ${a.totalChunkCount} calls.`,
        });
      }

      // Vocabulary conformance — validate extraction output against the domain
      // vocabulary via core's validator (unknown/endpoint types, required
      // properties, closed-enum values). Honours the configured governance
      // mode: locked violations fail, managed/open violations warn. A bad input
      // (e.g. an unreadable vocabulary file) degrades only this check to a warn,
      // never the whole diagnose tool.
      try {
        const conformance = await orchestrator.conformanceDiagnostics(sourceFilter);
        const conformanceStatus: DiagnoseCheck['status'] =
          conformance.violationCount === 0
            ? 'pass'
            : conformance.severity === 'fail'
              ? 'fail'
              : 'warn';
        checks.push({
          name: 'vocabulary-conformance',
          status: conformanceStatus,
          detail: conformance.violationCount === 0
            ? `Extraction output conforms to the vocabulary (${conformance.mode} mode).`
            : `${conformance.violationCount} vocabulary conformance violation(s) under ${conformance.mode} mode — ` +
              `${conformance.countsByClass['unknown-type']} unknown-type, ` +
              `${conformance.countsByClass['endpoint-type']} endpoint-type, ` +
              `${conformance.countsByClass['required-property-missing']} required-property-missing, ` +
              `${conformance.countsByClass['closed-enum-value']} closed-enum-value` +
              (conformance.recommendations.length > 0
                ? `; ${conformance.recommendations.length} vocabulary-extension recommendation(s).`
                : '.'),
          items: conformance.violationCount > 0
            ? [
                { kind: 'countsByClass', counts: conformance.countsByClass },
                { kind: 'examples', violations: conformance.examples },
                ...(conformance.recommendations.length > 0
                  ? [{ kind: 'recommendations', recommendations: conformance.recommendations }]
                  : []),
              ]
            : undefined,
        });
      } catch (error) {
        checks.push({
          name: 'vocabulary-conformance',
          status: 'warn',
          detail: `Could not run vocabulary conformance: ${error instanceof Error ? error.message : String(error)}`,
        });
      }

      // Flag documents needing attention
      const needsWork = report.documents.filter((d: DocumentDiagnostics) => d.overallRating === 'needs-work');
      if (needsWork.length > 0) {
        checks.push({
          name: 'documents-needing-attention',
          status: 'warn',
          detail: `${needsWork.length} documents have quality issues`,
          items: needsWork.map((d: DocumentDiagnostics) => ({
            source: d.source,
            rating: d.overallRating,
            orphanPercent: d.orphanCheck.orphanPercent,
            zeroPropertyPercent: d.propertyCheck.zeroPropertyPercent,
            duplicateCount: d.duplicateCheck.duplicateCount,
          })),
        });
      }

      // Multi-worker comparison: surface per-worker scores and recommendation
      if (report.workerComparison) {
        const wc = report.workerComparison;
        checks.push({
          name: 'worker-comparison',
          status: 'warn',
          detail: `${wc.workers.length} workers compared. Recommended: "${wc.recommended}". ${wc.reason}`,
          items: wc.workers.map(w => ({
            worker: w.workerName,
            documentsAnalyzed: w.documentsAnalyzed,
            overallRating: w.aggregate.overallRating,
            entities: w.aggregate.totalEntities,
            relationships: w.aggregate.totalRelationships,
            propertyCoverage: `${(100 - w.aggregate.zeroPropertyPercent).toFixed(1)}%`,
            orphanRate: `${w.aggregate.orphanPercent}%`,
            duplicates: w.aggregate.duplicateCount,
            badLabels: w.aggregate.badLabelCount,
          })),
        });

        checks.push({
          name: 'per-source-comparison',
          status: 'warn',
          detail: `Per-source worker comparison for ${wc.sourceComparisons.length} source(s)`,
          items: wc.sourceComparisons.map(sc => ({
            source: sc.source,
            recommended: sc.recommended,
            workers: sc.workers.map(w => ({
              worker: w.workerName,
              overallRating: w.overallRating,
              entities: w.entityCount,
              relationships: w.relationshipCount,
              propertyCoverage: `${w.propertyCoveragePercent}%`,
              orphanRate: `${w.orphanPercent}%`,
              duplicates: w.duplicateCount,
              badLabels: w.badLabelCount,
            })),
          })),
        });

        checks.push({
          name: 'worker-selection-needed',
          status: 'warn',
          detail: `Some sources have no selectedExtraction. Use indexing_update to set selectedExtraction for each source, or accept recommendation "${wc.recommended}".`,
        });
      }

    } catch (error) {
      checks.push({
        name: 'diagnostics-error',
        status: 'fail',
        detail: `Failed to run diagnostics: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    const guidance = phase === Phase.EXTRACTION_REVIEW
      ? 'Review findings above. Fix extraction files, then run indexing_update to advance to the next phase.'
      : 'Review findings above. Continue extraction or fix issues as needed.';

    return this.buildResponse(phase, checks, guidance);
  }

  private async diagnoseFullValidation(state: StateManager, phase: PipelinePhase) {
    const checks: DiagnoseCheck[] = [];
    const progress = await state.getFullValidationProgress<FullValidationProgress>();
    const report = await state.getFullValidationReport<FullValidationReport>();

    if (!progress) {
      checks.push({
        name: 'validation-progress',
        status: 'warn',
        detail: 'No full validation progress found.',
      });
    } else {
      const verdicts = progress.verdicts;
      const totalVerdicts = verdicts.confirmed + verdicts.mismatch + verdicts.hallucinated + verdicts.unverifiable + verdicts.corrected;
      const issueCount = verdicts.mismatch + verdicts.hallucinated + verdicts.unverifiable;

      checks.push({
        name: 'validation-verdicts',
        status: issueCount === 0 ? 'pass' : issueCount <= totalVerdicts * 0.1 ? 'warn' : 'fail',
        detail: `${totalVerdicts} verdicts: ${verdicts.confirmed} confirmed, ${issueCount} issues (${verdicts.mismatch} mismatch, ${verdicts.hallucinated} hallucinated, ${verdicts.unverifiable} unverifiable)`,
      });
    }

    if (report && report.corrections.length > 0) {
      checks.push({
        name: 'pending-corrections',
        status: 'warn',
        detail: `${report.corrections.length} proposed corrections awaiting review`,
        items: report.corrections.slice(0, 10),
      });
    }

    return this.buildResponse(phase, checks,
      'Review validation results. Apply corrections with indexing_execute action "apply-corrections", then indexing_update to advance.');
  }

  private async diagnoseConsolidation(params: Record<string, unknown>, phase: PipelinePhase) {
    const checks: DiagnoseCheck[] = [];

    try {
      const { config } = await resolveConfig(params);
      const orchestrator = new IndexingOrchestrator(config);
      const report: ConsolidationReviewReport = await orchestrator.consolidationReviewDiagnostics();

      checks.push({
        name: 'merge-confidence',
        status: report.mergeConfidence.rating === 'good' ? 'pass' : report.mergeConfidence.rating === 'acceptable' ? 'warn' : 'fail',
        detail: `${report.mergeConfidence.highConfidenceCount} high, ${report.mergeConfidence.mediumConfidenceCount} medium, ${report.mergeConfidence.lowConfidenceCount} low confidence merges`,
        items: report.mergeConfidence.lowConfidenceCount > 0 ? report.mergeConfidence.flaggedEvents.slice(0, 5) : undefined,
      });

      checks.push({
        name: 'alias-specificity',
        status: report.aliasSpecificity.rating === 'good' ? 'pass' : 'warn',
        detail: `${report.aliasSpecificity.flaggedCount} alias specificity warnings`,
        items: report.aliasSpecificity.flaggedCount > 0 ? report.aliasSpecificity.flaggedAliases.slice(0, 5) : undefined,
      });

      checks.push({
        name: 'type-consistency',
        status: report.typeConsistency.rating === 'good' ? 'pass' : 'warn',
        detail: `${report.typeConsistency.flaggedCount} type consistency flags`,
        items: report.typeConsistency.flaggedCount > 0 ? report.typeConsistency.flaggedMerges.slice(0, 5) : undefined,
      });

      checks.push({
        name: 'cross-source-merges',
        status: 'pass',
        detail: `${report.crossSourceMerges.totalCrossSourceEntities} entities merged across source documents`,
      });
    } catch (error) {
      checks.push({
        name: 'consolidation-diagnostics-error',
        status: 'fail',
        detail: `Failed to run consolidation diagnostics: ${error instanceof Error ? error.message : String(error)}`,
      });
    }

    return this.buildResponse(phase, checks,
      'Review merge quality. Run indexing_update to advance to import, or indexing_execute with action "reconsolidate" to re-run after corrections.');
  }

  private async diagnoseImport(state: StateManager, phase: PipelinePhase) {
    const checks: DiagnoseCheck[] = [];
    const sourceList = await state.getSourceList();
    const registry = await state.getRegistry();

    if (registry) {
      const importedCount = registry.entities.filter(e => e.status === 'imported').length;
      const totalCount = registry.entities.length;
      checks.push({
        name: 'import-completeness',
        status: importedCount === totalCount ? 'pass' : 'warn',
        detail: `${importedCount} / ${totalCount} entities imported`,
      });
    }

    if (sourceList) {
      const importedSources = sourceList.sources.filter(s => s.status === 'imported').length;
      const totalSources = sourceList.sources.filter(s => s.status !== 'excluded').length;
      checks.push({
        name: 'source-import-status',
        status: importedSources === totalSources ? 'pass' : 'warn',
        detail: `${importedSources} / ${totalSources} sources imported`,
      });
    }

    return this.buildResponse(phase, checks,
      'Review import results. Run indexing_update with phase "embeddings" to proceed.');
  }

  private async diagnoseEmbeddings(state: StateManager, phase: PipelinePhase) {
    const checks: DiagnoseCheck[] = [];
    const embeddingProgress = await state.getEmbeddingProgress<{ status: string; processed: number; totalEntities: number; failed: number }>();

    if (embeddingProgress) {
      checks.push({
        name: 'embedding-coverage',
        status: embeddingProgress.processed === embeddingProgress.totalEntities ? 'pass' : 'warn',
        detail: `${embeddingProgress.processed} / ${embeddingProgress.totalEntities} entities embedded`,
      });

      if (embeddingProgress.failed > 0) {
        checks.push({
          name: 'embedding-failures',
          status: 'warn',
          detail: `${embeddingProgress.failed} entities failed embedding`,
        });
      }
    } else {
      checks.push({
        name: 'embedding-progress',
        status: phase === Phase.COMPLETE ? 'warn' : 'pass',
        detail: 'No embedding progress found.',
      });
    }

    return this.buildResponse(phase, checks,
      phase === Phase.COMPLETE ? 'Pipeline complete. Knowledge graph is ready to query.' : 'Run indexing_execute to generate embeddings.');
  }

  private buildResponse(
    phase: PipelinePhase,
    checks: DiagnoseCheck[],
    guidance: string,
  ) {
    const passed = checks.filter(c => c.status === 'pass').length;
    const warnings = checks.filter(c => c.status === 'warn').length;
    const failures = checks.filter(c => c.status === 'fail').length;

    return {
      currentPhase: phase,
      checks,
      summary: { passed, warnings, failures },
      guidance,
    };
  }
}
