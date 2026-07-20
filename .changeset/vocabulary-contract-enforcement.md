---
'@utaba/deep-memory': minor
'@utaba/deep-memory-indexer': minor
'@utaba/deep-memory-indexer-mcp-server': minor
---

Enforce the domain vocabulary as a contract during indexing: validate extraction output against the vocabulary before consolidation (reusing core's validator), discourage instance fabrication in the base extraction prompt, and harden extraction-review diagnostics so corrupt or fabricated output is no longer rated "good".

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
