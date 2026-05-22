# Indexer Consolidation Guide

Practical guide to the consolidation phase (Phase C) of the deep-memory indexing pipeline. Consolidation runs after extraction is complete and reviewed.

## What Consolidation Does

After extraction, each source document has its own set of entities and relationships. The same real-world entity -- a piece of equipment, a person, a component -- often appears in multiple documents with different labels, aliases, or property sets.

Consolidation solves this by:

1. **Deduplicating entities** across all extraction outputs using label matching, alias matching, and fuzzy similarity
2. **Assigning stable GUIDs** to each canonical (deduplicated) entity
3. **Resolving relationship references** so that relationships point to canonical entity GUIDs rather than raw text labels
4. **Building an export archive** in the deep-memory `ExportArchive` format, ready for import into a repository

The consolidator runs locally without LLM calls. All matching is deterministic -- exact slug comparison, alias lookup, and Jaro-Winkler string similarity. Low-confidence decisions are recorded in a merge log for human review.

## Algorithm

Consolidation proceeds in five steps, implemented in `packages/indexer/src/consolidation/Consolidator.ts`.

### Step 1: Collect Entities

All entities from all extraction outputs are gathered into a flat list, each tagged with its source document.

### Step 2: Deduplicate Within Extractions

Entities are grouped by type and label. For each entity:

- **Exact label match**: If another entity with the same type and lowercased label already exists, merge into it (confidence 1.0).
- **Alias match**: If any alias of the new entity matches any alias or label of an existing candidate (same type), merge into it (confidence 0.95).
- **New entity**: If no match is found, create a new candidate.

When merging, properties are combined (existing values take precedence on conflicts), the longer summary is kept, and aliases are unified.

### Step 3: Match Against Registry and Assign GUIDs

Each deduplicated candidate is matched against the entity registry using `EntityMatcher` (`packages/indexer/src/consolidation/EntityMatcher.ts`). The matcher uses three strategies, in order:

1. **Exact slug match** (confidence 1.0) -- the candidate's `{type}:{slugified-label}` matches a registry entry's slug exactly.
2. **Alias match** (confidence 0.9) -- the candidate's label or aliases appear in a registry entry's label or aliases (same entity type only).
3. **Label similarity** (variable confidence) -- Jaro-Winkler similarity between the candidate label and registry entry labels (same entity type only). Only matches with similarity >= 0.9 are considered.

Based on confidence:

- **>= 0.9**: Automatic merge into the existing registry entry. The entry gains new source documents and aliases.
- **0.8 to 0.9**: Auto-merged but flagged as a low-confidence decision in the consolidation report for review.
- **< 0.8**: Treated as a new entity. A fresh GUID is assigned and a new registry entry is created.

### Step 4: Resolve Relationships

A label-to-GUID lookup is built from the registry (including all aliases). Each extracted relationship's source and target labels are resolved to GUIDs through this lookup. Relationships where either endpoint cannot be resolved are skipped and counted in `relationshipsSkipped`. Duplicate relationships (same type, same source, same target) are merged with property combination.

### Step 5: Build Export Archive

The final output is an `ExportArchive` containing:

- **Manifest** with statistics (entity/relationship counts, type breakdowns), pipeline metadata (extraction model, source count), and optional legal metadata
- **Vocabulary** parsed from the starter kit vocabulary (markdown or JSON), augmented with any types found in the data but not in the vocabulary definition
- **Entities** as `StoredEntity[]` with GUIDs, slugs, properties, and provenance
- **Relationships** as `StoredRelationship[]` with GUIDs and resolved entity references

### About Jaro-Winkler Similarity

The `EntityMatcher` uses Jaro-Winkler similarity for fuzzy label matching. This algorithm (implemented in `packages/indexer/src/consolidation/EntityMatcher.ts`, mirroring the core implementation at `packages/core/src/vocabulary/similarity.ts`):

- Computes Jaro similarity based on character matches within a sliding window and transposition count
- Applies the Winkler modification: boosts the score for strings sharing a common prefix (up to 4 characters), with a scaling factor of 0.1
- Returns a value between 0 (no similarity) and 1 (identical strings)
- Matching is restricted to entities of the same type -- a `component` entity will never fuzzy-match against an `equipment` entity

## Running Consolidation

Consolidation is driven through the indexer MCP tools. The typical sequence:

```
indexing_update phase: "consolidate"
indexing_execute
```

This runs the consolidator, produces the export archive, entity registry, merge log, and consolidation report. After consolidation completes, move to the review phase:

```
indexing_update phase: "consolidation-review"
indexing_diagnose
```

The diagnose tool runs five automated checks and produces a consolidation review report.

## Reviewing with indexing_diagnose

The consolidation review diagnostics engine (`packages/indexer/src/review/ConsolidationReviewDiagnostics.ts`) runs five checks:

### 1. Merge Confidence Breakdown

Categorizes every merge event by confidence:

- **High confidence (>= 0.95)**: Exact label or slug matches. These are almost always correct.
- **Medium confidence (0.9 to 0.95)**: Alias matches and high-similarity label matches. Usually correct but worth a glance.
- **Low confidence (< 0.9)**: Fuzzy matches that were still auto-merged (0.8-0.9 range). Review these carefully.

Rating: `good` if no medium or low confidence merges; `acceptable` if no low confidence; `needs-work` if any low confidence merges exist.

### 2. Alias Specificity Warnings

Flags aliases that are likely too generic to be reliable:

- **Too short** (4 characters or fewer): Short aliases like "pump" or "oil" match broadly and can cause false merges across unrelated entities.
- **Ambiguous across types**: An alias that appears on entities of different types. For example, "CAT" used as an alias for both an equipment entity and a manufacturer entity.

Rating: `good` if no flags; `acceptable` if only short aliases (no cross-type ambiguity); `needs-work` if cross-type ambiguity exists.

### 3. Cross-Source Merge Summary

Lists entities that were merged from two or more source documents, sorted by source count. This is informational -- cross-source merges are expected and desirable for well-known entities. A high count means the entity appears broadly across your documentation. Review to confirm the merges are correct, especially for entities merged from many sources.

### 4. Type Consistency Flags

Checks property key overlap between merged entities using Jaccard similarity. If two entities were merged but their property key sets overlap by less than 30%, they may actually be different things that happen to share a name. For example, a "hydraulic system" component on a truck and a "hydraulic system" training course would have very different properties.

Rating: `good` if no flags; `acceptable` if 5 or fewer; `needs-work` if more than 5 flagged merges.

### 5. Merge Statistics

Summary statistics for the consolidation:

- **Merge rate by type**: How many entities of each type were merged vs. created new. High merge rates for common types (equipment, component) are normal.
- **Merge reason distribution**: Counts by match method (exact-label, exact-slug, alias, label-similarity).
- **Largest merge clusters**: Entities with the most aliases, indicating they absorbed the most duplicates. Review to confirm these are genuine consolidations rather than over-merging.

The overall rating is the worst of the merge confidence, alias specificity, and type consistency ratings.

## Handling Low-Confidence Merges

When `indexing_diagnose` reports low-confidence merges or a `needs-work` rating:

### Review the Merge Log

The merge log records every merge decision with:

- Canonical label and merged label
- Entity type
- Match method (exact-label, alias, label-similarity)
- Confidence score
- Source documents on both sides
- Property keys on both sides

Look for patterns: Are the flagged merges actually correct? Are specific document pairs producing most of the issues?

### Fix Incorrect Merges

If merges are wrong, the fix is upstream:

1. **Edit extraction notes** for the affected documents -- correct entity labels, add disambiguation to labels, remove misleading aliases
2. **Reconsolidate** to rebuild from the corrected extraction outputs:

```
indexing_execute action: "reconsolidate"
```

This reruns consolidation from scratch using the current extraction notes, producing a new registry, archive, and merge log.

### Fix Under-Merging

If entities that should be merged are not being matched:

- Add aliases to the entity in the extraction notes so the alias matcher can find the connection
- Ensure entity types are consistent across documents -- the matcher only compares entities of the same type

### Fix Over-Merging

If unrelated entities are being merged:

- Make entity labels more specific (e.g., "hydraulic pump" instead of "pump")
- Remove overly generic aliases from extraction notes
- Ensure entity types are correct -- mistyped entities can merge with the wrong group

## Common Consolidation Issues

### Entity Duplication

**Symptom**: The same real-world entity appears multiple times in the imported graph with slightly different labels.

**Cause**: Labels differ enough across documents that neither alias matching nor Jaro-Winkler similarity catches them (e.g., "CAT 793F" in one document, "Caterpillar 793F Water Truck" in another).

**Fix**: Add the variant labels as aliases in extraction notes, then reconsolidate.

### Over-Merging

**Symptom**: Distinct entities are collapsed into one. The merged entity has properties or relationships that don't make sense together.

**Cause**: Generic labels or short aliases that match across unrelated entities.

**Fix**: Make labels more specific, remove generic aliases, verify entity types are correct. Check the alias specificity diagnostic for flagged aliases.

### Under-Merging

**Symptom**: Entity count is higher than expected. Multiple registry entries represent the same thing.

**Cause**: Labels are too different for fuzzy matching to catch, or entity types differ between documents.

**Fix**: Standardize labels and types across extraction notes. Add aliases to help the matcher.

### Type Mismatches

**Symptom**: An entity extracted as `component` in one document and `system` in another is not merged, creating duplicates.

**Cause**: Different documents use different vocabulary types for the same concept.

**Fix**: Standardize entity types in extraction notes. The matcher only compares entities of the same type, so type consistency is required for merging to work. Review the vocabulary starter kit to confirm which type is correct, then update the extraction notes.

### Relationship Resolution Failures

**Symptom**: `relationshipsSkipped` count is high in the consolidation report.

**Cause**: Relationship source or target labels don't match any entity in the registry (including aliases).

**Fix**: Check that relationship labels in extraction notes use the exact entity label or a known alias. Typos and label mismatches are the most common cause.
