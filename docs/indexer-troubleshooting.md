# Indexer Pipeline Troubleshooting Guide

Practical reference for diagnosing and fixing common issues in the `@utaba/deep-memory-indexer` pipeline. Organized by pipeline phase.

---

## Extraction Issues

### Sonnet Timeouts

**Cause:** `maxOutputTokens` set above your API tier limit, or the source document chunk is too large for the model to process within the timeout window.

**Fix:**

- Reduce `maxOutputTokens` to 8192 — this is safe for most API tiers.
- Reduce `maxChunkSize` so each extraction call processes less text.
- Split oversized documents before adding them to the source list.

### Orphan Relationship Patterns

Orphan relationships reference entities that don't exist in the extraction output. Four recurring patterns appear in real indexing runs:

1. **Alias vs canonical name** — The model used a short name like "CAT 325F" but the entity was extracted with its full label "Caterpillar 325F L Hydraulic Excavator". The relationship target doesn't match any entity slug.
   - **Fix:** Add alias rules to `domain-guidance.md` so the model uses consistent canonical labels.

2. **Generic systems not extracted** — A relationship references "hydraulic system" or "cooling system" but no corresponding entity was extracted.
   - **Fix:** Add guidance to extract system-level entities, not just components and equipment.

3. **Slug-style labels** — The model outputs lowercase slugs (`hydraulic-pump`) instead of proper labels (`Hydraulic Pump`).
   - **Fix:** Add explicit label format examples to `domain-guidance.md` showing the expected casing and style.

4. **Model variant grouping** — Specific variants are referenced in relationships but the model extracted a single grouped entity covering multiple variants.
   - **Fix:** Add granularity guidance to `domain-guidance.md` specifying when variants should be separate entities.

### Haiku Number Fabrication

**Pattern:** Haiku fabricates specific numbers — weights, durations, temperatures, capacities — that do not appear anywhere in the source text. The values look plausible, which makes them difficult to catch without cross-referencing the source.

**Impact:** Dangerous for safety-critical data. A fabricated operating temperature or fluid capacity could lead to equipment damage or safety incidents.

**Fix:** Use Haiku only for structured spec sheets with clear tables where values are unambiguous. For prose documents, narrative maintenance procedures, or troubleshooting guides, use Sonnet or Opus.

### Sonnet Soft Inferences

**Pattern:** Sonnet infers property values that are not explicitly stated in the source text. Common examples include `skillLevel`, `partType`, `difficulty` ratings, and classification properties.

**Impact:** The inferred values are often reasonable, but they are not grounded in the source material. This erodes trust in the knowledge graph when users expect provenance.

**Fix:** Add explicit guidance to the extraction prompt: "Only extract values explicitly stated in the source document. Do not infer or estimate values."

### JSON Parse Failures

**Cause:** LLM output was truncated before the closing JSON brace, or the model included preamble text (e.g., "Here is the extracted JSON:") before the actual JSON body.

**Fix:**

- Increase `maxOutputTokens` to give the model room to complete its output.
- Retry with a different worker — transient truncation sometimes resolves on retry.
- Check for progressive context bloat: when chunked extraction accumulates context across chunks, later chunks may run out of output token budget. Reduce `maxChunkSize` or clear accumulated context between chunks.

---

## Extraction Review Issues

### High Orphan Rate (>5%)

Run `indexing_diagnose` to get a detailed breakdown of orphan relationships, including which entity labels they reference.

**Common causes:**

- Alias mismatches between relationship targets and entity labels.
- Missing entity types in the vocabulary — the model couldn't create entities of the needed type.

**Fix:** Update `domain-guidance.md` with label canonicalization rules. Add any missing entity types to the vocabulary. Re-extract affected sources after guidance changes.

### Low Property Coverage (<70%)

The model is extracting entities but leaving most properties empty.

**Fix:**

- Add property extraction examples to `domain-guidance.md` showing what populated entities should look like.
- Review vocabulary property descriptions — unclear or overly abstract descriptions lead to low extraction rates.
- Consider whether the source documents actually contain the property data. Coverage below 70% sometimes reflects source limitations, not extraction failures.

### Bad Labels

Entity labels that don't match vocabulary naming conventions — inconsistent casing, abbreviations, or formatting.

**Fix:** Add explicit label format examples to `domain-guidance.md`. Include both correct and incorrect examples so the model can calibrate.

---

## Full Validation Issues

### Stale Validation State

**Symptom:** Running validation reports items as "already validated" from a previous run, even though the extraction data has changed.

**Cause:** Previous validation state files were not cleared before starting the new validation pass.

**Fix:** Use `indexing_update phase: "full-validation"` which automatically clears stale state before starting fresh.

### Validation Cost Overruns

**Cause:** Validating all items on a large graph without limits. Each validation call sends entities and relationships to the LLM, and costs scale linearly with graph size.

**Fix:**

- Use `maxCost` to set a dollar budget for the validation run.
- Use `maxBatches` to limit the number of validation batches.
- Use `sourceFilter` to validate only specific sources rather than the entire graph.

---

## Consolidation Issues

### Entity Duplication Across Documents

The same real-world entity appears in multiple source documents with slightly different labels (e.g., "Komatsu PC4000-6" in one document and "PC4000-6 Hydraulic Excavator" in another). The EntityMatcher uses fuzzy matching but can miss subtle variations.

**Fix:**

1. Run `indexing_diagnose` during consolidation-review to identify potential duplicates.
2. Review low-confidence merges — these are the most likely to be incorrect.
3. After correcting labels or merge decisions, use `indexing_execute action: "reconsolidate"` to re-run consolidation with the updated data.

### Incorrect Merges

Different entities were merged because their labels are similar but refer to distinct things (e.g., "PC4000-6" and "PC4000-11" are different machine models).

**Fix:**

1. Review the merge log to identify incorrect merges.
2. Correct extraction labels to be more distinctive.
3. Reconsolidate after corrections.

---

## Import Issues

### Missing Storage Configuration

**Error:** `Import storage configuration is missing`

**Fix:** Add an `import.storage` section to `config.json` specifying the storage backend:

```json
{
  "import": {
    "storage": {
      "type": "sqlserver",
      "config": { ... }
    }
  }
}
```

Supported types: `sqlserver`, `cosmosdb`, `in-memory`.

### Checkpoint Paused

The pipeline paused at a checkpoint waiting for human review of pending items.

**Fix:** Resume with explicit resolutions for each pending item:

```
indexing_execute action: "resume" resolutions: { "0": "accept", "1": "reject" }
```

### Re-import After Clearing

When re-importing into an existing repository, clear the previous data first:

```
memory_delete_repository deleteContentsOnly: true
```

**CosmosDB note:** CosmosDB needs time for consistency after deletion. Wait approximately 30 seconds before starting the re-import, or you may encounter conflicts with partially-deleted data.

---

## Embedding Issues

### Rate Limiting

The embedding endpoint returns rate-limit errors when processing many entities in rapid succession.

**Fix:**

- Reduce `batchSize` in the config (default is 50). A smaller batch size sends fewer embedding requests per cycle.
- Add delays between batches if the provider has strict per-minute limits.

### Threshold Tuning

The default similarity threshold of 0.7 works well for general-purpose queries but is too high for technical domains.

**Observed patterns from real indexing runs:**

- Equipment and component queries score 0.70+ and pass the default threshold.
- Troubleshooting and procedure queries score 0.55-0.59 and get filtered out.

**Fix:** Lower the similarity threshold to 0.5 for technical domains where query vocabulary diverges from entity labels.

---

## General Issues

### Config vs Tool Parameters

Tool parameters (`maxItems`, `sourceFilter`, `maxCost`, etc.) override the corresponding `config.json` values for that run only. They do not persist.

To make persistent changes, edit `config.json` directly. Tool parameter overrides are useful for one-off runs with different limits.

### Stuck Process Locks

**Symptom:** The pipeline reports "A operation is already running" but no operation is actually in progress.

**Cause:** A previous process died or was killed without releasing its lock.

**Fix:** Run `indexing_stop` to release the process lock, then retry the operation.

### MCP Server Not Reflecting Changes

After rebuilding packages with `pnpm build`, the running MCP server still uses the old code.

**Fix:** Restart the Claude Code terminal after rebuilding. The MCP server loads code at startup and does not hot-reload.
