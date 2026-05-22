# Indexer — Post-Extraction Review Guide

A repeatable process for reviewing and correcting extraction outputs before consolidation. This is Phase B.6 of the pipeline — after automated validation, before consolidation. It is the quality gate where AI performs spot checks and a human approves corrections.

---

## Why Review Matters

Automated extraction is powerful but imperfect. Even with the best models, chunked extraction of large documents introduces systematic issues:

- **Chunk boundary artifacts** — An entity appears in one chunk's compatibility table but was defined in a different chunk, creating orphan relationships with slightly different labels.
- **Label variants** — The same equipment appears as `Cat 312F`, `Cat 312F/313F`, and `312F` across different sections. Deduplication catches exact matches but not all near-matches.
- **Property drift** — Early chunks extract a property one way, later chunks extract it differently as progressive context shifts.
- **Missing entities** — Dense reference tables (compatibility matrices, fluid charts) reference hundreds of models that may not all have standalone entries.

These issues are predictable and follow patterns. A structured review catches them reliably in 15-30 minutes per document, regardless of domain.

---

## When to Run Review

Run review after extraction and automated validation, before consolidation:

```
Phase A: Prepare
Phase B: Extract
Phase B.5: Validate (automated)
Phase B.6: Review ← YOU ARE HERE
Phase C: Consolidate
Phase D: Import
```

Review every extraction on the first run of a new domain. On subsequent runs with a proven vocabulary and strategy, review can be limited to new or high-value documents.

---

## The Review Process

### Step 1 — Run Diagnostic Checks

The AI agent runs a standard set of diagnostic queries against each extraction file. These are not judgment calls — they are factual checks that surface potential issues for human review.

**Check 1: Entity type distribution**
```
Count entities by entityType. Flag if any type has 0 entities when the document
clearly contains that content (e.g., a parts manual with 0 Part entities).
```

**Check 2: Property coverage**
```
Count entities with 0 properties. These are shells — they have a label but no
extracted data. A small number is normal (manufacturers, abstract concepts).
More than 5% suggests the extraction strategy needs tuning.
```

**Check 3: Orphan relationships**
```
Find relationships where sourceLabel or targetLabel does not match any entity
label (case-insensitive). Report the count and group by pattern.
```

**Check 4: Duplicate detection**
```
Find entities with the same entityType + label (case-insensitive). These should
be 0 after deduplication — any found indicate a dedup bug.
```

**Check 5: Label quality**
```
Find entities with very short labels (<=2 chars), labels containing JSON artifacts
(brackets, quotes), or labels that look like line numbers or table fragments.
```

**Check 6: Source reference spot check**
```
Pick 3-5 entities with sourceRefs, look up the referenced line numbers in the
source document, and verify the content matches the extracted data.
```

### Step 2 — Property Accuracy Spot Check

For each document, the AI agent selects 5-10 entities spread across the extraction (not just the first few) and verifies key properties against the source document:

1. Pick entities from different sections of the document (early, middle, late chunks)
2. For each entity, read the source lines referenced in `sourceRefs`
3. Compare extracted property values against the source text
4. Report any mismatches with the source evidence

**What to verify:**
- Numeric values (weights, dimensions, capacities, years) — these are the most common source of errors
- Unit conversions — check that metric and imperial values are both present and correct
- Label accuracy — the extracted label should match the source's own naming

**What not to verify:**
- Summaries — these are AI-generated descriptions, not source quotes
- Relationship completeness — this is checked via orphan analysis, not spot checks

### Step 3 — Classify Issues

After running diagnostics, classify each finding:

| Category | Action | Who Decides |
|----------|--------|-------------|
| **Orphan relationships** (missing source entity) | Remap to nearest matching entity, or create stub entity | AI proposes, human approves |
| **Label variants** (near-duplicate labels) | Standardize to the canonical label | AI proposes, human approves |
| **Incorrect property values** | Correct from source document | AI corrects, human verifies |
| **Missing entities** (referenced but not extracted) | Create from source data | AI extracts, human verifies |
| **Hallucinated properties** | Remove the property | AI flags, human confirms |
| **Structural issues** (wrong entity type, wrong relationship type) | Reclassify | Human decides |

### Step 4 — Apply Corrections

Corrections are applied directly to the extraction JSON files in `state/extraction-notes/{worker-name}/`. The AI agent edits the file programmatically. Every correction must be:

1. **Source-grounded** — The corrected value must come from the source document, not from the AI's general knowledge. The agent must cite the source line number.
2. **Logged** — Each correction is described in a correction report (what changed, why, source evidence).
3. **Reversible** — The original extraction file can be re-generated by re-running extraction.

**Canonical name rule:**

When fixing orphan relationships, always **remap the relationship's `sourceLabel`/`targetLabel` to the entity's canonical name** (the `label` field). Do not add aliases to entities as a shortcut to resolve orphans.

Only add an alias when the alternate name is a **real-world name worth preserving for search and lookup** — e.g., "Cat 325F L" is a legitimate short form that users would search for, so it belongs in aliases. But "Hydraulic System" as a shorthand for "Hydraulic System: Main Auxiliary Circuit" is just a label mismatch from extraction — remap the relationship, don't add the alias.

The distinction matters because:
- Aliases persist into the knowledge graph and affect search, deduplication, and consolidation.
- Orphan resolution is a data cleaning step — it should fix the reference, not pollute the entity with non-canonical names.

**Correction script pattern:**

```
For each orphan relationship:
  1. Read the relationship's sourceLabel and targetLabel
  2. Search existing entities for a case-insensitive near-match
     (strip suffixes like "GC", try parent model numbers, check aliases)
  3. If match found: remap the relationship's sourceLabel/targetLabel
     to the entity's canonical label
  4. If no match: search the source document for the missing label
     - If found: create a stub entity with properties from source
     - If not found: remove the relationship (it references something outside this document)
  5. Log the action taken
```

### Step 5 — Human Sign-Off

Present the correction report to the human reviewer. The report contains:

- **Summary** — X entities, Y relationships, Z corrections applied
- **Corrections by category** — grouped by type (remapped labels, new entities, removed orphans, property fixes)
- **Sample evidence** — for each correction type, show 2-3 examples with source line references
- **Remaining issues** — anything the AI couldn't resolve automatically (structural questions, ambiguous matches)

The human reviews and either:
- **Approves** — proceed to consolidation
- **Requests changes** — AI applies additional corrections
- **Flags for re-extraction** — if issues are systemic (wrong strategy, wrong model), re-extract the document

---

## Quality Thresholds

These thresholds are starting points. Adjust per domain and client requirements.

| Metric | Good | Acceptable | Needs Work |
|--------|------|------------|------------|
| Property coverage (entities with 1+ properties) | >95% | >90% | <90% |
| Orphan relationship rate | <2% | <5% | >5% |
| Duplicate entities | 0 | 0 | Any |
| Property accuracy (spot check) | 100% | >95% | <95% |
| Source ref accuracy (line numbers point to relevant content) | >90% | >80% | <80% |

---

## Common Patterns by Domain

### Technical specifications (equipment, electronics, materials)
- **Expect:** High entity counts, dense properties, many VARIANT_OF and COMPATIBLE_WITH relationships
- **Common issues:** Orphans from compatibility matrices, unit conversion errors, model number label variants
- **Review focus:** Property accuracy, orphan relationships

### Operational manuals (maintenance, procedures, troubleshooting)
- **Expect:** Moderate entity counts, rich summaries, deep CONTAINS hierarchies, procedural relationships
- **Common issues:** Chunk boundary splits on multi-step procedures, progressive context drift on long documents
- **Review focus:** Relationship completeness, summary accuracy

### Regulatory/compliance documents
- **Expect:** Reference-heavy, many cross-document relationships, version-sensitive labels
- **Common issues:** Hallucinated requirements (the model "knows" regulations and fills in details not in the source), date/version confusion
- **Review focus:** Property accuracy (zero tolerance for hallucination), source grounding

### Marketing/commercial documents
- **Expect:** Low entity density, subjective descriptions, promotional language in summaries
- **Common issues:** Promotional claims extracted as facts, vague properties
- **Review focus:** Filter promotional language from properties, verify numeric claims

---

## Worked Example: Mining Fleet Performance Handbook

**Document:** cat-performance-handbook-ed50.md (1.3MB, 97 chunks, 3,170 entities)

**Diagnostic results:**

| Check | Result | Status |
|-------|--------|--------|
| Entity type distribution | 2,431 Equipment, 424 Component, 150 OperationalContext, 150 Part, 12 Manufacturer, 3 Attachment | Good — expected distribution for a performance handbook |
| Property coverage | 3,169 / 3,170 with properties (99.97%) | Excellent |
| Orphan relationships | 142 / 3,685 (3.9%) | Acceptable — all from attachment compatibility tables |
| Duplicates | 0 | Perfect |
| Label quality | 0 short/garbage labels | Perfect |

**Orphan analysis:**
- All 142 orphans have missing *source* entities (the equipment model referenced in the relationship)
- 0 missing *target* entities
- Pattern: compatibility tables list models like `Cat 312F` that were extracted under grouped labels like `Cat 312F/313F` or parent labels like `Cat 312`
- 65 unique missing labels, all following the same pattern

**Correction plan:**
1. For each of the 65 missing labels, fuzzy-match to the nearest existing entity
2. Remap the 142 relationship sourceLabels to the matched entity
3. For any with no match, search the source document and create a stub entity
4. Log all changes

**Result after correction:** 0 orphan relationships, 0 new issues introduced.

---

## Integration with MCP Tools

The review phase uses standard tools:

- `memory_indexing_status` — Check pipeline state, confirm extraction is complete
- `memory_indexing_validate` — Run automated validation before review
- Direct file reads of `state/extraction-notes/{worker-name}/*.json` — Diagnostic scripts
- Direct file edits of `state/extraction-notes/{worker-name}/*.json` — Apply corrections
- Source document reads — Verify properties against original text

No new MCP tools are needed. The review process is conversational — the AI agent runs diagnostics, presents findings, proposes corrections, and the human approves.

---

## Checklist

Before proceeding to consolidation, confirm:

- [ ] Diagnostic checks run on all extraction files
- [ ] Orphan relationship rate below threshold
- [ ] Property accuracy verified on 5+ entities per document (spot check)
- [ ] Source reference accuracy verified on 3+ entities per document
- [ ] All corrections logged with source evidence
- [ ] Human has reviewed correction report and approved
- [ ] `process-state.md` updated with review findings and decisions
