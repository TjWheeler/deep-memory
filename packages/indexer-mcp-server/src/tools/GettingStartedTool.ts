import { BaseToolController } from './base/BaseToolController.js';

/**
 * Stateless tool that returns a comprehensive guide to the deep-memory indexing pipeline.
 * No processDir required — this is meant to be called before any indexing work begins.
 */
export class GettingStartedTool extends BaseToolController {
  get name() { return 'indexing_getting_started'; }
  get description() { return 'Return a guide to the deep-memory indexing pipeline. Call this before starting any indexing work to understand the phases, tools, and workflow. No parameters required.'; }
  get inputSchema() {
    return {
      type: 'object',
      properties: {},
      required: [],
    };
  }

  protected async handleExecute(_params: Record<string, unknown>) {
    return {
      content: [{ type: 'text', text: GETTING_STARTED_GUIDE }],
    };
  }
}

const GETTING_STARTED_GUIDE = `# Deep-Memory Indexing Pipeline

## Overview
The indexing pipeline transforms source documents (PDFs, manuals, contracts, specs) into a
structured knowledge graph. An AI agent drives the pipeline using 9 MCP tools.

## The 9 Tools

| Tool | Purpose | When to use |
|------|---------|-------------|
| \`indexing_getting_started\` | This guide | Before starting any indexing work |
| \`indexing_current_phase_guidance\` | Detailed phase instructions | At each phase for step-by-step guidance |
| \`indexing_init\` | Create a new indexing process | Once per project |
| \`indexing_analyze\` | Check pipeline state & progress | First call in every conversation, and to check status |
| \`indexing_diagnose\` | Quality checks & validation | Before advancing to catch issues early |
| \`indexing_execute\` | Run the current phase's action | To do the work (extract, consolidate, import, embed) |
| \`indexing_update\` | Change phase or update sources | To advance/retreat phases, reassign workers, exclude sources |
| \`indexing_status\` | Poll background operations | While extraction/validation/embedding is running |
| \`indexing_stop\` | Gracefully stop background work | To pause long-running operations |

## Pipeline Phases (in order)

1. **prepare** — Scan source directory, estimate costs, assign workers
2. **extract** — LLM reads each document, extracts entities and relationships
3. **extraction-review** — Quality diagnostics: orphans, duplicates, property coverage
4. **full-validation** *(optional)* — LLM re-verifies each entity/relationship against source text. **Use a smarter model than extraction** (see "Full Validation Model Selection" below)
5. **consolidate** — Deduplicate entities across documents, assign GUIDs, build archive
6. **consolidation-review** *(optional)* — Review merge quality before import
7. **import** — Load consolidated archive into deep-memory repository
8. **import-review** *(optional)* — Check import warnings before embedding
9. **embeddings** — Generate embedding vectors for semantic search
10. **complete** — Knowledge graph ready to query

## Critical Workflow Rules

- **NEVER advance phases or start work without user approval.** Every phase has a user gate.
  You MUST present the relevant information (costs, sources, diagnostics) to the user AND
  receive explicit approval before calling \`indexing_update\` to advance or \`indexing_execute\`
  to start costly operations. This is the #1 rule — violating it wastes money and trust.
- **\`indexing_execute\` does work, \`indexing_update\` changes phases.** These are deliberately
  separated. Never expect execute to advance the phase automatically.
- **Always run \`indexing_diagnose\` before advancing** from extraction-review or consolidation-review.
  Skipping quality checks is the #1 cause of poor knowledge graphs.
- **Use \`indexing_current_phase_guidance\`** at each phase for detailed instructions on what to do,
  what to check, and when to involve the user. Follow it step by step — do not skip steps.
- **Use \`indexing_status\` to poll** background operations (extraction, validation, embeddings).
  Don't call execute repeatedly — it starts new operations, not checks progress.

## Starter Kits

Starter kits provide pre-built vocabularies for common domains. Pass the path to \`indexing_init\`:
- \`index-starterkits/mining/\` — Mining equipment, fleet operations, maintenance
- \`index-starterkits/council/\` — Local government planning, zones, land use
- \`index-starterkits/legal/\` — Contracts, clauses, obligations, rights
- \`index-starterkits/person/\` — Contact networks, team directories, genealogy
- \`index-starterkits/conversations/\` — AI memory: interests, preferences, goals

**Entity Identity Pattern:** Some entity types (e.g. Person) can have multiple real-world instances sharing the same label. These domains use Identity entities — separate nodes holding disambiguating constants (name, DOB, serial number) linked via \`IS_IDENTITY_FOR\`. Each domain's vocabulary declares whether identity is used. See \`docs/identity-pattern.md\` for the full pattern.

## Model Selection Summary

| Model | Best for | Cost | Quality |
|-------|----------|------|---------|
| Opus | Critical/complex documents, highest accuracy | $$$ | Highest |
| Sonnet | Bulk extraction, good cost/quality balance | $$ | High |
| Haiku | Structured spec sheets, exploratory passes | $ | Good (caution: fabricates numbers on prose) |
| Qwen 3.5-35B (local) | Development, validation, zero cost | Free | Moderate (higher orphan rate) |

## Full Validation Model Selection

**Full Validation must use a smarter (more capable) model than the one used for Extraction.** An LLM cannot reliably catch its own mistakes — asking the same model that produced the extraction to verify it is a rubber-stamp, not a check. Only a stronger model can spot the misreads, hallucinations, and subtle property errors that a weaker extractor produces.

Pairings (extraction → validation):

| Extraction model | Validation model |
|------------------|------------------|
| Haiku | **Sonnet** (minimum) or Opus |
| Sonnet | **Opus** |
| Opus | Opus (use a more conservative prompt; there is no stronger tier) |
| Qwen 3.5-35B / local | **Sonnet or Opus** — never validate a local extraction with another local model |

The validation worker is configured separately from the extraction worker in \`config.json\`. When you advance to the \`full-validation\` phase, confirm with the user that the validation endpoint/model is set to a stronger tier than extraction before calling \`indexing_execute\`.

**Recommended backstop for fabrication-prone corpora.** The extraction prompt already discourages fabrication — it tells the model that a list of allowed values is a naming vocabulary rather than a checklist of entities to create, and that a cross-reference or deferral cell ("Refer to Clause X") is not a property value. That is a prompt-level guardrail, and prompts are not perfectly reliable. For corpora where fabrication is a known risk — dense tables, closed-enum properties, spec sheets, regulatory documents with cross-references — run \`full-validation\` with a stronger model as the verification backstop. It re-checks each extracted item against the source text and catches the fabricated entities and forced property values that slip past the extraction prompt. Treat it as recommended rather than optional whenever data fidelity matters more than run cost.

## Worker Assignment & Parallelism

Workers run in parallel **across different source files**, not within a single file. You control this by assigning workers to sources with \`indexing_update source: "<file>" sourceWorkers: "<worker-name>"\` (comma-separated for multiple).

### Rules

- **Different workers on different files → parallelism.** Assign \`cloud-haiku-1\` to file A and \`cloud-haiku-2\` to file B and they extract simultaneously.
- **Multiple workers on the same file → model comparison only.** Each assigned worker processes the **entire file, 100%**. Results land in separate \`extraction-notes/<worker>/<file>.json\` outputs. Pick the best one with \`sourceSelectedExtraction\` during extraction-review.
- **Same model on the same file is pure waste.** If the workers use the same model (e.g. \`cloud-haiku-1\` and \`cloud-haiku-2\` both pointing at \`claude-haiku-4-5\`), you pay double for identical results. Only assign multiple workers to one file when the models differ (e.g. haiku vs sonnet vs opus) and you want to compare outputs.
- **Unassigned sources serialize.** If no \`sourceWorkers\` is set, the indexer uses the default extraction worker for every source, processing them one at a time (bounded by \`extraction.concurrency\`). Always assign workers explicitly if you want to exploit a multi-worker config.

### Typical patterns

| Goal | Strategy |
|------|----------|
| Fastest bulk run, one model | N workers of the same model, round-robin-assign each source to one worker |
| Compare models on a small sample | Multiple workers of different models, same source assigned to all of them |
| Budget run with a local fallback | Assign cheap/local worker to most sources, cloud worker to the few that need it |
| Retry a failed source | \`indexing_update source: "file.md" clearError: true sourceWorkers: "cloud-sonnet"\` |

### What happens during \`indexing_execute\`

The extractor reads each pending source's \`assignedWorkers\` (set via \`sourceWorkers\`) and dispatches a job per (source, worker) pair. Pairs run concurrently up to \`extraction.concurrency\` at the pipeline level and each worker's own \`concurrency\` slot count. When no explicit assignment exists, it falls back to the top-level \`extraction.endpoint\`/\`extraction.model\`.

## Getting Started Sequence

1. \`indexing_init\` — Create process with starter kit (also scans source directory)
2. \`indexing_analyze\` — Review source inventory, workers, and cost estimates
3. **🛑 USER GATE — Present sources, workers, and cost estimates to the user. Wait for approval.**
4. \`indexing_update phase: "extract"\` — Advance to extract (only after user approves)
5. \`indexing_analyze\` — Preview extraction plan
6. \`indexing_execute\` — Start extraction
7. \`indexing_status\` — Poll until complete
8. **🛑 USER GATE — Report extraction results and costs to the user.**
9. \`indexing_update phase: "extraction-review"\` — Enter review
10. \`indexing_diagnose\` — Check quality
11. **🛑 USER GATE — Present diagnostics. Get approval before consolidation.**
12. Continue through phases (each has its own user gates — see \`indexing_current_phase_guidance\`)

**Pattern for every phase:** \`analyze\` (preview) → 🛑 user approval → \`execute\` (do work) → \`analyze\`/\`diagnose\` (review results).

**Every 🛑 USER GATE is mandatory.** Do not call the next tool until the user responds.
Call \`indexing_current_phase_guidance\` at each phase for the full checklist.
`;
