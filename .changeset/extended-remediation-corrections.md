---
'@utaba/deep-memory-indexer': minor
'@utaba/deep-memory-indexer-mcp-server': minor
---

Extend full-validation's correction surface from field-level edits to structural remodels: a validation worker can now propose creating an entity, creating a relationship, or retargeting a relationship's endpoint, in addition to the existing update/remove-property/delete operations.

## `@utaba/deep-memory-indexer`

- `ProposedCorrection` is now a discriminated union over `(itemType, operation)`. Existing `update`/`remove-property`/`delete` corrections keep their exact shape — on-disk `full-validation-corrections.json` from prior runs parses unchanged. New members: `entity:create`, `relationship:create`, `relationship:retarget`.
- New `CorrectionApplier` engine (`packages/indexer/src/validation/CorrectionApplier.ts`) executes all five operations deterministically, with group atomicity (a `remediationGroupId` links 2+ corrections that must all apply or none do), case-insensitive endpoint resolution for newly-created entities, collision handling (`already-exists`/`already-absent`/`not-found`), and apply-side conformance checks against the live vocabulary (unknown entity/relationship type is governance-gated; every other validation error is a hard failure).
- `IndexingOrchestrator.applyCorrections(...)` runs the applier against a process's extraction files; `ExecuteTool`'s `apply-corrections` action is now a thin caller.
- The full-validation worker's system prompt is extended with entity/relationship type descriptions and required properties (`VocabularySummarizer`) so structural proposals target valid vocabulary types, and worker output parsing accepts an optional `remediations` array (malformed entries are dropped with a note rather than failing the batch).

## `@utaba/deep-memory-indexer-mcp-server`

- Diagnose output and the full-validation review guidance render the new correction operations for selection alongside the existing ones.
