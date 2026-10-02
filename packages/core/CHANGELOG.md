# @utaba/deep-memory

## 0.22.0

### Minor Changes

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

- e81471f: Vocabulary changes are now compare-and-set with a bounded retry, so concurrent proposals no longer silently overwrite each other, and writes to a deleted repository are rejected.

  ## Vocabulary compare-and-set (`@utaba/deep-memory`)

  - `StorageProvider.saveVocabulary(repositoryId, vocabulary, expectedVersion)` now requires the version the update was derived from. A mismatch throws the new `VocabularyVersionConflictError` (code `VOCABULARY_VERSION_CONFLICT`, carrying `repositoryId`, `expectedVersion`, `actualVersion`) and leaves the stored vocabulary unchanged. It never creates a vocabulary; a missing repository or vocabulary throws `RepositoryNotFoundError`.
  - `StorageProvider.getVocabulary(repositoryId, options?)` accepts `{ fresh: true }` to bypass provider caches.
  - `StorageRepositoryConfig.vocabulary` seeds the initial vocabulary in `createRepository`; providers seed `createEmptyVocabulary(createdBy)` when it is omitted. `createEmptyVocabulary` is now exported.
  - `VocabularyEngine.proposeChange` reads fresh, re-runs deduplication, property validation and governance, and retries up to three times on a conflict. After the third conflict the error reaches the caller. Delete proposals write the vocabulary before cascade-deleting data.
  - The engine refuses to save a vocabulary whose version did not change. `incrementVersion` throws `InvalidInputError` on non-numeric version components. Import archives with a malformed vocabulary version are rejected. A create-mode import into an existing repository bumps the version past the stored one.
  - `memory_propose_vocabulary_extension` (`@utaba/deep-memory-local-mcp-server`) documents the conflict error.

  ## Providers

  - `@utaba/deep-memory-storage-sqlserver`: `saveVocabulary` is a single conditional `UPDATE` on the JSON version under a binary collation. `createRepository` seeds the supplied vocabulary. No schema change.
  - `@utaba/deep-memory-storage-neo4j`: the version is also stored as a `_Vocabulary.version` property and compared under the node's write lock. `createEntity` and `createRelationship` throw `RepositoryNotFoundError` once the repository marker is gone. `deleteRepository` removes the marker first, a retry finishes an interrupted delete, and it throws `RepositoryNotFoundError` for an id with no data. `createRepository` refuses while a delete is unfinished.
  - `@utaba/deep-memory-storage-cosmosdb`: the same contract. The version is stored as a vertex property, and a lost optimistic-concurrency write (412) is reported as a version conflict. Creates are gated on the repository vertex, and delete and create recovery work the same way as Neo4j.

  ## Upgrading

  - Run `ensureSchema()` once after every process is on this release (the local MCP server does this at startup). On Neo4j and CosmosDB it adds or repairs the stored version property. Until it runs, proposals on existing repositories fail with a `ProviderError` that names this remedy.
  - Running an earlier release against the same database is unsupported: it writes vocabularies without compare-and-set.

## 0.21.1

## 0.21.0

## 0.20.1

## 0.20.0

### Minor Changes

- 58be448: Preserved repository `legal`, `owner`, and `metadata` fields through `.dkg` export/import round-trip. Previously these fields were silently dropped when an archive was imported in `create` mode, so embedding model info, ownership, and licence notes set on the source repository did not survive portability.

  - `@utaba/deep-memory`: `ExportManifest.repository` gained optional `legal`, `owner`, and `metadata` fields. `RepositoryExporter` populates them from the source `StoredRepository`, and `RepositoryImporter` forwards them to `storage.createRepository` when importing in `create` mode.
  - `@utaba/deep-memory-local-mcp-server`: `memory_import_repository` reads the new manifest fields and threads them into the create-mode target config. Backward-compat: if `manifest.repository.metadata` is absent but the legacy `manifest.embedding` block is present, the embedding model identifier and dimensions are hydrated from there so older archives do not lose embedding metadata on round-trip.
  - Behaviour is unchanged for `merge` mode, which targets an existing repository and never touches these fields.

- e4d470f: Two traversal-surface changes that ship together.

  ## Direction enum renamed to `'out' | 'in' | 'both'`

  The direction surface has been standardised on short `'out'` / `'in'` values
  across every input and output. The previous mix of `'outbound'`/`'inbound'`
  (filter inputs, output edge direction, `RelationshipSummary` keys) and
  `'out'`/`'in'` (some internal step inputs) is gone — there is one vocabulary
  end-to-end. This trims roughly five characters per relationship-direction
  field returned to AI agents and removes a mismatch between the `traverse` and
  `explore` tool schemas where the same concept used different enum values.

  Breaking surface changes (no shim — values are renamed at the source):

  - `RelationshipDirection` (`@utaba/deep-memory`): `'outbound' | 'inbound' | 'both'` → `'out' | 'in' | 'both'`.
    Affects `RelationshipQueryOptions.direction` and `MemoryRepository.getRelationships(..., { direction })`.
  - `TraversalStep.direction` (`@utaba/deep-memory`): `'outbound' | 'inbound' | 'both'` → `'out' | 'in' | 'both'`.
    Affects every `TraversalSpec` consumer (compilers + executor + tool surface).
  - `TraversalRelationship.direction` (`@utaba/deep-memory`): output values renamed `'outbound'`/`'inbound'` → `'out'`/`'in'`.
  - `RelationshipSummary` (`@utaba/deep-memory`): keys renamed `{ outbound, inbound }` → `{ out, in }`. Affects
    responses from `getRelationshipSummary` and any tool result carrying
    `relationshipSummary` on entities (`memory_find_entities`,
    `memory_query_graph` with `includeRelationshipSummary`).
  - MCP tool schemas (`@utaba/deep-memory-local-mcp-server`): `memory_query_graph`,
    `memory_explore_neighborhood`, and `memory_get_relationships` all accept
    `enum: ['out', 'in', 'both']` for their `direction` input.
  - Storage providers (`@utaba/deep-memory-storage-cosmosdb`,
    `@utaba/deep-memory-storage-sqlserver`): direction-filter switch cases now
    match the renamed values.

  ## Referential integrity in `'all'`-mode traversal

  `'all'`-mode (interleaved entity + relationship union) now guarantees that
  every relationship returned in a page has both endpoint entities present in
  the same page. Previously, a relationship near a `limit` boundary could
  appear without one of its endpoint vertices, producing a "dangling" edge.

  - The union branch order in both compilers now places the vertex branch before
    the edge branch at each depth, so vertex evaluation precedes edge evaluation
    within the page slice.
  - At the `'all'`-mode page boundary the executor greedily expands any
    endpoint vertices that the edge branch contributed but the vertex branch
    did not — pulled from the already-materialised union elements, no extra
    storage round-trip. `hasMore` / `truncated` remain anchored to the
    server-side `range()` slice so pagination state is unaffected.
  - The CosmosDB provider mirrors the same greedy-expand on `traverseInternal`,
    capturing `rangeRowCount` before the expand so pagination metrics reflect
    the server slice rather than the post-expand inflation.
  - SQL Server traversal is covered automatically: it routes through the
    fallback executor.

  Live-validated against a Cosmos-backed graph (returnMode `'all'`, page
  boundary at limit 6 returns 5 entities + 1 edge with both endpoints in the
  page).

## 0.17.0

### Minor Changes

- e4d470f: Two traversal-surface changes that ship together.

  ## Direction enum renamed to `'out' | 'in' | 'both'`

  The direction surface has been standardised on short `'out'` / `'in'` values
  across every input and output. The previous mix of `'outbound'`/`'inbound'`
  (filter inputs, output edge direction, `RelationshipSummary` keys) and
  `'out'`/`'in'` (some internal step inputs) is gone — there is one vocabulary
  end-to-end. This trims roughly five characters per relationship-direction
  field returned to AI agents and removes a mismatch between the `traverse` and
  `explore` tool schemas where the same concept used different enum values.

  Breaking surface changes (no shim — values are renamed at the source):

  - `RelationshipDirection` (`@utaba/deep-memory`): `'outbound' | 'inbound' | 'both'` → `'out' | 'in' | 'both'`.
    Affects `RelationshipQueryOptions.direction` and `MemoryRepository.getRelationships(..., { direction })`.
  - `TraversalStep.direction` (`@utaba/deep-memory`): `'outbound' | 'inbound' | 'both'` → `'out' | 'in' | 'both'`.
    Affects every `TraversalSpec` consumer (compilers + executor + tool surface).
  - `TraversalRelationship.direction` (`@utaba/deep-memory`): output values renamed `'outbound'`/`'inbound'` → `'out'`/`'in'`.
  - `RelationshipSummary` (`@utaba/deep-memory`): keys renamed `{ outbound, inbound }` → `{ out, in }`. Affects
    responses from `getRelationshipSummary` and any tool result carrying
    `relationshipSummary` on entities (`memory_find_entities`,
    `memory_query_graph` with `includeRelationshipSummary`).
  - MCP tool schemas (`@utaba/deep-memory-local-mcp-server`): `memory_query_graph`,
    `memory_explore_neighborhood`, and `memory_get_relationships` all accept
    `enum: ['out', 'in', 'both']` for their `direction` input.
  - Storage providers (`@utaba/deep-memory-storage-cosmosdb`,
    `@utaba/deep-memory-storage-sqlserver`): direction-filter switch cases now
    match the renamed values.

  ## Referential integrity in `'all'`-mode traversal

  `'all'`-mode (interleaved entity + relationship union) now guarantees that
  every relationship returned in a page has both endpoint entities present in
  the same page. Previously, a relationship near a `limit` boundary could
  appear without one of its endpoint vertices, producing a "dangling" edge.

  - The union branch order in both compilers now places the vertex branch before
    the edge branch at each depth, so vertex evaluation precedes edge evaluation
    within the page slice.
  - At the `'all'`-mode page boundary the executor greedily expands any
    endpoint vertices that the edge branch contributed but the vertex branch
    did not — pulled from the already-materialised union elements, no extra
    storage round-trip. `hasMore` / `truncated` remain anchored to the
    server-side `range()` slice so pagination state is unaffected.
  - The CosmosDB provider mirrors the same greedy-expand on `traverseInternal`,
    capturing `rangeRowCount` before the expand so pagination metrics reflect
    the server slice rather than the post-expand inflation.
  - SQL Server traversal is covered automatically: it routes through the
    fallback executor.

  Live-validated against a Cosmos-backed graph (returnMode `'all'`, page
  boundary at limit 6 returns 5 entities + 1 edge with both endpoints in the
  page).

## 0.17.0
