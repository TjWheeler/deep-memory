import { BaseToolController } from './base/BaseToolController.js';
import { StateManager, Phase } from '@utaba/deep-memory-indexer';
import { resolveStateDir } from './resolveProcess.js';

/**
 * Phase-aware tool that returns detailed instructions for the current pipeline phase.
 * Reads the current phase from state and returns step-by-step guidance, common mistakes,
 * and user checkpoint reminders.
 */
export class PhaseGuidanceTool extends BaseToolController {
  get name() { return 'indexing_current_phase_guidance'; }
  get description() { return 'Get detailed guidance for the current pipeline phase. Returns step-by-step instructions, what to check, what to ask the user, common mistakes to avoid, and how to advance. Call this whenever you enter a new phase or are unsure what to do next.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {
        processDir: { type: 'string', description: 'Path to the indexing process directory.' },
      },
      required: ['processDir'],
    };
  }

  protected async handleExecute(params: Record<string, unknown>) {
    const stateDir = resolveStateDir(params);
    const state = new StateManager(stateDir);
    const phase = await state.getCurrentPhase();

    const guidance = PHASE_GUIDANCE[phase];
    if (!guidance) {
      return {
        content: [{ type: 'text', text: `No specific guidance available for phase "${phase}". Run indexing_analyze to check pipeline state.` }],
      };
    }

    return {
      content: [{ type: 'text', text: guidance }],
    };
  }
}

const PHASE_GUIDANCE: Record<string, string> = {
  [Phase.PREPARE]: `# Phase: PREPARE

## What this phase does
Source inventory is already built by \`indexing_init\`. This phase is for reviewing
and adjusting before extraction begins.

## Steps
1. Run \`indexing_analyze verbose: true\` to review the source inventory and cost estimates
2. **Assign workers to sources for parallelism.** Parallelism is per-source, not per-file —
   the indexer runs workers concurrently only when different sources have different
   \`assignedWorkers\`. Pick one of these patterns and apply it with \`indexing_update\`:
   - **Fastest bulk run (same model):** Distribute sources round-robin across N same-model workers.
     Example: \`indexing_update source: "A.md" sourceWorkers: "cloud-haiku-1"\`,
     \`indexing_update source: "B.md" sourceWorkers: "cloud-haiku-2"\`, etc.
   - **Model comparison (different models):** Assign multiple workers to the **same** source — each
     runs the full file, producing separate extraction-notes outputs to diff.
     Example: \`indexing_update source: "A.md" sourceWorkers: "cloud-haiku,cloud-sonnet"\`.
   - ⚠️ **Do NOT assign multiple workers with the same model to the same source.** Each worker
     processes 100% of the file — you pay double for identical results. Multi-worker on one source
     only makes sense when comparing *different* models.
   - ⚠️ **Unassigned sources serialize.** With no \`sourceWorkers\`, every source runs on the default
     extraction endpoint, one at a time. If you configured multiple workers but skipped assignment,
     you lose the parallelism you paid to set up.
3. **🛑 STOP — Present the following to the user and wait for their explicit approval:**
   - List of source documents (filename, size, assigned worker(s))
   - Estimated extraction cost per source and total
   - Worker configuration (model, concurrency, cost rates)
   - Quality thresholds (from config.json)
   - Any sources that look problematic (very large, wrong format, etc.)
4. If the user wants changes:
   - Use \`indexing_update\` to exclude sources (\`sourceStatus: "excluded"\`)
   - Use \`indexing_update\` to reassign workers (\`sourceWorkers: "worker-name"\`)
   - Use \`indexing_update\` to adjust quality thresholds (\`qualityThresholds: { ... }\`)
5. Run \`indexing_analyze\` again to confirm changes
6. **Only after the user explicitly approves**, run \`indexing_update phase: "extract"\` to advance

## Table-structure corruption (converted PDFs)
\`indexing_analyze\` and \`indexing_diagnose\` run a static, deterministic detector over each converted
document — comparing the rendered Markdown against the \`{slug}.docling.json\` structural grid. It never
rewrites anything; it raises a non-blocking recommendation you verify and act on. When either tool reports
a \`conversionRecommendations\` entry or a \`table-structure\` warn check, follow this loop:
1. **Detect** — a document is flagged \`suspect\` or \`corrupt\` (e.g. a wide table fragmented into several
   narrow Markdown sub-tables, a "Refer to Clause X" deferral scattered into a column of short codes, or
   split cells that reconstruct an intact phrase).
2. **Self-verify** — open the converted Markdown table, compare it against the source PDF region and the
   \`{slug}.docling.json\` grid. Confirm the columns really did merge/fragment before acting.
3. **Remediate (re-convert — this is the fix site, not extraction)** — apply the recommendation's exact
   call: \`indexing_update source: "<file>" sourceConvertOptions: { tableCellMatching: false }\`. Setting the
   options auto-queues that one file for re-conversion — it stops docling matching table predictions back to
   raw PDF cells, the behaviour that fragments merged/dense columns. Extraction only consumes the Markdown
   and cannot repair it, so re-extracting alone will not help.
4. **Re-convert, then re-extract** — run \`indexing_execute\` (convert phase) to re-convert the file with
   cell-matching disabled; it returns to \`pending\` automatically. Then re-run extraction scoped to that
   file and re-run \`indexing_analyze\` to confirm the flag cleared.

**Trade-off — why per-file, not global:** \`table_cell_matching=false\` wins on merged/dense tables but
ignores real PDF text cells, so it is *not* universally better. Set it only on the documents that fragment.
If a file was already converted with the flag and still flags, the detector says so and stops recommending
the re-convert (it needs manual or structure-aware handling instead) — do not loop the same fix.

## 🚫 DO NOT
- Do NOT call \`indexing_update phase: "extract"\` without user approval
- Do NOT call \`indexing_execute\` in the extract phase without user approval
- Do NOT skip showing the user the cost estimates — even if costs seem trivial
- Do NOT assign multiple same-model workers to a single source (duplicate cost, no benefit)

## Common mistakes
- **Advancing to extract without user approval** — this is the #1 mistake. The user must see
  costs and sources and say "go ahead" before you proceed. No exceptions.
- **Skipping worker assignment** — if you configured 3 workers but left sources unassigned,
  everything runs serially on the default worker. You paid to set up parallelism; use it.
- **Assigning multiple same-model workers to one source** — pure cost duplication. Multi-worker
  per source is *only* for comparing different models.
- Not excluding very large documents that should be chunked separately

## Advance when
- User has reviewed the source list, cost estimates, and worker assignments
- User has explicitly approved (e.g., "looks good", "go ahead", "approved")
`,

  [Phase.EXTRACT]: `# Phase: EXTRACT

## What this phase does
Sends each document to the assigned LLM worker for entity and relationship extraction.
This runs in the background — use \`indexing_status\` to poll progress.

## Steps
1. Run \`indexing_execute\` to start extraction (runs in background)
2. Run \`indexing_status\` periodically to check progress
3. When complete, review any failed sources in the status output
4. For failed sources: use \`indexing_update\` to clear errors (\`clearError: true\`) and retry,
   or reassign to a different worker (\`sourceWorkers: "cloud-haiku"\`)
5. When all sources are extracted, run \`indexing_update phase: "extraction-review"\`

## Common mistakes
- Calling \`indexing_execute\` repeatedly while extraction is running (starts new operation!)
- Not checking for failed sources before advancing
- Using Haiku for prose-heavy manuals (it fabricates specific numbers like weights and durations)
- Setting maxOutputTokens above your API tier limit (causes Sonnet timeouts)

## 🛑 User checkpoints (mandatory — do not skip)
- **Show the user** the extraction summary: sources extracted, entities/relationships found, cost
- **Ask the user** if any failed sources should be retried or excluded
- **Wait for explicit approval** before advancing to extraction-review

## Advance when
- All desired sources show status "extracted" (some may be excluded)
- **User has explicitly approved** advancing to extraction-review
`,

  [Phase.EXTRACTION_REVIEW]: `# Phase: EXTRACTION REVIEW

## What this phase does
Quality gate before consolidation. Run diagnostics to catch structural and semantic issues.

## Steps
1. Run \`indexing_diagnose\` (quick scope) to get structural diagnostics
2. Review with the user:
   - **Orphan relationships** — relationships referencing entities that don't exist (thresholds in config.json \`qualityThresholds.extraction.orphanRate\`)
   - **Property coverage** — entities with zero properties (thresholds in config.json \`qualityThresholds.extraction.propertyCoverage\`)
   - **Duplicate entities** — same entity extracted with different labels
   - **Bad labels** — labels that don't match vocabulary conventions
3. If multi-worker extraction was used, compare worker outputs:
   - \`indexing_diagnose workerName: "cloud-haiku"\` vs \`indexing_diagnose workerName: "cloud-sonnet"\`
   - Use \`indexing_update sourceSelectedExtraction: "best-worker"\` to pick the best output per source
4. If quality is poor on specific sources, consider re-extraction:
   - \`indexing_update source: "file.md" sourceStatus: "pending"\` (resets to re-extract)
   - \`indexing_update source: "file.md" sourceWorkers: "cloud-sonnet"\` (reassign to better model)
   - \`indexing_update phase: "extract"\` then \`indexing_execute sourceFilter: ["file.md"]\`
   - **Garbled tables (empty-property artifact entities, values in the wrong columns) are a *conversion*
     defect, not an extraction one** — re-extracting the same Markdown reproduces them. Re-run
     \`indexing_diagnose\` and check the \`table-structure\` finding. To fix: \`indexing_update source: "file.pdf"
     sourceConvertOptions: { tableCellMatching: false }\` auto-queues that file for re-conversion (disables
     docling matching table predictions back to raw PDF cells, which fragments merged/dense columns); run
     \`indexing_execute\` (convert) to re-convert, then re-extract that file. \`table_cell_matching=false\` is
     per-file, not global — it ignores real PDF text cells, so it only wins on merged/dense tables.

## Next step: choose a path
After diagnostics pass, present BOTH options to the user:
1. **Full validation** — \`indexing_update phase: "full-validation"\` — LLM re-reads each entity/relationship
   against the source document to catch hallucinations, mismatches, and errors. Recommended for first runs,
   new models, or safety-critical domains. Has an LLM cost.
2. **Skip to consolidation** — \`indexing_update phase: "consolidate"\` — proceed directly to entity
   deduplication without LLM verification. Appropriate when extraction quality is high and the domain is
   well-understood.

**You MUST present both options and let the user choose.** Do not default to consolidation.

## Common orphan patterns (from real runs)
1. **Alias vs canonical name** — model used "CAT 325F" but entity label is "Caterpillar 325F L Hydraulic Excavator"
2. **Generic systems not extracted** — relationship references "hydraulic system" but no entity for it
3. **Slug-style labels** — model output lowercase slugs instead of proper labels
4. **Model variant grouping** — specific variants referenced but extracted as grouped entity

## 🛑 User checkpoints (mandatory — do not skip)
- **Show the user** the diagnostic summary (orphans, coverage, duplicates)
- **Ask the user** whether to proceed to consolidation, run full validation, or re-extract problem sources
- **Wait for explicit approval** before advancing

## Advance when
- Diagnostics pass the configured quality thresholds (set in config.json \`qualityThresholds\`)
- **User has explicitly chosen** either full-validation or consolidation
- Use \`indexing_update phase: "full-validation"\` or \`indexing_update phase: "consolidate"\`
- To tighten/loosen thresholds: \`indexing_update qualityThresholds: { ... }\`
`,

  ['full-validation' as string]: `# Phase: FULL VALIDATION

## What this phase does
LLM re-reads each entity and relationship, comparing against the source document to find
hallucinations, mismatches, and errors. Then a structured correction-review loop applies
the safe, mechanical fixes (entity/relationship property updates, hallucination deletes),
while surfacing judgment calls to the user.

## Prerequisites
The \`fullValidation\` section must exist in config.json with at least one worker.
**Validator model MUST differ from the extraction model** — validating haiku-extracted data
with haiku is biased. Use sonnet or opus as judge when extraction was done by haiku.
\`\`\`json
"fullValidation": {
  "workers": [{
    "name": "cloud-sonnet",
    "llmProvider": "anthropic",
    "model": "claude-sonnet-4-6",
    "maxBatchSize": 10,
    "maxTokens": 4096,
    "costPerMillionInputTokens": 3.00,
    "costPerMillionOutputTokens": 15.00,
    "concurrency": 1
  }],
  "defaultWorker": "cloud-sonnet",
  "batchSize": 10
}
\`\`\`

## Step 1 — Run validation
1. \`indexing_execute dryRun: true\` — preview item count and estimated cost
2. **🛑 Show the user** the cost estimate and wait for explicit approval
3. \`indexing_execute\` — starts validation in the background
4. \`indexing_status\` — poll until complete
5. \`indexing_diagnose\` — view verdict breakdown (confirmed / mismatch / hallucinated / unverifiable)
   and the list of proposed corrections grouped by operation

## Step 2 — Correction review (THIS IS A USER-GATED LOOP)
Four correction operations exist, each with a different risk profile:
| Operation | Risk | Default threshold |
|---|---|---|
| \`entity:update\` / \`relationship:update\` | Low — property value fix | minConfidence 0.8 |
| \`entity:remove-property\` / \`relationship:remove-property\` | Low — clears a fabricated value | minConfidence 0.8 |
| \`entity:delete\` | Medium — removes entity AND cascades all its relationships | minConfidence 0.9 |
| \`relationship:delete\` | Low — removes one relationship | minConfidence 0.9 |

Steps:
1. \`indexing_execute action: "apply-corrections"\` (no \`corrections\` arg) — lists all proposals with indices, operations, and confidence
2. **🛑 Show the user** the correction summary grouped by operation and the highest-risk items (deletes, low-confidence updates)
3. **🛑 Wait for user approval** on:
   - Threshold for auto-approve (e.g. \`approveAll: true, minConfidence: 0.85\`)
   - Any specific indices to include/exclude (via \`approvedIndices\`)
4. \`indexing_execute action: "apply-corrections" corrections: { approveAll: true, minConfidence: 0.85 }\`
   → this is still a dry run by default. Review the planned changes in the response.
5. **🛑 Show the user** the dry-run plan and wait for explicit "apply it" before mutating.
6. \`indexing_execute action: "apply-corrections" corrections: { ... } dryRun: false\`
   → actually mutates extraction files. A timestamped backup is written to
   \`state/extraction-notes-backups/<timestamp>/\` before any file is changed, and writes
   are atomic (tmp + rename).
7. Inspect the structured result: \`applied\`, \`skipped\`, \`failed\`, \`cascaded\`. Cascaded
   relationships are those removed automatically when their entity was deleted — verify
   these were the right call.
8. Re-run \`indexing_diagnose\` to confirm the extraction state is clean.

## Step 3 — Manual items
\`unverifiable\` verdicts and low-confidence items never auto-apply. Present them to
the user for case-by-case judgment; they may need source-document review.

## Common mistakes
- **Using the same model for validation and extraction** — bias. Validator must be different.
- **Forgetting dryRun defaults to TRUE for apply-corrections** — if nothing seems to be
  changing, you likely still need \`dryRun: false\` on the final call.
- **Accepting all corrections without reviewing the deletes** — entity deletes cascade.
  Always review these individually with the user.
- **Running validation on all sources when only specific ones need it** — use \`sourceFilter\`.
- **Not setting \`maxCost\`** — validation can be expensive on large graphs.

## Model-specific accuracy patterns
- **Haiku extractions**: fabricated hard numbers (weights, durations, temperatures)
- **Sonnet extractions**: soft property inferences (skillLevel, partType values not in source)
- Both: entity type misclassifications

## 🛑 User checkpoints (mandatory — do not skip)
- Show cost estimate before validation runs
- Show verdict breakdown and correction summary before apply
- Show dry-run plan before mutating (\`dryRun: false\`)
- Confirm extraction state is clean after apply before advancing

## Advance when
- Corrections applied (or explicitly skipped) and user has reviewed the post-apply state
- Use \`indexing_update phase: "consolidate"\`
`,

  [Phase.CONSOLIDATE]: `# Phase: CONSOLIDATE

## What this phase does
Deduplicates entities across all documents, assigns stable GUIDs, resolves relationship
references, and builds the export archive for import.

## Steps
1. Run \`indexing_execute\` to consolidate
2. Review the consolidation summary (merged entities, orphaned relationships)
3. Run \`indexing_update phase: "consolidation-review"\` to enter review

## Common mistakes
- Not reviewing merge results — entities from different documents may be incorrectly merged
- Entity duplication across documents is the #1 consolidation challenge

## Advance when
- Consolidation completes without errors
`,

  ['consolidation-review' as string]: `# Phase: CONSOLIDATION REVIEW

## What this phase does
Quality gate for merge results before importing into the knowledge graph.

## Steps
1. Run \`indexing_diagnose\` to check merge quality
2. Review with user:
   - **Merge confidence** — low-confidence merges may be incorrect
   - **Cross-source merges** — entities merged across different documents (verify these are correct)
   - **Type consistency** — merged entities should have the same type
3. If issues found: \`indexing_execute action: "reconsolidate"\` after corrections

## 🛑 User checkpoints (mandatory — do not skip)
- **Show the user** merge statistics and any low-confidence merges
- **Ask the user** to approve before importing
- **Wait for explicit approval** before advancing

## Advance when
- **User has explicitly approved** merge quality
- Use \`indexing_update phase: "import"\`
`,

  [Phase.IMPORT]: `# Phase: IMPORT

## What this phase does
Loads the consolidated entity/relationship archive into the deep-memory repository.

## Steps
1. Run \`indexing_execute\` to import
2. Check for warnings: orphaned relationships (references to missing entities), overwritten entities
3. Run \`indexing_update phase: "embeddings"\` to continue (or "import-review" if warnings)

## Common mistakes
- Importing without a valid repository ID configured
- Not checking for orphaned relationships after import
- Re-importing without clearing previous import (use \`memory_delete_repository deleteContentsOnly: true\`
  then wait before re-importing — CosmosDB needs time for consistency)

## Advance when
- Import completes with acceptable warning count
- Use \`indexing_update phase: "embeddings"\`
`,

  [Phase.IMPORT_REVIEW]: `# Phase: IMPORT REVIEW (Optional)

## What this phase does
Review import results before generating embeddings, especially if import produced warnings.

## Steps
1. Review import warnings: orphaned relationships, overwritten entities
2. Run \`indexing_diagnose\` to check import completeness
3. If serious issues found, consider re-importing after corrections

## 🛑 User checkpoints (mandatory — do not skip)
- **Show the user** any import warnings
- **Ask the user** to approve before proceeding to embeddings
- **Wait for explicit approval** before advancing

## Advance when
- **User has explicitly approved** import results
- Use \`indexing_update phase: "embeddings"\`
`,

  [Phase.EMBEDDINGS]: `# Phase: EMBEDDINGS

## What this phase does
Generates embedding vectors for all entities, enabling semantic search.

## Steps
1. Run \`indexing_execute\` — shows cost estimate first
2. **Ask the user** to confirm the estimated cost
3. Run \`indexing_execute confirm: true\` to start (runs in background)
4. Run \`indexing_status\` to poll progress
5. When complete, run \`indexing_update phase: "complete"\`

## Semantic search tips from real runs
- Default similarity threshold of 0.7 is too high for technical domains — lower to 0.5
- Equipment/component queries score 0.70+, troubleshooting queries score 0.55-0.59
- Embedding model quality matters — Qwen3-Embedding-8B works well for technical content

## Advance when
- All entities have embeddings
- Use \`indexing_update phase: "complete"\`
`,

  [Phase.COMPLETE]: `# Phase: COMPLETE

## Pipeline finished
The knowledge graph is ready to query using the deep-memory MCP server tools.

## What you can do now
- Use \`memory_find_entities\` and \`memory_search_by_concept\` to query the graph
- Use \`memory_explore_neighborhood\` to traverse relationships
- Use \`memory_get_timeline\` for temporal queries
- Use \`memory_get_stats\` to see repository statistics

## If you need to re-run any phase
- Use \`indexing_update phase: "phase-name"\` to move back to any previous phase
- Re-extraction requires resetting source statuses to "pending" first
`,
};
