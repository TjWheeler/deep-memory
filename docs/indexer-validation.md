# Indexer — Model Validation and Output Quality

How to evaluate extraction model suitability for a domain, compare model outputs, and establish quality baselines before committing to a full indexing run.

---

## Why Model Validation Matters

The indexer pipeline relies on LLMs to extract structured entities and relationships from unstructured documents. Model performance varies significantly based on:

- **Domain complexity** — A company org chart has simple, predictable structure. Medical literature requires specialized reasoning about drug interactions, diagnostic criteria, and treatment protocols. Mining equipment documentation sits in between.
- **Document structure** — Dense specification tables are mechanical to extract. Troubleshooting prose requires semantic judgment. Marketing brochures mix both.
- **Extraction depth** — Extracting top-level equipment models is easy. Building a two-level component hierarchy with correct CONTAINS relationships and fluid capacities requires the model to maintain context and follow vocabulary conventions.
- **Output token budget** — Smaller models may produce truncated JSON before completing all entities and relationships. Larger models can complete the full extraction in a single pass.

A model that works well for one domain may produce unusable results in another. Always validate before committing to a full pipeline run.

---

## Model Comparison Process

### Step 1 — Select a Representative Document

Choose one source document that is:

- **Typical** of the documents you will index (not the easiest or hardest)
- **Small enough** to fit in your smallest candidate model's context window
- **Rich enough** to exercise entity creation, relationship creation, deduplication, and property extraction

For the mining domain, a spec sheet (8-10 KB, ~4K tokens) is ideal for initial comparison. For medical domains, choose a clinical guideline section. For org structures, choose a department overview.

### Step 2 — Configure Multiple Workers

Add each candidate model as a worker in `config.json`:

```json
{
  "extraction": {
    "workers": [
      {
        "name": "local-qwen-4b",
        "endpoint": "http://localhost:8020/v1",
        "model": "Qwen/Qwen3-4B",
        "contextWindow": 32768,
        "maxChunkSize": 20000,
        "maxOutputTokens": 8192,
        "costPerMillionInputTokens": 0,
        "costPerMillionOutputTokens": 0,
        "concurrency": 1,
        "capabilities": ["structured-extraction"],
        "extraBodyParams": {
          "chat_template_kwargs": { "enable_thinking": false }
        }
      },
      {
        "name": "cloud-haiku",
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5-20251001",
        "contextWindow": 200000,
        "maxChunkSize": 100000,
        "maxOutputTokens": 16384,
        "costPerMillionInputTokens": 0.80,
        "costPerMillionOutputTokens": 4.00,
        "concurrency": 3,
        "capabilities": ["structured-extraction", "prose-extraction", "large-context"]
      }
    ]
  }
}
```

### Step 3 — Extract with Multiple Workers

Assign multiple workers to the same document and extract in a single pass. Each worker's output goes to its own subdirectory under `extraction-notes/`.

1. Assign workers to the document: `indexing_update source: "document-name" sourceWorkers: "worker-a,worker-b"`
2. Run extraction: `indexing_execute processDir: ... sourceFilter: ["document-name"] maxItems: 1`
3. Both workers extract the document — outputs land in `state/extraction-notes/worker-a/` and `state/extraction-notes/worker-b/`
4. Compare quality per worker: `indexing_diagnose processDir: ... workerName: "worker-a"` and `indexing_diagnose processDir: ... workerName: "worker-b"`
5. Select the best output: `indexing_update source: "document-name" sourceSelectedExtraction: "worker-a"`

### Step 4 — Write a Validation Report

After each extraction, create a validation report in `model-validation/` inside the process directory. Name it after the model (e.g., `qwen3-14b-awq.md`). Use this template:

```markdown
# Model Validation Report: {model name}

## Model Details

| Field | Value |
|-------|-------|
| Model | {model ID} |
| Endpoint | {endpoint URL} |
| Quantization | {quantization method or N/A} |
| Parameters | {parameter count} |
| maxOutputTokens | {value} |
| Temperature | {value} |
| Docker Profile | {profile name or N/A for cloud} |
| Date | {YYYY-MM-DD} |

## Documents Indexed

| Document | Size | Chunks | Status |
|----------|------|--------|--------|
| {filename} | {size} | {chunks} | {Extracted / Failed} |

## Token Usage

| Metric | Value |
|--------|-------|
| Input Tokens | {value} |
| Output Tokens | {value} |
| Estimated Cost | {value} |

## Extraction Results

| Metric | Count |
|--------|-------|
| Entities | {count} |
| Relationships | {count} |

### Entities by Type
{table of entity types and counts}

### Relationships by Type
{table of relationship types and counts}

## Errors
{any extraction failures, JSON parse errors, truncation, etc. — or "None"}

## Quality Issues

### Critical
{issues that would corrupt the graph — hallucinated data, broken relationships, missing required relationships}

### Major
{issues that reduce graph utility — wrong source attribution, placeholder text, missing hierarchy}

### Minor
{edge cases, vague labels, optional properties omitted}

### Positive
{what the model did well — correct hierarchy, accurate properties, good label conventions}

## Extraction File
{path to the extraction JSON relative to the process directory}

## Summary
{2-3 sentence overall assessment and recommendation}
```

This report is the primary artifact for comparing models. Extraction outputs are organized by worker in `state/extraction-notes/{worker-name}/`.

### Step 5 — Compare Results

Compare extraction outputs using the scorecard below. The extraction notes are JSON files in `state/extraction-notes/{worker-name}/` — each contains the full list of entities, relationships, source references, and token usage.

---

## Quality Scorecard

Score each extraction output against these criteria. Rate each as Pass, Partial, or Fail.

### Structural Completeness

| Check | What to Look For |
|-------|------------------|
| **Entity count** | Does the model extract all entity types present in the source? Compare against a manual read of the document. |
| **Relationship count** | Are entities connected? A common failure mode is extracting entities but missing relationships. |
| **Component hierarchy** | Does the model create both top-level systems (HAS_COMPONENT) and sub-components (CONTAINS)? Shallow graphs missing CONTAINS relationships are a sign of insufficient depth. |
| **Cross-reference entities** | Are shared entities (Manufacturers, Fluids, Parts) created as reusable nodes? Or are they inlined as properties? |
| **Stub entities** | When relationships reference entities not fully described in the source (e.g., truck models in a compatibility chart), does the model create stub entities? Missing stubs cause broken relationships. |

### Extraction Accuracy

| Check | What to Look For |
|-------|------------------|
| **Property hallucination** | Does the model invent property values not stated in the source? Common failures: fabricating weights, materials, pressure ratings, or temperatures for components that don't have those specs in the source document. |
| **Placeholder text** | Does the model fill required fields with schema descriptions instead of data? E.g., `temperatureRange: "Operating temperature range"` instead of omitting the property. |
| **Copy-paste contamination** | Does the model copy a value from one entity onto unrelated entities? E.g., applying `pressure: "310 bar"` to every component when only the hydraulic system has that spec. |
| **Correct source attribution** | Are REQUIRES_FLUID relationships linked to the correct component (engine → engine oil) rather than generically to the equipment entity? |
| **Numeric accuracy** | Are capacities, dimensions, and counts extracted exactly as stated? No rounding, no unit conversion errors. |

### Vocabulary Compliance

| Check | What to Look For |
|-------|------------------|
| **Label conventions** | Does the model follow the starter kit's label conventions? E.g., `{componentType}: {modelNumber or name}` for Components. |
| **Summary quality** | Are summaries concise one-liners with key specs, or are they generic filler text? |
| **Property naming** | Does the model use the vocabulary's property names (`componentType`, `modelNumber`) rather than inventing new ones? |
| **Relationship types** | Does the model use the correct relationship type for each connection? E.g., CONTAINS for sub-components, not HAS_COMPONENT. |

### Relationship Quality

| Check | What to Look For |
|-------|------------------|
| **MANUFACTURED_BY present** | Every Equipment entity should have a MANUFACTURED_BY relationship. This is a basic structural requirement that weaker models often miss. |
| **REQUIRES_FLUID with capacity** | Fluid relationships without capacity values are incomplete. Check that the capacity property is populated on every REQUIRES_FLUID relationship. |
| **COMPATIBLE_WITH granularity** | For equipment matching, does the model create one relationship per compatible pair? Or does it collapse multiple matches into one generic relationship? |
| **Relationship properties** | Are relationship properties populated where the source provides data? E.g., `quantity` on HAS_COMPONENT, `passCount` on COMPATIBLE_WITH. |

---

## Domain Complexity Guide

Use this guide to estimate which model tier is needed for your domain. These are starting points — always validate with a comparison test.

### Low Complexity — Small Local Models Sufficient

Domains with highly structured, predictable content:

- **Company org charts** — Entities are people and departments. Relationships are REPORTS_TO and MEMBER_OF. Property extraction is name, title, email.
- **Product catalogs** — Entities are products and categories. Properties come from structured tables.
- **Simple inventories** — Items with part numbers, locations, quantities.

Characteristics: tabular data, few entity types, shallow relationship graphs, minimal ambiguity.

Recommended starting model: Qwen3-4B or equivalent 4B-parameter local model.

### Medium Complexity — Larger Local Models or Small Cloud Models

Domains with mixed structured and semi-structured content:

- **Mining equipment** (this project) — Spec sheets are highly structured, but O&M manuals mix tables with prose. Component hierarchies require two-level extraction. Truck-shovel matching involves chart interpretation.
- **Legal contracts** — Clauses and obligations are semi-structured. Cross-references between sections require context.
- **Software architecture** — APIs, services, and dependencies. Some are documented in tables, others in prose descriptions.

Characteristics: mix of tables and prose, moderate entity types (5-10), two-level hierarchies, some semantic judgment needed.

Recommended starting model: Claude Haiku for reliability, or Qwen3-8B+ for cost-free local extraction. Test both.

### High Complexity — Capable Cloud Models Required

Domains requiring deep reasoning, specialized knowledge, or nuanced judgment:

- **Medical/clinical** — Drug interactions, diagnostic criteria, treatment protocols, contraindications. Incorrect extraction can have safety implications. Models must understand medical terminology and reason about causal relationships between conditions, treatments, and outcomes.
- **Scientific research** — Experimental methods, statistical findings, causal claims. Requires distinguishing correlation from causation, understanding confidence intervals, and accurately representing study limitations.
- **Legal/regulatory compliance** — Regulatory requirements, jurisdictional variations, precedent chains. Requires precise language interpretation and understanding of legal hierarchy.
- **Financial instruments** — Complex derivatives, risk factors, regulatory capital calculations. Requires numerical precision and understanding of financial interdependencies.

Characteristics: specialized vocabulary, deep causal reasoning, high consequence of errors, ambiguous or context-dependent interpretation.

Recommended starting model: Claude Sonnet or Opus. Local models are unlikely to achieve acceptable accuracy for safety-critical or highly specialized domains without significant validation overhead.

---

## Output Token Budget

A common failure mode is the model producing truncated JSON because the output token limit is too low. The extraction prompt asks for a complete JSON object with all entities and relationships — if the model runs out of tokens mid-object, the response is unparsable.

### Estimating Output Token Requirements

| Document Type | Typical Entities | Typical Relationships | Estimated Output Tokens |
|---------------|-----------------|----------------------|------------------------|
| Spec sheet (2-6 pages) | 15-30 | 15-35 | 6,000-12,000 |
| O&M manual chapter (20-50 pages) | 30-50 | 50-100 | 12,000-20,000 |
| Product brochure (4-20 pages) | 5-15 | 5-15 | 3,000-6,000 |
| Fluids publication (10-50 pages) | 15-25 | 10-20 | 5,000-10,000 |
| Performance handbook chapter (50-100 pages) | 20-50 | 50-100 | 12,000-20,000 |

### Signs of Token Truncation

- Extraction returns 0 entities with a JSON parse error mentioning "Unterminated string" or "Unexpected end of JSON"
- The `failedSources` array in status output shows the error and a truncated response preview
- Entity count is suspiciously low compared to document richness

### Recommendations

- Start with `maxOutputTokens: 8192` for spec sheets and small documents
- Use `maxOutputTokens: 16384` for cloud models processing larger documents
- If truncation occurs, increase the limit and re-extract — the pipeline will retry failed documents
- For very large documents, the chunking system splits them into pieces that fit the model's context window, so output tokens per chunk should be sufficient even if the full document would require more

---

## Running the Validation Pipeline

After comparing model outputs manually, use the built-in validation tool to run automated checks:

```
memory_indexing_validate  processDir: ./index-processes/your-process
```

This runs:

- **Tier 1 (schema validation)** — Checks entity types match the vocabulary, required properties are present, relationship source/target labels reference existing entities in the extraction, and domain-specific range constraints from `validation-rules.json` pass.
- **Tier 2 (source-grounded verification)** — An LLM verifies that extracted values match the source document text. This catches hallucinated properties and incorrect attributions.

Validation reports are written to `state/validation-report.json` and flag specific issues with source evidence.

### Model-Specific Accuracy Patterns (from real validation runs)

| Model | Accuracy Rate | Primary Error Type | Notes |
|-------|--------------|-------------------|-------|
| **Haiku** | ~82% | Hard number fabrication | Fabricates specific numeric values (weights, durations, temperatures) not in source. Easy to catch with range validation rules. |
| **Sonnet** | ~79% | Soft property inference | Infers plausible values (skillLevel, priority, difficulty) not explicitly stated. Harder to catch — values are reasonable but ungrounded. |
| **Opus** | ~92% | Rare | Occasional over-extraction of implied relationships |
| **Qwen 3.5-35B** | ~75% | Entity type confusion | Higher orphan rate due to label inconsistency; benefits most from explicit domain guidance |

**Key insight:** Haiku's fabrication errors are more dangerous (specific wrong numbers) but easier to detect (range checks). Sonnet's inference errors are less dangerous (reasonable values) but harder to detect automatically.

### Validation Cost Data (from real runs)

| Scope | Documents | Items Validated | Input Tokens | Output Tokens | Cost |
|-------|-----------|----------------|-------------|---------------|------|
| Full (all entities + rels) | 11 documents | ~6,800 items | ~2.1M | ~450K | ~$4.50 |
| Targeted (2 problem docs) | 2 documents | ~800 items | ~250K | ~55K | ~$0.55 |

**Cost control recommendations:**
- Use `sourceFilter` to validate only documents with known issues
- Use `maxCost` to cap spend (e.g., `maxCost: 2.0` for a $2 ceiling)
- Use `maxBatches` to limit scope when exploring validation results
- Local models (Qwen 3.5-35B) are viable for validation — cost is zero, accuracy is sufficient for catching structural issues

---

## Phase B.7 — Full Extraction Validation (Optional)

Phase B.7 is an optional deep-validation step for safety-critical domains (mining, medical, legal) where data accuracy has real-world consequences. Unlike the automated Tier 1/2 validation in Phase B.5, Phase B.7 uses LLM agents with tool access to verify **every entity and relationship** against source documents.

### When to Use Phase B.7

Use Phase B.7 when:
- Data errors could endanger people (mining equipment maintenance, medical dosages, legal requirements)
- A full accuracy audit is required before the knowledge graph goes into production
- You suspect systematic extraction issues that Tier 2 spot-checks did not catch

Phase B.7 is intentionally not included in `memory_indexing_run` — it must be triggered explicitly.

### Configuration

Add a `validation` section to `config.json`. Any worker with an OpenAI-compatible endpoint works — no special configuration is needed for local models.

**Key configuration points:**
- `maxBatchSize` is **per-worker** — smaller models need smaller batches (5 for 32K context models, 20 for 200K context models)
- `maxTokens` must leave enough room for the input prompt (system prompt + vocabulary summary + domain guidance + tool call history). For a 32K context model, use `maxTokens: 8192` to leave ~24K for input.
- `maxToolCallsPerBatch` scales with batch size — more items need more source lookups. Use ~12 per item (e.g., 60 for batch size 5).
- When multiple workers are configured and no `workerName` override is specified, all workers run in parallel with batches distributed round-robin.

```json
{
  "fullValidation": {
    "batchSize": 10,
    "workers": [
      {
        "name": "local-qwen-35b",
        "endpoint": "http://localhost:8020/v1",
        "model": "Qwen/Qwen3.5-35B-A3B-GPTQ-Int4",
        "maxBatchSize": 5,
        "maxTokens": 8192,
        "costPerMillionInputTokens": 0,
        "costPerMillionOutputTokens": 0,
        "concurrency": 1,
        "maxToolCallsPerBatch": 60
      },
      {
        "name": "cloud-haiku",
        "llmProvider": "anthropic",
        "model": "claude-haiku-4-5-20251001",
        "maxBatchSize": 20,
        "maxTokens": 8192,
        "costPerMillionInputTokens": 1.00,
        "costPerMillionOutputTokens": 5.00,
        "concurrency": 1,
        "maxToolCallsPerBatch": 60
      }
    ]
  }
}
```

Cloud worker API keys go in `config.secrets.json` under `validation.workers.<name>.apiKey`:

```json
{
  "validation": {
    "workers": {
      "cloud-sonnet": { "apiKey": "sk-ant-..." }
    }
  }
}
```

Local workers (no `llmProvider`) use the built-in OpenAI-compatible provider and need no secrets.

### How It Works

The validation system injects a **vocabulary summary** and **domain guidance** (from the starter kit) into the system prompt. This teaches the validator that classification properties (e.g., `componentType: exhaust-system`) use standardized vocabulary values that are not expected to appear verbatim in source text. Without this context, validators produce high false-positive rates on classification properties.

The tool runs in the **background** — `memory_indexing_validate_full` returns immediately with a plan summary (items remaining, estimated batches, workers). Use `memory_indexing_validation_status` to monitor progress.

**Resumable across batch size changes:** Progress is tracked at the item level (`validatedItemKeys`), not by batch index. You can change `maxBatchSize` between runs and the system picks up where it left off — already-validated items are skipped regardless of how they were originally batched.

Each validation batch contains a set of entities and relationships from a single source document. The LLM agent has access to five source navigation tools:

| Tool | Description |
|------|-------------|
| `read_source_lines` | Read specific line ranges from the source document |
| `search_source` | Search for text within the source document |
| `read_source_section` | Read a named section (heading) from the source document |
| `list_source_headings` | List all headings in the source document |
| `read_other_source` | Read from a different source document (for cross-reference) |

The agent uses these tools to verify each entity and relationship, returning a verdict for each:

| Verdict | Meaning |
|---------|---------|
| `confirmed` | Entity/relationship is accurately extracted and grounded in the source |
| `mismatch` | A property value is wrong — source says something different |
| `hallucinated` | Entity or relationship has no basis in the source document |
| `unverifiable` | Source document does not provide enough information to confirm or deny |
| `corrected` | Fix mode: agent proposes a specific correction |

### Running Phase B.7

**Start with a sample** to assess cost and quality before running the full dataset:

```
memory_indexing_analyze          processDir: ./index-processes/mining-fleet
   (check validationEstimate in output for cost projection)

memory_indexing_validate_full    processDir: ./index-processes/mining-fleet
                                 mode: report
                                 workerName: local-qwen-35b
                                 maxBatches: 5
```

The tool returns immediately with a plan summary. **Check progress:**

```
memory_indexing_validation_status  processDir: ./index-processes/mining-fleet
```

The status shows cumulative progress across all runs — items validated, verdicts, accuracy rate.

**Run the full validation** (resumes from already-validated items):

```
memory_indexing_validate_full    processDir: ./index-processes/mining-fleet
                                 mode: report
```

When `workerName` is omitted, all configured workers run in parallel. Batches are distributed round-robin with each worker using its own `maxBatchSize`.

**Run with a specific worker** (e.g., to send failed items from a local model to a cloud model):

```
memory_indexing_validate_full    processDir: ./index-processes/mining-fleet
                                 workerName: cloud-haiku
```

Already-validated items are skipped regardless of which worker validated them previously.

**Fix mode** — agent proposes specific corrections in addition to verdicts:

```
memory_indexing_validate_full    processDir: ./index-processes/mining-fleet
                                 mode: fix

memory_indexing_apply_corrections  processDir: ./index-processes/mining-fleet
                                   minConfidence: 0.8
                                   dryRun: true
   (review proposed corrections, then apply)

memory_indexing_apply_corrections  processDir: ./index-processes/mining-fleet
                                   approveAll: true
```

### Cost Estimation

Phase B.7 is significantly more expensive than Phase B.5 because it validates every item (not a sample) using tool-use calls. The analyze tool reports a `validationEstimate` showing projected cost per worker.

Typical cost drivers:
- **~1,500 input tokens per item** (batch prompt + tool results per validation turn)
- **~200 output tokens per item** (verdict JSON)
- **~2 tool calls per item** on average for source navigation

Use `maxBatches` and `maxCost` parameters to control spend during evaluation.

---

## Iteration Workflow

Model validation is iterative. A typical workflow:

1. **Extract** with candidate model on 1 representative document
2. **Review** extraction output against the quality scorecard
3. **Identify** systematic issues (hallucination patterns, missing relationship types, label convention violations)
4. **Decide**: adjust the model, adjust the strategy, or both
   - If the model hallucinates properties → try a more capable model, or add explicit "do not invent values" rules to the extraction strategy
   - If the model misses relationship types → add worked examples to the strategy showing the expected output
   - If the model truncates → increase `maxOutputTokens`
   - If the model misinterprets charts → add chart interpretation rules (see mining `indexing-strategy.md` Rule 3 for an example)
5. **Re-extract** and compare again
6. **Scale up** once quality is acceptable on 2-3 representative documents

Track each iteration in `process-state.md` — note which model was tested, what issues were found, and what was changed. This journal is invaluable when returning to a process after a break or handing off to another team member.
