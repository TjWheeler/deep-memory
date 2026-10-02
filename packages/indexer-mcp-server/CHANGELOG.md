# @utaba/deep-memory-indexer-mcp-server

## 0.20.0

### Minor Changes

- b0be551: Add Docling document conversion to the indexer: PDF/DOCX/HTML/PPTX sources are converted to Markdown before extraction, via a containerised `docling-serve` service and a new `convert` action. The existing plain-text/Markdown pipeline is unchanged. Conversion is resilient at scale — large documents convert asynchronously, unchanged sources are skipped, born-digital PDFs skip the OCR tax, and every conversion leaves a diagnostic trail.

  ## `@utaba/deep-memory-indexer`

  - New `packages/indexer/src/conversion/` module: `DoclingClient` (a typed HTTP client over `docling-serve` with retry/backoff, content-hash caching, and a timeout), `DocumentConverter` (writes `state/converted/{docSlug}.md` per source), plus its types and typed errors (`DoclingServiceError`/`DoclingTimeoutError`, extending core `ProviderError`).
  - `IndexingOrchestrator` now registers `.pdf/.docx/.html/.htm/.pptx` sources as `needs-conversion` at prepare and exposes `convert()`, which converts them and records `derivedTextPath` on each source. Extraction reads the derived Markdown (`derivedTextPath ?? path`) and hard-guards against feeding un-converted binary sources to the LLM.
  - `IndexSourceStatus` gains `needs-conversion` and `converting`; `IndexSource` gains `derivedTextPath` and `originalFormat`. `StateManager.getCurrentPhase()` routes such sources to the prepare phase so convert-before-extract is enforced, and `resetConvertingSources()` recovers conversions interrupted by a killed process.
  - **Asynchronous conversion** (`DoclingClient.convertViaAsync` — submit/poll/fetch against the `docling-serve` async API) so large documents that exceed the synchronous server-side wait ceiling convert reliably. Selected per run via `services.docling.mode` (`'sync' | 'async'`, default `'async'`); a `404` on the async submit carries an actionable `suggestion` naming the sync escape hatch.
  - **Content-hash idempotency:** a `sourceHash` (sha256 of the raw bytes) is stored on each source. A re-run skips unchanged sources (`skipped-unchanged`, no docling round trip); `prepare` detects a source edited on disk, resets it to `needs-conversion`, and deletes its stale derived files so no out-of-date Markdown feeds extraction.
  - **Per-document OCR heuristic:** non-PDF formats and explicit `doOcr` overrides bypass it; PDFs left to the heuristic convert first without OCR and reconvert once with OCR only when the text yield per page is implausibly low. No page count means no fallback (a warning is recorded instead of guessing).
  - **Conversion diagnostics:** every real conversion also persists a `{docSlug}.docling.json` sidecar and contributes to a `conversion-report.json` (per-doc timing, page/table counts, warnings, OCR-fallback flag), summarized for the tools. `IndexSource` gains `sourceHash`, `derivedDoclingJsonPath`, `doOcr`, and a compact `conversion` status mirror.
  - New `services.docling` configuration: `endpoint` (defaults to `http://localhost:5001`), `timeoutMs`, `maxRetries`, `doOcr`, `apiKey`, plus `mode`, `pollIntervalMs`, `maxPollIntervalMs`, `maxTotalWaitMs`, and `ocrTextYieldThreshold`.

  ## `@utaba/deep-memory-indexer-mcp-server`

  - `indexing_execute` accepts a new `action: "convert"` in the prepare phase; `StatusTool` reports `needs-conversion`/`converting` counts; `executeExtract` refuses to run while sources still need conversion, with an actionable message.
  - The convert-start response reports the conversion `mode`; when async, it notes that progress is pollable via `indexing_status`, which now surfaces the live current document, task position, elapsed time, and whether OCR is running from the active conversion-progress file.
  - `convert` now honours the `sourceFilter` tool param (it previously ignored it while `extract` honoured it) and reports the filtered count/list, so the started-count matches what will actually convert; the shared filter predicate is used by convert, extract, and the converter.
  - `indexing_diagnose` gains conversion checks sourced from `conversion-report.json`: per-doc table counts, conversion warnings, and a slow-conversion flag.
  - `InitTool` scaffolds a commented `services.docling` block in `config.json` (including `mode` and OCR notes) and a `docling.apiKey` slot in the secrets template.

- ea83cd5: Extend full-validation's correction surface from field-level edits to structural remodels: a validation worker can now propose creating an entity, creating a relationship, or retargeting a relationship's endpoint, in addition to the existing update/remove-property/delete operations.

  ## `@utaba/deep-memory-indexer`

  - `ProposedCorrection` is now a discriminated union over `(itemType, operation)`. Existing `update`/`remove-property`/`delete` corrections keep their exact shape — on-disk `full-validation-corrections.json` from prior runs parses unchanged. New members: `entity:create`, `relationship:create`, `relationship:retarget`.
  - New `CorrectionApplier` engine (`packages/indexer/src/validation/CorrectionApplier.ts`) executes all five operations deterministically, with group atomicity (a `remediationGroupId` links 2+ corrections that must all apply or none do), case-insensitive endpoint resolution for newly-created entities, collision handling (`already-exists`/`already-absent`/`not-found`), and apply-side conformance checks against the live vocabulary (unknown entity/relationship type is governance-gated; every other validation error is a hard failure).
  - `IndexingOrchestrator.applyCorrections(...)` runs the applier against a process's extraction files; `ExecuteTool`'s `apply-corrections` action is now a thin caller.
  - The full-validation worker's system prompt is extended with entity/relationship type descriptions and required properties (`VocabularySummarizer`) so structural proposals target valid vocabulary types, and worker output parsing accepts an optional `remediations` array (malformed entries are dropped with a note rather than failing the batch).

  ## `@utaba/deep-memory-indexer-mcp-server`

  - Diagnose output and the full-validation review guidance render the new correction operations for selection alongside the existing ones.

- 20459b5: Enforce the domain vocabulary as a contract during indexing: validate extraction output against the vocabulary before consolidation (reusing core's validator), discourage instance fabrication in the base extraction prompt, and harden extraction-review diagnostics so corrupt or fabricated output is no longer rated "good".

  ## @utaba/deep-memory

  - Added root exports of `validateEntity` and `validateRelationship` (plus `getEntityTypeDef` / `getRelationshipTypeDef`) so downstream packages can reuse core's vocabulary validator instead of duplicating it. Purely additive — no change to existing consumers. (This bump propagates across the fixed group.)

  ## @utaba/deep-memory-indexer

  - Vocabulary conformance gate: `VocabularyMarkdownParser` now populates `enumValues` from closed-enum "Allowed values" tables (a `Type: enum` row with no such table degrades to no check rather than rejecting every value); the new `VocabularyConformanceGate` validates extraction output against the vocabulary — unknown types, endpoint types, required properties, and closed-enum values — by calling core's validator, and is governance-mode aware (`locked` fails, `managed`/`open` warn; `managed` emits vocabulary-extension recommendations for recurring non-conforming closed-enum values). Conformance examples are capped per violation class so endpoint/enum classes are no longer starved.
  - Base-prompt anti-fabrication: `PromptBuilder`'s system prompt states two domain-neutral rules — an enumerated list of recommended/allowed values on an open property is a naming vocabulary, not a checklist of entities to instantiate; and a cross-reference/deferral cell ("Refer to Clause X") is not a property value and should be modelled as its own entity.
  - Review diagnostics hardening (`ReviewDiagnostics`): label normalization (diacritic strip, case-fold, separator/whitespace fold) so dedup catches accent/spacing variants; a decoupled token-subset "possible duplicates" signal (informational, never changes the exact-duplicate rating); `controlled-vocabulary-as-entities` and `cross-product-relationships` fabrication smells; zero-property-endpoint detection independent of aggregate coverage; and a conformance summary threaded into the review report.
  - Convert-trigger fix: an already-converted, byte-unchanged source re-queues to `needs-conversion` when its `sourceConvertOptions` change, so a per-source conversion override actually takes effect.
  - Removed the unused `mergeConvertOptions` re-export from the package entrypoint (the function remains available internally; it was never consumed via the public surface).

  ## @utaba/deep-memory-indexer-mcp-server

  - `indexing_diagnose` surfaces vocabulary-conformance counts by violation class and the new dedup/fabrication/zero-property-endpoint checks.
  - `indexing_getting_started` documents `full-validation` with a stronger model as the recommended verification backstop for fabrication-prone corpora, paired with the base-prompt guardrail.

### Patch Changes

- Updated dependencies [b0be551]
- Updated dependencies [ea83cd5]
- Updated dependencies [ea83cd5]
- Updated dependencies [e81471f]
- Updated dependencies [20459b5]
  - @utaba/deep-memory-indexer@0.20.0
  - @utaba/deep-memory@0.22.0
  - @utaba/deep-memory-indexer-llm-anthropic@0.19.3
  - @utaba/deep-memory-storage-cosmosdb@0.22.0
  - @utaba/deep-memory-storage-sqlserver@0.22.0

## 0.19.4

### Patch Changes

- @utaba/deep-memory@0.21.1
- @utaba/deep-memory-storage-cosmosdb@0.21.1
- @utaba/deep-memory-storage-sqlserver@0.21.1
- @utaba/deep-memory-indexer@0.19.4

## 0.19.3

### Patch Changes

- @utaba/deep-memory@0.21.0
- @utaba/deep-memory-storage-cosmosdb@0.21.0
- @utaba/deep-memory-storage-sqlserver@0.21.0
- @utaba/deep-memory-indexer@0.19.3
- @utaba/deep-memory-indexer-llm-anthropic@0.19.2

## 0.19.2

### Patch Changes

- @utaba/deep-memory@0.20.1
- @utaba/deep-memory-storage-cosmosdb@0.20.1
- @utaba/deep-memory-storage-sqlserver@0.20.1
- @utaba/deep-memory-indexer@0.19.2

## 0.19.1

### Patch Changes

- Updated dependencies [9036487]
- Updated dependencies [bbc6ba8]
- Updated dependencies [3e3e4c8]
- Updated dependencies [3b77ed0]
- Updated dependencies [58be448]
- Updated dependencies [e4d470f]
  - @utaba/deep-memory-indexer-llm-anthropic@0.19.1
  - @utaba/deep-memory-storage-cosmosdb@0.20.0
  - @utaba/deep-memory-storage-sqlserver@0.20.0
  - @utaba/deep-memory@0.20.0
  - @utaba/deep-memory-indexer@0.19.1

## 0.16.1

### Patch Changes

- Updated dependencies [a6bd492]
- Updated dependencies [a6bd492]
  - @utaba/deep-memory-storage-cosmosdb@1.0.0
  - @utaba/deep-memory@1.0.0
  - @utaba/deep-memory-storage-sqlserver@1.0.0
  - @utaba/deep-memory-indexer@0.16.1
  - @utaba/deep-memory-indexer-llm-anthropic@1.0.0
