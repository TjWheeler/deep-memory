# @utaba/deep-memory-indexer-mcp-server

MCP server for driving the [`@utaba/deep-memory-indexer`](https://www.npmjs.com/package/@utaba/deep-memory-indexer) pipeline. Exposes 9 phase-aware tools that consolidate the indexer's functionality into a simple **analyze → diagnose → execute** loop. Separate from [`@utaba/deep-memory-local-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-local-mcp-server) which handles repository queries.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-indexer @utaba/deep-memory-indexer-mcp-server
```

## Claude Code / Desktop Integration

Add to `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "deep-memory-indexer": {
      "command": "node",
      "args": ["node_modules/@utaba/deep-memory-indexer-mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Code after editing `.mcp.json`.

## How the 9 tools fit together

The agent drives the pipeline using **analyze → diagnose → execute** for work, and **update** for phase transitions. `indexing_execute` does work; `indexing_update` changes phases — these are deliberately separated so advancing the pipeline is always an explicit decision.

| Tool | One-liner |
|------|-----------|
| `indexing_getting_started` | Pipeline overview — call once before starting any indexing work |
| `indexing_current_phase_guidance` | Phase-specific step-by-step instructions |
| `indexing_init` | Initialize a new indexing process directory |
| `indexing_analyze` | "Where are we, what do we have, what happens next?" |
| `indexing_diagnose` | "Is there anything wrong?" — phase-aware quality gate |
| `indexing_execute` | "Do the next thing" — never advances phases |
| `indexing_update` | Move between phases, update source configuration |
| `indexing_status` | Poll progress of background operations |
| `indexing_stop` | Stop a running pipeline |

All tools accept `processDir` as their primary parameter. Config is loaded from `config.json` + `config.secrets.json` in the process directory.

## Tool reference

### `indexing_getting_started`

Returns a comprehensive guide to the indexing pipeline. Call this before starting any indexing work to understand the phases, tools, and workflow. **No parameters.**

### `indexing_current_phase_guidance`

Returns detailed step-by-step instructions for the current pipeline phase — what to check, what to ask the user, common mistakes to avoid, and how to advance.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |

### `indexing_init`

Initialize a new indexing process directory.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the new process directory |
| `name` | Yes | Human-readable name for the process |
| `starterKit` | Yes | Path to the starter kit directory |
| `repositoryId` | Yes | Target deep-memory repository ID |
| `sourceDir` | Yes | Path to source documents |
| `extractionEndpoint` | Yes | Default LLM endpoint |
| `extractionModel` | Yes | Default model name |
| `workers` | No | Worker pool configuration array |

### `indexing_analyze`

Phase-aware orientation: *"Where are we, what do we have, what happens next?"* This is the primary tool for understanding pipeline state. Call it first in any conversation and whenever you need a status update. Returns phase-specific information, guidance for next steps, and pipeline navigation (`nextPhase`, `availablePhases`).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |
| `sourceFilter` | No | Filter to a specific source for detailed view |
| `verbose` | No | Include per-source detail (default: summary only) |

**Phase-specific output:**

| Phase | Returns |
|-------|---------|
| Prepare | Source inventory summary, cost estimates if analyzed |
| Extract | Extraction progress, token usage, active/failed sources |
| Extraction Review | Entity/relationship counts, diagnostics summary if available |
| Full Validation | Validation progress, verdicts, accuracy rate, cost |
| Consolidate | Pre-consolidation entity/relationship counts |
| Consolidation Review | Merge confidence, alias specificity, cross-source merges |
| Import | Archive availability, repository ID |
| Import Review | Import warnings, source status counts |
| Embeddings | Embedding progress, model info, ETA |
| Complete | Full pipeline summary — documents, entities, relationships, cost |

### `indexing_diagnose`

Phase-aware quality gate: *"Is there anything wrong? What should I check?"* Runs diagnostic checks appropriate to the current phase. Returns structured findings with pass/warn/fail status.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |
| `scope` | No | `quick` (structural only, no LLM) or `full` (adds LLM verification). Default: `quick` |
| `sourceFilter` | No | Limit diagnostics to specific source(s) |
| `maxBatches` | No | Limit LLM verification batches (cost control, `full` scope) |
| `maxCost` | No | Maximum USD spend on LLM verification |
| `workerName` | No | Run diagnostics on a specific worker's outputs (for comparing workers) |

**Phase-specific checks:**

| Phase | Quick scope | Full scope (adds) |
|-------|-------------|-------------------|
| Extract / Extraction Review | Tier 1 validation, property coverage, orphan relationships, duplicates, label quality | LLM verification (Full Validation) |
| Full Validation | Validation verdicts, pending corrections | — |
| Consolidate / Consolidation Review | Merge confidence, alias specificity, type consistency, cross-source merges | — |
| Import | Import completeness | — |
| Embeddings / Complete | Embedding coverage, failures | — |

### `indexing_execute`

Phase-aware action: *"Do the next thing."* Executes the primary action for the current phase. For review phases, returns structured guidance. **This tool never advances phases** — use `indexing_update` to move between phases.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |
| `action` | No | Override the default action. Supported: `prepare`, `analyze`, `convert`, `extract`, `validate-full`, `apply-corrections`, `consolidate`, `reconsolidate`, `import`, `resume`, `embed` |
| `maxItems` | No | Limit documents processed (extraction and conversion) |
| `sourceFilter` | No | Filter to specific source(s) |
| `corrections` | No | For `apply-corrections`: `{ approveAll?: boolean, approvedIndices?: number[], minConfidence?: number }`. `approveAll` applies corrections above `minConfidence` (default `0.8`). `approvedIndices` is an array of specific indices from `indexing_diagnose` output. |
| `confirm` | No | Confirm to proceed (embed phase: start after seeing cost estimate) |
| `dryRun` | No | Preview without running. Supported for: `convert`, `extract`, `validate-full`, `consolidate`, `import`, `apply-corrections` |
| `resolutions` | No | Import checkpoint resolutions: map of flagged item index → `"accept"` / `"reject"` / `"correct"` |

**Phase-specific actions:**

| Phase | Default action | Available actions |
|-------|---------------|-------------------|
| Prepare | Scan source directory, initialize state | `prepare`, `analyze`, `convert` |
| Extract | Run extraction on pending sources (background) | `extract` |
| Extraction Review | Return review guidance + checklist | — |
| Full Validation | Run LLM validation in background | `validate-full`, `apply-corrections` |
| Consolidate | Run consolidation | `consolidate` |
| Consolidation Review | Return review guidance | `reconsolidate` |
| Import | Import archive into repository | `import`, `resume` |
| Import Review | Return review guidance | — |
| Embeddings | Generate embeddings (estimate first, confirm to proceed) | `embed` |

**Converting rich-format sources.** `.pdf/.docx/.html/.htm/.pptx` sources are registered as `needs-conversion` during prepare and must be converted to Markdown before extraction. Start the conversion service — `docker compose -f docker-compose.indexer.yml --profile docling-worker up -d` — configure `services.docling.endpoint` in `config.json` to match its host port, then run `action: convert` (background, like extract). Poll `indexing_status` until conversion completes. Extraction refuses to run while any source still needs conversion.

### `indexing_update`

Move between pipeline phases and update source document configuration. Phase transitions are deliberately separated from `indexing_execute` — advancing or rewinding the pipeline is a deliberate decision, not an automatic side effect.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |
| `phase` | No | Target phase. Valid: `prepare`, `extract`, `extraction-review`, `full-validation`, `consolidate`, `consolidation-review`, `import`, `import-review`, `embeddings`, `complete` |
| `source` | No | Source document path or filename to update (required when updating source fields) |
| `sourceStatus` | No | New status: `pending`, `extracting`, `deduplicating`, `extracted`, `consolidated`, `imported`, `validated`, `excluded`. **Warning:** `excluded` permanently removes the source. `pending` clears extraction artifacts. |
| `sourceWorkers` | No | Comma-separated worker names to assign (e.g. `"cloud-haiku,qwen35-35b"`) |
| `sourceSelectedExtraction` | No | Worker name whose extraction output to select for downstream phases |
| `sourceStatusReason` | No | Reason for the status change (logged) |
| `clearError` | No | Clear error state and reset attempt count on the source |
| `sourceOrder` | No | Reorder source: a number (0-based index), or `"start"` / `"end"` / `"up"` / `"down"` |

### `indexing_status`

Check progress of any running or recently completed indexing operation. Lightweight polling tool — call repeatedly while waiting for long-running background operations (extraction, validation, embeddings).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |

Returns: current phase, operation type, running/idle status, progress percentage, ETA, per-worker details, failure information. Detects stale process locks (process died but progress files remain).

### `indexing_stop`

Stop a running pipeline. Writes a stop signal that workers check between operations (extraction batches, embedding batches, validation batches). Resets any sources stuck in `extracting` back to `pending`.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `processDir` | Yes | Path to the indexing process directory |
| `reason` | No | Reason for stopping (logged) |

## Agent workflow example

```
Agent: indexing_getting_started
       → Returns pipeline overview and tool reference

Agent: indexing_init       processDir: ./index-processes/fleet  name: "Fleet KG"  ...
Agent: indexing_execute    processDir: ./index-processes/fleet
       → Prepared 10 source documents

Agent: indexing_analyze    processDir: ./index-processes/fleet
       → Cost estimate: $0.12, 10 documents, 23 chunks

Agent: indexing_execute    processDir: ./index-processes/fleet
       → Extraction started for 10 sources (background)

Agent: indexing_status     processDir: ./index-processes/fleet
       → Extraction: 5/10 complete, 50%, ETA: 2m
       [repeat until complete]

Agent: indexing_update     processDir: ./index-processes/fleet  phase: "extraction-review"
Agent: indexing_diagnose   processDir: ./index-processes/fleet
       → 2 warnings: 5 orphan relationships, 1 bad label

Agent: indexing_update     processDir: ./index-processes/fleet  phase: "consolidate"
Agent: indexing_execute    processDir: ./index-processes/fleet
       → Consolidation complete: 2,841 entities in registry

Agent: indexing_update     processDir: ./index-processes/fleet  phase: "import"
Agent: indexing_execute    processDir: ./index-processes/fleet
       → Import complete: 2,841 entities, 3,543 relationships

Agent: indexing_update     processDir: ./index-processes/fleet  phase: "embeddings"
Agent: indexing_execute    processDir: ./index-processes/fleet
       → Embedding estimate: 2,841 entities, $0.002
Agent: indexing_execute    processDir: ./index-processes/fleet  confirm: true
       → Embedding started (background)

Agent: indexing_update     processDir: ./index-processes/fleet  phase: "complete"
Agent: indexing_analyze    processDir: ./index-processes/fleet
       → Complete. 2,841 entities, 3,543 relationships.
```

## LLM provider detection

If [`@utaba/deep-memory-indexer-llm-anthropic`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-llm-anthropic) is installed alongside this server, workers configured with `"llmProvider": "anthropic"` automatically use the native Anthropic API with prompt caching. No extra MCP server configuration needed.

## See also

- [`@utaba/deep-memory-indexer`](https://www.npmjs.com/package/@utaba/deep-memory-indexer) — the pipeline this server drives
- [`@utaba/deep-memory-local-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-local-mcp-server) — sibling MCP server for repository queries
