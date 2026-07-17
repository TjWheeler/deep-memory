# @utaba/deep-memory-indexer

Document indexing pipeline for [`@utaba/deep-memory`](https://www.npmjs.com/package/@utaba/deep-memory). Extracts structured knowledge from source documents using LLMs and imports it into a deep-memory repository.

Designed for **AI–human collaboration**: AI handles extraction and consolidation at scale; humans define vocabularies, tune strategies, and review validation results. The pipeline is fully resumable — each phase persists state to disk, so an interrupted run picks up exactly where it stopped.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-indexer
```

For driving the pipeline via MCP tools (recommended), also install:

```bash
pnpm add @utaba/deep-memory-indexer-mcp-server
```

## Pipeline phases

```
Source Documents
    |
A.   Prepare         — scan directory, register sources
A.5  Convert         — (rich formats only) render PDF/DOCX/HTML/PPTX to Markdown
B.   Extract         — LLM workers extract entities + relationships (parallel)
B.6  Review          — structural diagnostics + property accuracy spot-checks
B.7  Full Validate   — (optional) LLM agents verify every entity against source
C.   Consolidate     — deduplicate across documents, assign GUIDs, build archive
C.5  Review          — merge confidence, alias specificity, cross-source audit
D.   Import          — import into repository (with periodic checkpoints)
E.   Embeddings      — generate embedding vectors for semantic search
```

| Phase | Input | Output | Resumable |
|-------|-------|--------|-----------|
| A — Prepare | Source directory | `index-source-list.json` | Yes — skips already-registered sources |
| A.5 — Convert | Rich-format sources | `state/converted/{slug}.md` + `{slug}.docling.json` | Yes — content-hash skips unchanged sources |
| B — Extract | Pending sources | `extraction-notes/{worker-name}/*.json` | Yes — skips already-extracted sources |
| B.5 — Validate | Extraction outputs | `validation-report.json` | Yes |
| B.6 — Extraction Review | Extraction outputs + source docs | `review-diagnostics.json` + corrections | AI runs, human approves |
| B.7 — Full Validation | Extraction outputs + source docs | `full-validation-report.json` | Yes — batch checkpoints |
| C — Consolidate | All extraction outputs | Entity registry + `consolidation-merge-log.json` | Yes — idempotent rebuild |
| C.5 — Consolidation Review | Entity registry + merge log | `consolidation-review-diagnostics.json` | Re-run after re-consolidation |
| D — Import | ExportArchive | Entities in repository | Yes — checkpoints track progress |
| E — Embeddings | Imported entities | Embeddings stored on entities | Yes |

Pipeline states: `prepare` | `extract` | `extraction-review` | `full-validation` | `consolidate` | `consolidation-review` | `import` | `import-review` | `embeddings` | `complete`

## Supported source formats

| Format | Extensions | Handling |
|--------|-----------|----------|
| Plain text | `.md`, `.txt`, `.json`, `.csv` | Read directly by extraction |
| Rich documents | `.pdf`, `.docx`, `.html`, `.htm`, `.pptx` | Converted to Markdown before extraction |

Rich-format sources are registered with status `needs-conversion` during prepare. The **convert** step renders each to Markdown under `state/converted/{slug}.md` (recorded as `derivedTextPath` on the source), writes a structural JSON sidecar `state/converted/{slug}.docling.json`, and flips the source to `pending`; everything downstream reads the derived text. Extraction refuses to run against an unconverted rich-format source.

Conversion runs against a containerised [`docling-serve`](https://github.com/docling-project/docling-serve) service. Start it before converting:

```bash
docker compose -f docker-compose.indexer.yml --profile docling-worker up -d
```

The `docling-worker` profile is gated so a repo with no rich-format sources never starts the (~4.4 GB) container. Configure the service in `config.json`:

```jsonc
{
  "services": {
    "docling": {
      "endpoint": "http://localhost:5001",  // match the docling-worker host port
      "mode": "async",                        // submit + poll; the default. "sync" is the escape hatch
      "timeoutMs": 600000,                    // per-request ceiling (each submit/poll/result call)
      "maxRetries": 3
      // OCR is decided per document — omit doOcr to let the heuristic run.
      // "doOcr": false                       // force OCR off globally (or set per source)
      // "ocrTextYieldThreshold": 100          // chars-per-page floor below which a PDF is re-run with OCR
    }
  }
}
```

Then run convert before extraction:

```
indexing_execute processDir: ./index-processes/my-knowledge action: convert
```

Poll `indexing_status` until conversion completes, then proceed to `indexing_analyze` / `indexing_execute` as usual.

### How convert behaves

- **Idempotent.** Each source's raw bytes are hashed (`sourceHash`). A re-run skips any source whose hash is unchanged and whose derived files still exist — no round trip — and reports it as `skipped-unchanged`. Editing a source on disk is detected at prepare: its stale derived files are deleted and it is reset to `needs-conversion` so the next convert reprocesses it.
- **Asynchronous by default.** `mode: "async"` submits each conversion and polls for the result, so a large document no longer fails against the service's synchronous wait ceiling; there is no single-request timeout over the whole job. `indexing_status` shows the live queue position and elapsed time while polling. `mode: "sync"` keeps one request open — use it only for an older container without the async routes (an async submit that 404s says so and names the switch).
- **OCR is decided per document.** Non-PDF formats carry text natively and never run OCR. For a PDF with no explicit `doOcr`, convert runs a fast no-OCR pass and only re-runs with OCR when the text yield per page falls below `ocrTextYieldThreshold` (default 100 chars/page) — so scanned PDFs get OCR while born-digital ones stay fast. A text-light born-digital PDF (a slide or diagram deck) can trip this; set `doOcr: false` on that source to opt out. An explicit `doOcr` (per source or global) skips the heuristic entirely.
- **Diagnostics.** Every run writes `state/conversion-report.json` (per-document mode, OCR decision, page/table counts, warnings, timing) plus a compact mirror on each source entry. `indexing_diagnose` in the prepare phase surfaces conversion warnings, table counts, and conversions running far slower than their peers; `indexing_status` shows the run summary once it completes.
- **The JSON sidecar** (`{slug}.docling.json`) is docling's structural representation, retained alongside the Markdown for richer downstream use.

## Quick start (via MCP — recommended)

The recommended way to use the indexer is through **named indexing processes** — a directory containing config, secrets, and pipeline state for a specific job. Drive it via [`@utaba/deep-memory-indexer-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-mcp-server):

```
indexing_init
  processDir: ./index-processes/my-knowledge
  name: My Knowledge Graph
  starterKit: ./index-starterkits/person
  repositoryId: <uuid>
  sourceDir: ./index-content/person
  extractionEndpoint: http://localhost:8020/v1
  extractionModel: Qwen/Qwen3-4B
```

This creates:

```
index-processes/my-knowledge/
├── config.json              All config except secrets
├── config.secrets.json      API keys (gitignored)
├── process-state.md         AI-maintained iteration journal
└── state/                   Pipeline state (auto-managed)
```

| File | Purpose |
|------|---------|
| `config.json` | All configuration: extraction workers, consolidation, validation. Everything except secrets. |
| `config.secrets.json` | API keys for cloud workers. Merged into config at runtime. **Gitignored.** |
| `process-state.md` | AI-maintained journal tracking iteration history, current phase, and decisions. |
| `state/` | Pipeline state directory — source list, extraction notes, analysis reports, validation reports. Auto-managed by the orchestrator. |

Then drive the pipeline with `indexing_execute` (do work), `indexing_analyze` (status), `indexing_diagnose` (quality gate), and `indexing_update` (phase transitions). See [`@utaba/deep-memory-indexer-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-mcp-server) for the full tool surface.

## Programmatic usage

For lower-level control without the MCP layer:

```typescript
import { IndexingOrchestrator } from '@utaba/deep-memory-indexer';

const orchestrator = new IndexingOrchestrator({
  stateDir: './state',
  vocabularyPath: './vocabulary.md',
  repositoryId: 'my-repo',
  extraction: {
    endpoint: 'http://localhost:8020/v1',
    model: 'Qwen/Qwen3-4B',
    concurrency: 1,
  },
  consolidation: {
    endpoint: 'http://localhost:8020/v1',
    model: 'Qwen/Qwen3-4B',
  },
  import: { storage: { type: 'inmemory' } },
});

await orchestrator.prepare('./source-docs');
await orchestrator.extract();
await orchestrator.consolidate();
await orchestrator.import();
```

## Multi-worker routing

Define a worker pool to route documents to the best worker based on size, capability, and cost.

```json
{
  "workers": [
    {
      "name": "local-qwen-4b",
      "endpoint": "http://localhost:8020/v1",
      "model": "Qwen/Qwen3-4B",
      "contextWindow": 32768,
      "maxChunkSize": 20000,
      "maxOutputTokens": 4096,
      "costPerMillionInputTokens": 0,
      "costPerMillionOutputTokens": 0,
      "concurrency": 1,
      "capabilities": ["structured-extraction"]
    },
    {
      "name": "cloud-haiku",
      "endpoint": "https://api.anthropic.com/v1",
      "model": "claude-haiku-4-5-20251001",
      "contextWindow": 200000,
      "maxChunkSize": 100000,
      "maxOutputTokens": 8192,
      "costPerMillionInputTokens": 0.80,
      "costPerMillionOutputTokens": 4.00,
      "concurrency": 3,
      "capabilities": ["structured-extraction", "prose-extraction", "large-context"]
    }
  ]
}
```

### Assignment algorithm

For each document, the orchestrator:

1. **Filters by capability** — match document type to required capabilities (spec sheets need `structured-extraction`, O&M manuals need `prose-extraction`).
2. **Filters by context fit** — documents exceeding a worker's context window (even with chunking) are excluded unless the worker has `large-context`.
3. **Prefers fewest chunks** — among viable workers, prefers those that can process the document in fewer chunks.
4. **Prefers cheapest** — among workers with equal chunk counts, picks the one with the lowest cost per token.

### Intelligent retry

When `autoReassignFailures: true`, the orchestrator catches extraction failures and reassigns the document to a more capable worker:

- **Context-window errors** → reassign to a worker with a larger context window
- **JSON parse / output errors** → reassign to a more capable (typically higher-cost) worker
- **Generic failures** → try the next cheapest viable upgrade

Failed documents track `lastError` and `attempts` in the source list.

### Cost estimation with actuals

`indexing_analyze` estimates tokens using a character-to-token ratio (default 1:4) and output-density factors by document type. After extraction, actual token usage from the LLM response is saved on each source's `actualTokens` field. On subsequent analysis runs, actuals replace estimates — so cost projections become more accurate with each pass.

## Configuration reference

```typescript
interface OrchestratorConfig {
  stateDir: string;                    // Path to persistent state directory
  vocabularyPath: string;              // Path to vocabulary file
  extractionRulesPath?: string;        // Path to indexing strategy
  repositoryId: string;                // Target repository ID
  extraction: {
    endpoint: string;                  // OpenAI-compatible endpoint
    model: string;                     // Model name
    concurrency: number;               // Max concurrent workers
    maxTokens?: number;                // Max tokens per request (default 4096)
    temperature?: number;              // LLM temperature (default 0)
    maxChunkSize?: number;             // Max chars per chunk (default 100,000)
    extraBodyParams?: Record<string, unknown>;
    workers?: WorkerConfig[];          // Worker pool — see above
    maxItems?: number;                 // Max documents per extraction run
    sourceFilter?: string[];           // Filter to specific source paths/filenames
    autoReassignFailures?: boolean;    // Auto-reassign failed docs to more capable workers
  };
  consolidation: {
    endpoint: string;                  // Can differ from extraction endpoint
    model: string;                     // Can differ from extraction model
    apiKey?: string;
    maxTokens?: number;
  };
  import: {
    storage: { type: string };         // Storage provider config
    embedding?: { type: string };      // Embedding provider config
  };
  validation?: {
    rulesPath: string;
    tier2Scope: 'all' | 'sample' | 'flagged-only';
    tier2SamplePercent?: number;       // 0-100, for 'sample' scope
    verificationEndpoint?: string;
    verificationModel?: string;
    checkpointInterval: number;        // Documents per checkpoint (0 to disable)
    pauseOnWarnings?: boolean;
    humanReviewPercent?: number;       // Tier 3 sample percentage
  };
}

interface WorkerConfig {
  name: string;
  endpoint: string;
  model: string;
  contextWindow: number;
  maxChunkSize: number;
  maxOutputTokens: number;
  costPerMillionInputTokens: number;
  costPerMillionOutputTokens: number;
  concurrency: number;
  capabilities: WorkerCapability[];
  temperature?: number;
  extraBodyParams?: Record<string, unknown>;
  apiKey?: string;
  llmProvider?: string;                // e.g. "anthropic" — see LLM providers below
}

type WorkerCapability =
  | 'structured-extraction'   // Tables, spec sheets
  | 'prose-extraction'        // Narrative text
  | 'reasoning'               // Judgment-heavy tasks
  | 'large-context';          // Documents requiring >32K tokens
```

## Validation

Three-tier validation model:

- **Tier 1** — schema, range, and structural checks (zero LLM cost)
- **Tier 2** — source-grounded LLM verification (low cost)
- **Tier 3** — human review of flagged items at periodic checkpoints

Domain-specific rules live in `validation-rules.json` in the starter kit. The pipeline catches systematic errors (chart misinterpretation, hallucinated values, missing required relationships) before they reach the repository.

See [Indexer Validation](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-validation.md) for the full validation model, scope tuning, and worked examples.

## LLM providers

Pluggable LLM backends via the `LLMProvider` interface. Default is `OpenAIChatProvider` (works with vLLM, Ollama, OpenAI, Azure, and any OpenAI-compatible endpoint). For Anthropic prompt caching (~90% cost reduction on system prompts), install [`@utaba/deep-memory-indexer-llm-anthropic`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-llm-anthropic) and set `"llmProvider": "anthropic"` on the worker.

See [Indexer LLM Providers](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-llm-providers.md) for the provider contract, prompt-caching cost analysis, and a guide to writing custom providers.

## Cancellation

The pipeline supports clean cancellation at any point. Call `indexing_stop` (or `orchestrator.stop()` programmatically) and workers will finish their current chunk, then exit. In-flight HTTP requests are cancelled via `AbortController`. Resume by calling `indexing_execute` again — it automatically clears stale stop signals and resets sources stuck in `extracting` back to `pending`.

## How AI and humans collaborate

The principle: **AI handles scale, humans handle strategy and judgment.**

**Humans define:** vocabulary (entity/relationship types + property schemas), indexing strategy (what to extract and how), validation rules (range constraints + structural requirements), and review decisions (accept/reject/correct flagged items).

**AI handles:** extraction at scale, fuzzy deduplication during consolidation, automated validation (Tier 1 + Tier 2), and import.

The collaborative loop:

```
Human defines vocabulary + strategy + validation rules
       ↓
AI runs extraction on sample documents
       ↓
AI runs validation → catches errors (e.g., passCount: 300)
       ↓
Human reviews validation report → adjusts strategy
       ↓
AI re-extracts with improved strategy → human approves for full run
       ↓
AI runs full extraction → post-extraction review (orphans, label variants)
       ↓
Human approves corrections → AI applies them
       ↓
[Optional, safety-critical] AI runs full extraction validation
       ↓
AI runs consolidation → consolidation review → human reviews merges
       ↓
AI re-consolidates from corrected data (idempotent rebuild)
       ↓
Knowledge graph populated and verified
```

The first extraction on a new domain or model always requires tuning. The validation layer catches systematic errors (like chart misinterpretation), the extraction review phase catches chunking artifacts (orphan relationships, label variants), and the consolidation review catches false merges. See [Post-Extraction Review Guide](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-review-guide.md) for the extraction-review process.

## See also

- [`@utaba/deep-memory-indexer-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-mcp-server) — 9 phase-aware MCP tools for driving the pipeline
- [Indexer Quickstart](https://github.com/TjWheeler/deep-memory/blob/main/quickstart-indexer.md) — step-by-step first run

- [Indexer LLM Providers](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-llm-providers.md) — pluggable backends, Anthropic caching, custom providers
- [Indexer Validation](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-validation.md) — three-tier validation, model selection
- [Indexer Extraction Guide](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-extraction-guide.md) — model selection, chunk sizing, cost management, strategy tuning
- [Post-Extraction Review Guide](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-review-guide.md) — spot-checking and correcting extractions
- [Indexer Consolidation Guide](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-consolidation-guide.md) — dedup algorithm, merge confidence, troubleshooting
- [Indexer Embeddings Guide](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-embeddings-guide.md) — config, cost estimation, similarity tuning
- [Starter Kits](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-starterkit-guide.md) — building custom domain vocabularies
- [Local Model Setup](https://github.com/TjWheeler/deep-memory/blob/main/docs/local-model-setup.md) — llama.cpp / vLLM worker setup, GPU sizing
