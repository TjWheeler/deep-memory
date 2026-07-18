# Indexer — Extraction Guide for Large Documents

Practical guidance for configuring the extraction pipeline, choosing models, tuning chunk sizes, and handling large documents. Based on lessons learned from the mining fleet knowledge graph (11 documents, 4KB to 2.1MB, 6 models tested) and the legal domain local model test (4 documents, 7KB to 72KB, Qwen3.5-35B-A3B via llama.cpp CUDA).

---

## Rich-format sources need conversion first

Extraction reads text. Rich formats (`.pdf`, `.docx`, `.html`, `.htm`, `.pptx`) are registered as `needs-conversion` during prepare and must be rendered to Markdown by the **convert** step before extraction will process them — extraction throws rather than feed raw binary bytes to an LLM.

Start the conversion service (`docker compose -f docker-compose.indexer.yml --profile docling-worker up -d`), configure `services.docling.endpoint` in `config.json` to match its host port, then run `indexing_execute action: convert` and wait for `indexing_status` to report it complete. The converted Markdown is written to `state/converted/{slug}.md` and recorded as `derivedTextPath`; the chunk-sizing and model guidance below then applies to that derived text. Plain-text sources skip conversion entirely.

---

## Pre-flight: validate the config against the served model — do this BEFORE extracting

**Extraction is expensive to get wrong.** A mis-sized worker config does not fail fast — it fails *minutes into generation*, per chunk, after you have already committed the run. Validate these three things against the model the endpoint actually serves before you run `indexing_execute action: extract`. Do not trust an inherited config just because it "looks configured" — the numbers are model-specific and silently wrong when copied between endpoints.

### Step 1 — Confirm the real context window

Query the endpoint (`curl {endpoint}/models` on an OpenAI-compatible server) or ask the operator what window the model is served at. The worker's `contextWindow` in `config.json` **must equal or be below** the window the server actually serves. A config claiming `131072` against a server that serves `108000` will pass small chunks and then overflow on large progressive-context prompts late in a big document — the worst place to discover it.

### Step 2 — Budget the window so all three costs fit at once

The context window must simultaneously hold the system prompt, the input chunk, the accumulated progressive context, **and** the reserved output tokens. On vLLM and most OpenAI-compatible servers the request is rejected if `prompt_tokens + maxOutputTokens > contextWindow`, so the reserved output eats directly into the prompt budget:

```
system prompt (~19K tokens)
  + input chunk         (maxChunkSize chars ÷ ~4 = tokens)
  + progressive context (up to maxContextChars ÷ ~4 = tokens)
  + maxOutputTokens     (reserved, not "up to")
  ────────────────────────────────────────────────
  ≤ contextWindow
```

Worked example for a 108K model at `maxChunkSize: 12000`, `maxOutputTokens: 32768`:
`19K (system) + 3K (chunk) + 2K (progressive) + 32.8K (output) ≈ 57K ≤ 108K` ✓ — comfortable headroom.

The same config against a **32K** server: `19K + 3K + 2K + 32.8K ≈ 57K > 32K` ✗ — every request rejected. This is why the earlier 32K-context vLLM tests failed with context overflow.

**Do not size chunks to fill the window.** Bigger is not better: three costs compete for the budget, dense middle content is extracted worse in very large chunks ("lost in the middle"), and — see Step 3 — large chunks are the direct cause of connection timeouts. The validated sweet spot is a *moderate* chunk, not the largest one that fits.

### Step 3 — Survive long generations on dense chunks

The failure mode most configs miss: **even when everything fits the context window, a dense (e.g. tabular) chunk can take minutes to generate, and an idle timeout drops the connection mid-generation.** This surfaces as `fetch failed` or `This operation was aborted` after several minutes with zero entities returned — it is **not** a context or truncation problem, it is wall-clock time. The trap is that the chunker bounds *input characters* while latency is driven by *output tokens*, and the two decouple on tabular content: ~8,000 characters of a zoning matrix can expand into ~30,000 near-identical JSON tokens.

- **Streaming is the primary defence, and it is on by default** (the built-in openai-compat provider; `stream: true`). With streaming, response headers arrive the moment the model starts producing tokens and the transport idle timer resets on every delta — so the request no longer dies from *inter-token idle* even when total generation runs for minutes. The effective ceiling becomes the server/proxy *total* request timeout, not a hidden client idle default. Leave streaming on unless a server or proxy mishandles SSE; opt out per worker with `stream: false`.
- **Shrinking `maxChunkSize` is no longer the timeout lever** once streaming is on. It still matters for extraction quality and for keeping `prompt + output` inside the context window (Step 2), but reducing it to "finish before the idle timeout" is the wrong reflex — half a zoning table is still a wall of near-identical edges, and streaming already removes the idle timeout that shrinking was working around.
- **`maxOutputTokens` is a *ceiling* on an OpenAI-compatible endpoint, and on output-dense chunks it bounds worst-case request time.** It is *not* free to raise. On a chunk that stops early at EOS the ceiling is never reached and raising it costs nothing. But on an output-dense (tabular) chunk the model generates all the way to the ceiling, so `maxOutputTokens ÷ token-rate` is the worst-case duration of that request — e.g. 32,768 tokens ÷ ~100 tok/s ≈ 5.5 min. Size it to the largest legitimate output you expect, not arbitrarily high; lowering it below that only risks truncating valid output. (The Anthropic SDK is a separate case — there `max_tokens` feeds a pre-flight timeout estimate; see the Sonnet timeout note below.)
- If a proxy in front of the endpoint *buffers* SSE (e.g. nginx `proxy_buffering on`), streaming's deltas arrive in one terminal burst and the idle-timeout protection is lost. That is an operator-owned proxy fix (`proxy_buffering off` / honour `X-Accel-Buffering: no`), not a client config change.

### The three failure modes are distinct — diagnose before you retune

Reacting to the wrong symptom makes the config worse. Match the error to its cause:

| Symptom | Cause | Fix | Do NOT |
|---------|-------|-----|--------|
| `context overflow`, "prompt exceeds N tokens", rejected immediately | `contextWindow` set too high, or chunk + output exceed the real window | Correct `contextWindow` to the served value; reduce `maxChunkSize` | Don't raise `maxOutputTokens` |
| `Unterminated string in JSON`, JSON parse failure at a position near the token limit | Output truncation — model hit `maxOutputTokens` mid-response | Raise `maxOutputTokens` (32K+ for local); reduce `maxChunkSize` | Don't lower `maxOutputTokens` |
| `fetch failed` / `operation aborted` after minutes, 0 entities | Idle timeout — the transport saw no bytes for too long during a long generation | Keep streaming on (default); if a proxy buffers SSE, fix the proxy; only then raise the server/proxy total timeout | Don't reflexively shrink `maxChunkSize`; don't lower `maxOutputTokens` (neither helps and lowering risks truncation) |

If a run fails, read the actual error string and pick the row. A `fetch failed` and a truncation demand *opposite* changes to `maxOutputTokens` — treating one as the other is how a config degrades across "fixes."

---

## Monitoring a long extraction — do NOT poll the status tool in a loop

Extraction of a large corpus runs for tens of minutes. The instinct is to call `indexing_status` repeatedly to watch it — **do not.** Repeated status calls (or a monitoring sub-agent that has no way to sleep — foreground `sleep` is blocked in the harness, so it tight-loops) hammer the tool many times a minute for no information gain. The run's state is already written to disk; watch the file, not the tool.

**The one correct mechanism: a detached file-watcher that emits a single notification at the terminal state.** Extraction status lives in `state/index-source-list.json`; a source is done when no entry is `"pending"` or `"extracting"`, and a proxy-timeout failure reverts a source to a `"failed"`/error state. Launch this as a background bash command (`run_in_background`) — it sleeps between checks and exits exactly once, producing one completion (or alert) notification:

```bash
SRC="<processDir>/state/index-source-list.json"
while true; do
  pend=$(grep -c '"status": "pending"' "$SRC")
  extr=$(grep -c '"status": "extracting"' "$SRC")
  fail=$(grep -c '"status": "failed"' "$SRC")
  if [ "$fail" -gt 0 ]; then
    echo "EXTRACTION_ALERT failed=$fail pending=$pend extracting=$extr"; exit 1
  fi
  if [ "$pend" -eq 0 ] && [ "$extr" -eq 0 ]; then
    echo "EXTRACTION_COMPLETE"; exit 0
  fi
  sleep 30
done
```

**Key the alert on the `"status"` field only — never grep for `fetch failed`/`operation aborted` text.** Those strings persist in a source's `lastError` as *history* after a `clearError` or `pending` reset, and can also appear in a `statusReason` you wrote — so a text grep false-trips on a source that has already recovered or is mid-retry. The authoritative live failure signal is `"status": "failed"` (which is what `indexing_status` counts).

Rules:

- **One status call per event, not per interval.** When the watcher fires, then call `indexing_status` *once* to read authoritative counts. Never confirm a mid-run guess by polling. (The file snapshot can be read mid-write and show a transient state — e.g. a source momentarily reading `pending` during a status rewrite — so the watcher decides *when* to look, and `indexing_status` decides *what is true*.)
- **Do not spawn a sub-agent whose job is "poll status."** It cannot sleep and will tight-loop. Delegation does not fix the mechanism; the file-watcher does.
- If you genuinely need periodic check-ins rather than a single terminal signal, space them at ≥20–30s and keep them few — but a terminal-state watcher is almost always what you actually want.

The same pattern applies to the other long-running phases (validation, consolidation, import, embeddings): watch the phase's state file for a terminal condition, don't loop the status tool.

---

## Handling a `fetch failed` on one source mid-run

A proxy-timeout `fetch failed` on a single large document does **not** automatically mean the config is wrong — especially if sibling documents of similar size completed at the same settings in the same run. That pattern points to a transient connection drop, not a systematic size problem.

- **First occurrence (attempts low, siblings succeeded):** treat as transient. Extraction checkpoints per chunk to `state/extraction-checkpoints/<worker>--<source>.checkpoint.json`, so clear the error with `indexing_update clearError: true` (which preserves the checkpoint) and re-run `indexing_execute action: extract` — it **resumes** from the last completed chunk, not from zero. Confirm the resume by checking that the first `indexing_status` shows the chunk counter and entity/relationship tallies continuing from the checkpoint, not reset.
- **Recurrence (fails again, or fails at a consistent chunk):** now reduce `maxChunkSize` per the timeout row above. Note that changing `maxChunkSize` changes chunk boundaries, which **invalidates the checkpoint** — you must reset the source to `pending` (discarding partial work) and re-extract from scratch. This is why you try a resume first: a smaller chunk size is the fix that costs you the checkpoint.
- **Never** reset a source to `pending` to "retry" when a plain `clearError` + resume would preserve completed chunks. `sourceStatus: pending` clears extraction artifacts.

---

## Hardware

GPU: RTX 5090, 32 GB VRAM.
OS: Windows 11 (llama.cpp CUDA native) / WSL2 (vLLM Docker).
CPU: i9-14900K (32 threads).
RAM: 96 GB 6400 MT/s.

## Model Ranking and Strategy

Overall model ranking for extraction quality (highest to lowest):

| Rank | Model | Best For | Cost | Key Strength | Key Weakness |
|------|-------|----------|------|-------------|--------------|
| 1 | **Opus** | Critical/complex documents | $$$ | Highest accuracy, deepest reasoning | Cost prohibitive for bulk extraction |
| 2 | **Sonnet** | Bulk extraction, prose-heavy documents | $$ | Best cost/quality balance, dense relationships | 4x Haiku cost, SDK timeout risk on large chunks |
| 3 | **Haiku** | Structured data, exploratory passes | $ | Reliable JSON, cost-effective | Fabricates hard numbers on prose (weights, durations) |
| 4 | **Qwen 3.5-35B** (local) | Development, validation, zero-cost iteration | Free | Unlimited re-extraction, full privacy | Higher orphan rate, needs explicit guidance |

**Recommended strategy by phase:**

| Phase | Model | Rationale |
|-------|-------|-----------|
| Development/testing | Local Qwen 3.5-35B | Zero cost allows unlimited iteration on strategy tuning |
| Bulk extraction | Sonnet | Good quality at manageable cost for most documents |
| Critical documents | Opus | Use for safety-critical or complex documents where accuracy is paramount |
| Exploratory/structured | Haiku | Fast and cheap for structured spec sheets and initial passes |
| Validation | Local Qwen 3.5-35B | Mostly structural checks; LLM verification cost is low |

### Cloud Models (Recommended for Production)

| Model | Strengths | Weaknesses | Best For |
|-------|-----------|------------|----------|
| **Claude Haiku 4.5** | Reliable JSON output (100% success rate), good extraction depth, cost-effective ($0.80/$4.00 per M tokens) | Slightly less thorough than Sonnet on relationship extraction | Default worker for most documents |
| **Claude Sonnet 4.6** | Deepest extraction, most relationships per entity, handles complex cross-references | Higher cost ($3.00/$15.00 per M tokens), 4x more expensive than Haiku | High-value documents where thoroughness justifies cost |

**Haiku vs Sonnet comparison on a 632KB O&M manual:**
- Haiku extracted 362 entities, 346 relationships from a comparable document (601KB) at $0.60
- Sonnet extracted 429 entities, 1,320 relationships from the 632KB document at $6.49
- Sonnet found ~3.8x more relationships per entity — it excels at cross-referencing components, fluids, and maintenance procedures across sections

**Recommendation:** Start with Haiku. Use Sonnet selectively for documents where relationship density matters (O&M manuals, troubleshooting guides, cross-reference tables).

### Local Models (Viable with Tuning)

**Update (April 2026):** Local models are now viable for production extraction using llama.cpp with CUDA on an RTX 5090. The key breakthroughs were: (1) switching from Vulkan to CUDA builds of llama.cpp, (2) using 64K context with GGUF Q5_K_M quantisation, and (3) tuning `maxChunkSize` and `maxOutputTokens` to match local model output capacity.

#### Validated Configuration: Qwen3.5-35B-A3B Q5_K_M via llama.cpp CUDA

| Setting | Value | Notes |
|---------|-------|-------|
| **Runtime** | llama.cpp (CUDA build) | Vulkan build causes OOM on large allocations — use CUDA |
| **Model** | Qwen3.5-35B-A3B Q5_K_M (GGUF) | 25 GB weights, MoE (3B active per token) |
| **Context** | 64K (`-c 65536`) | Fits with q8_0 KV cache on 32 GB VRAM |
| **GPU layers** | All (`-ngl 999`) | Full GPU offload with CUDA |
| **KV cache** | q8_0 keys + values | Good quality/VRAM balance |
| **Flash attention** | On (`-fa on`) | Required for 64K context to fit |
| **maxChunkSize** | 20,000 chars | Critical — see tuning notes below |
| **maxOutputTokens** | 32,768 | Must be high enough for dense legal/technical content |
| **Thinking mode** | Disabled | `"chat_template_kwargs": { "enable_thinking": false }` |

#### Quality Comparison: Local vs Cloud (Legal Domain, 4 Documents)

Tested on 4 legal contracts (7 KB to 72 KB): 3 NDAs and 1 large MSA/SOW agreement.

| Configuration | Entities | Relationships | Truncation | Notes |
|---------------|----------|---------------|------------|-------|
| Qwen 35B, 8K output, 40K chunks | 191 | 67 | 71% of calls | Severe truncation — relationships lost |
| Qwen 35B, 16K output, 40K chunks | 220 | 230 | 1 doc truncated | Better but still truncating |
| Qwen 35B, 32K output, 20K chunks | **404** | **625** | None | Matches Haiku quality |
| Cloud Haiku 4.5 (baseline) | 413 | 638 | None | Cloud reference |

**Key finding:** With the right settings, Qwen3.5-35B-A3B Q5_K_M via llama.cpp matches Claude Haiku 4.5 at zero cost. The two critical tuning parameters are `maxChunkSize` (smaller = more chapters = more output budget per chapter) and `maxOutputTokens` (must be generous — 32K).

#### Tuning Lessons for Local Models

1. **Use the CUDA build of llama.cpp, not Vulkan.** The `winget install ggml.llamacpp` default installs a Vulkan build. Vulkan's memory allocator fails on large allocations (2 GB+) even when VRAM is available. Download the CUDA build from the [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases) (`llama-*-bin-win-cuda-12.4-x64.zip` + `cudart-llama-bin-win-cuda-12.4-x64.zip`).

2. **Reduce `maxChunkSize` for dense documents.** Local models produce more output per entity than cloud models (more verbose JSON). A 40K chunk that cloud Haiku handles in one pass may produce 40K+ output tokens from a local model. At 20K chunks, each chapter stays well within 32K output limit.

3. **Set `maxOutputTokens` generously.** The output token limit was the #1 cause of data loss in local model extraction. When truncated, the pipeline salvages partial JSON (entities survive, relationships are often lost). The diagnostics now flag truncation as a quality check.

4. **Strengthen domain guidance for local models.** Cloud models (Haiku, Sonnet) follow nuanced guidance well. Local models benefit from explicit, imperative checklists — "You MUST create a BOUND_BY for every Obligation" rather than "Every obligation should have at least one BOUND_BY." Adding a mandatory extraction checklist to the domain guidance doubled the entity count for the local model.

5. **Disable thinking mode.** Qwen3.5 has a "thinking" mode that wraps output in `<think>` tags, consuming output tokens. Disable it via `extraBodyParams` for structured extraction.

#### Earlier Local Model Tests (vLLM, 32K Context)

These earlier tests used vLLM with 32K context windows, which is insufficient for the extraction pipeline:

| Model | Context | Result | Notes |
|-------|---------|--------|-------|
| Qwen3.5-35B-A3B-GPTQ-Int4 (vLLM) | 32K | 29 entities, 26 rels | ~50% JSON failure rate. |
| Qwen3-14B-AWQ | 32K | 10 entities, 13 rels | Too shallow. |
| Qwen3-8B | 32K | Failed — context overflow | Prompt exceeds 32K. |
| Qwen3-4B | 32K | 18 entities, 16 rels | Hallucinated properties. |
| Gemma 3 12B | 16K | Failed — context too small | Prompt alone is ~12K tokens. |

**Why the difference:** The earlier tests were limited by 32K context (the vLLM GPTQ-Int4 configuration). The llama.cpp GGUF Q5_K_M setup runs at 64K context on the same GPU, giving enough headroom for the extraction prompt + document + output.

---

## Document Sizing and Chunk Configuration

### maxChunkSize — How Big Should Chunks Be?

`maxChunkSize` controls the maximum character count per extraction segment. The pipeline splits documents at natural boundaries (headings, page markers, paragraph gaps) and merges segments greedily up to this limit.

| Model | Recommended maxChunkSize | Rationale |
|-------|--------------------------|-----------|
| **Claude Haiku 4.5** (200K context) | 15,000 chars | Fast responses (~2-5s per chunk). Higher chunk sizes work but offer diminishing returns. |
| **Claude Sonnet 4.6** (200K context) | 20,000 chars | Sonnet generates denser output and takes longer per chunk. At 30,000 chars, individual chunks can exceed the 10-minute API timeout on dense technical documents (fluids references, cross-reference tables). 20,000 keeps each chunk well within timeout. |
| 32K tokens (local) | 8,000 - 12,000 chars | Tight budget after prompt overhead. Most local models cannot handle this pipeline. |

**Why not use the full context window?** Three costs compete for the context budget:
1. **System prompt** — vocabulary, extraction rules, output format. Typically 15-20K tokens (~60-75K chars). Fixed per call.
2. **Document chunk** — the actual content. Variable.
3. **Output tokens** — the extracted JSON. Dense technical documents produce 0.5-1.5x as many output tokens as input tokens.

**Observed ratios from mining fleet extraction:**

| Document Type | Input Tokens | Output Tokens | Output/Input Ratio |
|---------------|-------------|---------------|-------------------|
| Spec sheets (9KB) | ~23K | 6-10K | 0.3-0.4x |
| Brochures (14-50KB) | 23-38K | 10-15K | 0.4x |
| O&M manuals (370-632KB) | 213-866K total | 52-260K total | 0.2-0.3x per chunk |
| Fluids reference (487KB) | 403K | 61K | 0.15x |

O&M manuals produce fewer entities per character because much of the content is procedural (maintenance steps, safety warnings) that doesn't map to entities. Spec sheets and brochures are denser — almost every line contains extractable data.

### maxOutputTokens — The Truncation Ceiling

If the model hits this limit mid-response, the JSON is truncated and the extraction fails. The right value depends on the model and chunk size.

**Recommended maxOutputTokens by model:**

| Model | maxChunkSize | Recommended maxOutputTokens | Rationale |
|-------|-------------|----------------------------|-----------|
| **Claude Haiku 4.5** | 15,000 | 64,000 | Fast output generation; high limit is safe. |
| **Claude Sonnet 4.6** | 20,000 | 16,384 | Sonnet is slower to generate tokens. With 20K input chunks, peak output is ~15K tokens. A 16K limit avoids bloating the Anthropic SDK's pre-flight timeout estimate (the SDK rejects requests where `max_tokens` × estimated time would exceed the client timeout). Setting 65K caused pre-flight rejections and 15-minute timeouts. |
| **Local models** | 8,000-12,000 | Model maximum | Set to whatever the model supports. |

**Important interaction: maxOutputTokens affects the Anthropic SDK timeout calculation.** The Anthropic Node SDK estimates whether a request can complete within its configured timeout based on `max_tokens`. Setting `max_tokens: 65536` with Sonnet causes the SDK to estimate ~15 minutes, which can trigger timeout errors even when the actual response would be much smaller. Reducing `max_tokens` to match realistic output sizes avoids this.

**What happens on truncation (with our resilience features):**
1. The pipeline detects `finish_reason: 'length'` from the API
2. It attempts to repair the truncated JSON by closing open brackets (salvages complete entities)
3. If repair fails, the chunk is split in half and both halves are retried
4. This recurses up to 3 levels deep (minimum 1/8 of original chunk size)

**Before these resilience features**, a single truncated chunk would fail the entire document. The mining fleet test had 9 consecutive failures on the 632KB mini excavators manual at maxOutputTokens=16384 with maxChunkSize=30000.

**Observed output token usage per chunk:**

| Document | Model | maxChunkSize | Avg Output | Peak Output |
|----------|-------|-------------|------------|-------------|
| 632KB O&M manual | Sonnet | 30,000 | 11,290 | 28,736 |
| 487KB fluids reference | Sonnet | 20,000 | ~6,500 | ~15,000 |
| 601KB O&M manual | Haiku | 15,000 | ~8,500 | ~19,000 |

With Sonnet at 30K chunks, 7 of 23 chunks exceeded 16K output. At 20K chunks, all completed within 16K.

---

## Progressive Chapter Extraction

For documents with markdown structure (headings, page markers), the pipeline uses progressive chapter-based extraction rather than fixed-size chunking.

### How It Works

1. **Split** — `ChapterSplitter` scans for headings (ATX and Setext), page markers (`-- N of M --`), and paragraph gaps. It greedily merges small sections up to `maxChunkSize`.
2. **Overview** — A document structure summary (title, heading hierarchy) is generated and included in every chunk's prompt.
3. **Progressive context** — After each chunk, extracted entity labels and summaries are carried forward. The next chunk's prompt includes this context so the model can reference existing entities by their canonical labels instead of creating duplicates.
4. **Deduplication** — After all chunks complete, entities and relationships are deduplicated by type+label.

### Progressive Context and Prompt Bloat

The progressive context window (`progressiveContextWindow`, default 6) controls how many recent chapters' entities are carried forward. Entities seen in multiple chapters have their recency bumped, so frequently-referenced entities persist longer.

A hard character limit (`maxContextChars`, default 8000) caps the context size. When exceeded, the oldest entries are dropped first.

**Observed prompt sizes for the 632KB mini excavators doc:**
- System prompt: ~74,570 chars (constant)
- User prompt: 33,205 chars (first chunk) growing to 89,972 chars (chunk 22)
- The growth is from progressive context accumulating entity references

The user prompt nearly tripled over the extraction run. For very large documents (1MB+), consider:
- Reducing `progressiveContextWindow` to 3-4
- Reducing `maxContextChars` to 4000-5000
- Accepting slightly more entity duplication in exchange for lower input token costs

### When Progressive Extraction Activates

The pipeline uses progressive chapters when:
- `chunkingStrategy` is `'auto'` (default) and the document exceeds `maxChunkSize` and has markdown structure
- `chunkingStrategy` is `'chapters'`

It falls back to fixed-size chunking when:
- The document has no headings, page markers, or paragraph gaps
- `chunkingStrategy` is `'fixed'`

---

## Cost Management

### Token Economics

Cloud extraction cost is dominated by **output tokens** for Sonnet and **input tokens** for Haiku:

| Worker | Input Cost | Output Cost | Typical Ratio |
|--------|-----------|-------------|---------------|
| Haiku | $0.80/M | $4.00/M | Output costs ~2x input costs |
| Sonnet | $3.00/M | $15.00/M | Output costs ~3-5x input costs |

### Cost Per Document Size (Haiku)

| Document Size | Estimated Cost | Notes |
|---------------|---------------|-------|
| < 50 KB | $0.02 - $0.10 | Single pass or 2-3 chunks |
| 50 - 200 KB | $0.10 - $0.40 | 5-10 chunks |
| 200 - 600 KB | $0.40 - $0.70 | 10-25 chunks |
| 600 KB - 1 MB | $0.60 - $1.00 | 20-40 chunks |
| 1 - 2 MB | $1.00 - $2.50 | 40-80 chunks, progressive context adds up |

**Sonnet is roughly 10x the cost of Haiku** for equivalent documents due to higher per-token rates and denser output (more relationships extracted).

### Prompt Caching (Anthropic Provider)

The system prompt (vocabulary + extraction rules + output format) is ~19K tokens and is sent identically with every chunk. With the `@utaba/deep-memory-indexer-llm-anthropic` provider, Anthropic's prompt caching reduces the cost of these repeated tokens by 90%.

| Document | Chunks | System Prompt Tokens | Without Caching | With Caching | Savings |
|----------|--------|---------------------|-----------------|--------------|---------|
| 9 KB spec sheet | 1 | 19K | $0.015 | $0.015 | 0% (single chunk) |
| 601 KB O&M manual | ~25 | 475K | $0.38 | $0.06 | 84% |
| 2.1 MB handbook | ~148 | 2.8M | $2.24 | $0.28 | 88% |

**Setup:** Add `"llmProvider": "anthropic"` to cloud workers in your `config.json`. See [Indexer LLM Providers](indexer-llm-providers.md) for full configuration details.

### Cost Control Strategies

1. **Use `maxItems: 1`** for initial testing — extract one document at a time, review quality, then proceed
2. **Use `sourceFilter`** to target specific documents instead of running the full batch
3. **Assign expensive workers selectively** — use Haiku as the default, Sonnet only for high-value documents
4. **Review extraction notes** after each document before continuing to the next batch
5. **Reduce `maxChunkSize`** to produce more, smaller chunks — each chunk extracts fewer entities, reducing output tokens per call (but increasing input token overhead from repeated system prompts)

---

## Troubleshooting

### JSON Parse Failures

**Symptom:** `Failed to parse LLM response as JSON: Unterminated string in JSON at position N`

**Cause:** Almost always output truncation — the model hit maxOutputTokens before completing the JSON. Check the `lastError` field in `index-source-list.json` and look for position numbers near the token limit.

**Fix:**
1. Increase `maxOutputTokens` (first thing to try — set to 65536 for Claude)
2. Reduce `maxChunkSize` so each chunk produces less output
3. The pipeline's truncation resilience (auto sub-splitting) should handle remaining cases

### Anthropic SDK Timeout (Sonnet)

**Symptom:** Extraction fails with `Request timed out.` after ~15 minutes, even though the configured client timeout is 10 minutes. Credits are consumed but no chunks complete.

**Cause:** The Anthropic SDK estimates request duration from `max_tokens` and may internally retry. With `max_tokens: 65536` and Sonnet's slower generation speed, the SDK's estimate exceeds the client timeout before the request even completes. This is especially common on dense, large chunks (30K+ chars) where Sonnet produces long output.

**Fix:**
1. Reduce `maxChunkSize` to **20,000** for Sonnet workers (ensures faster per-chunk completion)
2. Reduce `maxOutputTokens` to **16,384** (matches realistic output for 20K chunks, prevents SDK pre-flight timeout estimation issues)
3. Clear any stale checkpoints and reset the source to `pending` before retrying

**Validated:** This fix resolved repeated timeouts on a 487KB fluids reference document that failed 3 times at 30K/65K but succeeded on the first attempt at 20K/16K.

### Progressive Context Bloat

**Symptom:** Later chunks in a large document take much longer, or input token costs escalate significantly.

**Cause:** Progressive context accumulates entity references from all prior chunks. For a 50+ chunk document, this can add 30-50K chars to each prompt.

**Fix:** Reduce `progressiveContextWindow` (default 6) or `maxContextChars` (default 8000) in the extraction config.

### Empty Extraction Results

**Symptom:** Document extracts 0 entities, 0 relationships despite having content.

**Cause:** Usually the document content doesn't match the vocabulary's entity types. A README or table of contents won't produce entities if the vocabulary doesn't define types for those concepts.

**Fix:** Review the vocabulary against the document content. Ensure the document type is correctly assigned and the vocabulary covers the domain.

### Chunk Boundary Issues

**Symptom:** Entities that span across chunk boundaries are missed or duplicated with different labels.

**Cause:** The chapter splitter tries to break at headings and natural boundaries, but dense tables or flowing prose may still split mid-entity.

**Fix:** Increase `maxChunkSize` so the entity fits in a single chunk. The progressive context helps subsequent chunks recognize entities from prior chunks, but it depends on the model referencing the context correctly.

---

## Common Extraction Error Patterns

Patterns observed across real indexing runs (mining fleet, council/planning, legal contracts):

### Model-Specific Accuracy Issues

**Haiku — Hard number fabrication:**
- Fabricates specific numbers (weights, durations, temperatures, capacities) that don't appear in source text
- Pattern: values look plausible but are hallucinated — dangerous for safety-critical data
- Domains affected: prose-heavy manuals, specification narratives
- Safe for: structured specification tables with clear row/value mapping

**Sonnet — Soft property inference:**
- Infers property values not explicitly stated (skillLevel, partType, difficulty ratings, priority)
- Pattern: values are reasonable but not grounded in source text
- Impact: lower concern than Haiku fabrication since inferred values are often useful
- Fix: add explicit guidance: "Only extract values explicitly stated in the source document"

**Both models — Entity type misclassification:**
- Components classified as Equipment, procedures classified as standards
- More common with ambiguous vocabulary definitions
- Fix: add explicit classification criteria to domain-guidance.md

### Structural Error Patterns (from council/planning domain)

1. **Vocabulary type overflow** — Model creates entities matching source concepts but not vocabulary types. E.g., extracting "Parking Area" when vocabulary only has "Zone" and "Standard"
2. **Relationship direction reversal** — REGULATES relationship with source and target swapped
3. **Duplicate entities from different sections** — Same zone described in multiple document sections extracted as separate entities with slightly different labels
4. **Property value merging** — Multiple distinct values merged into one property (e.g., setback requirements for different zone types combined)
5. **Missing cross-references** — Document references "as per Section 4.2" but model doesn't create relationship to the referenced entity
6. **Label format inconsistency** — Mix of formal names ("Residential Zone R1") and informal names ("R1 zone") across documents
7. **Orphan relationship chains** — Relationships referencing entities that exist in other documents but not the current extraction
8. **Over-extraction of procedural content** — Extracting step-by-step procedures as entities when they should be properties or ignored

### Legal Domain — Progressive Discovery Pattern

When indexing contract documents, entities discovered in later documents often refine earlier extractions:

- **Round 1:** Extract NDA agreements — discovers Party entities, Obligation entities, basic terms
- **Round 2:** Extract MSA/SOW — discovers Service entities, payment terms, SLA metrics that contextualize earlier obligations
- **Round 3:** Re-extract earlier documents with enriched progressive context — entity quality improves because the model now recognizes patterns seen in later documents

This pattern suggests: for contract domains, do a full pass, review, then selectively re-extract early documents with accumulated context.

---

## Configuration Reference

### Worker Configuration (config.json)

**Haiku (default worker):**
```json
{
  "name": "cloud-haiku",
  "llmProvider": "anthropic",
  "endpoint": "https://api.anthropic.com/v1",
  "model": "claude-haiku-4-5-20251001",
  "contextWindow": 200000,
  "maxChunkSize": 15000,
  "maxOutputTokens": 64000,
  "costPerMillionInputTokens": 1.00,
  "costPerMillionOutputTokens": 5.00,
  "concurrency": 3,
  "capabilities": ["structured-extraction", "prose-extraction", "large-context"]
}
```

**Sonnet (selective use for high-value documents):**
```json
{
  "name": "cloud-sonnet",
  "llmProvider": "anthropic",
  "endpoint": "https://api.anthropic.com/v1",
  "model": "claude-sonnet-4-6",
  "contextWindow": 200000,
  "maxChunkSize": 20000,
  "maxOutputTokens": 16384,
  "costPerMillionInputTokens": 3.00,
  "costPerMillionOutputTokens": 15.00,
  "concurrency": 3,
  "capabilities": ["structured-extraction", "prose-extraction", "large-context"]
}
```

**Local model (llama.cpp CUDA, Qwen3.5-35B-A3B Q5_K_M):**
```json
{
  "name": "local-qwen35-35b",
  "endpoint": "http://localhost:8020/v1",
  "model": "Qwen_Qwen3.5-35B-A3B-Q5_K_M",
  "contextWindow": 65536,
  "maxChunkSize": 20000,
  "maxOutputTokens": 32768,
  "costPerMillionInputTokens": 0,
  "costPerMillionOutputTokens": 0,
  "concurrency": 1,
  "capabilities": ["structured-extraction"],
  "extraBodyParams": {
    "chat_template_kwargs": { "enable_thinking": false }
  }
}
```

### Key Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `maxChunkSize` | 100,000 | Max characters per extraction segment. Set to 15K for Haiku, 20K for Sonnet, 20K for local models. |
| `maxOutputTokens` | 4,096 | Max output tokens per LLM call. Set to 64000 for Haiku, 16384 for Sonnet, 32768 for local models. |
| `chunkingStrategy` | `'auto'` | `'auto'`, `'chapters'`, or `'fixed'`. Auto uses chapters for markdown. |
| `progressiveContextWindow` | 6 | Number of recent chapters carried forward in progressive context. |
| `concurrency` | 1 | Parallel extraction workers per model. 3 works well for cloud APIs, 1 for local models. |
| `autoReassignFailures` | false | Auto-reassign failed docs to more capable workers on retry. |
| `temperature` | 0 | Keep at 0 for deterministic extraction. |
| `llmProvider` | (none) | Provider name for vendor-specific LLM backends. Set to `"anthropic"` for native Messages API with prompt caching. See [LLM Providers](indexer-llm-providers.md). |
