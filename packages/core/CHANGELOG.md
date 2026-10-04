# @utaba/deep-memory

## 0.24.0

### Minor Changes

- a5b9af5: Fix the 16 reports filed against 0.23.0: traversal identifier safety, error fidelity, retry-safe and race-free Neo4j writes, repository-scoped query cost, `REPOSITORY_NOT_FOUND` on every call to a deleted repository, a written vocabulary change log, resumable type deletion, fresh vocabulary for writes, batch create outcome reporting, property-name rules, and one relationship-id contract for import. Behaviour is now consistent across the InMemory, SQL Server, Neo4j and CosmosDB providers. Several changes break provider authors and event subscribers.

  ## Core (`@utaba/deep-memory`)

  - Traversal validation is stricter on every provider. Explore `depth` must be 1–3. findPaths `maxDepth` must be 1–5, `limit` 1–200 and `offset` 0–1000. Traverse `limit` must be 1–200 and `offset` 0–1000. All of these must be integers. Relationship types, filter keys and projection names must match `^[A-Za-z_][A-Za-z0-9_]*$`, and projection of reserved or system names is refused. A violation throws `TraversalValidationError`. New exports: `SAFE_IDENTIFIER_PATTERN` and `isSafeIdentifier`.
  - Property and type names:
    - Proposals refuse property names that are not identifiers or are reserved, and new type names that are not identifiers (e.g. `start-date`, `Board Meeting`, `2ND_DEGREE`).
    - Writes refuse such keys being set with `InvalidInputError` (field `properties.<key>`). Removing a key with `null`, and carrying an existing stored key unchanged, are allowed.
    - New exports: `RESERVED_ENTITY_PROPERTY_KEYS`, `RESERVED_RELATIONSHIP_PROPERTY_KEYS`, `isReservedPropertyName`, `propertyNameRefusal` and `assertWritablePropertyKeys`.
  - Slugs:
    - New `SlugConflictError` (`SLUG_CONFLICT`). Slug uniqueness per repository is now a `StorageProvider` contract, and the engine retries a slug clash on create and update.
    - `Duplicate*Error` and `ImportError` accept `{ cause }`.
  - Calls to a deleted repository: every repository-scoped call throws `RepositoryNotFoundError`, before any per-id outcome. Single deletes of a missing id throw not-found. A merge-mode `importRepository` into a missing repository throws instead of returning `success: false`.
  - Vocabulary:
    - The change log is written atomically with each vocabulary change. It is read newest first.
    - Resending a `delete_*_type` proposal for a type that is already gone deletes any data left behind and answers `approved`.
    - Relationship type names in proposals are normalised: the exact name is matched first, then the SCREAMING_SNAKE form.
  - Vocabulary freshness: the engine no longer holds its own copy of the vocabulary. It reads through the provider cache, so `invalidateCache` is removed. New `openRepository(id, { freshVocabulary: true })` makes validation read fresh; `OpenRepositoryOptions` is exported.
  - Batch creates: `createEntities` and `createRelationships` validate every member before writing. A failure after some members are stored throws `BatchPartialFailureError` (`BATCH_PARTIAL_FAILURE`, with `created`, `failedIndex` and `cause`). Search indexing is best-effort and emits `search:index_failed`.
  - Import: a create-mode import into an existing repository upserts. A merge import skips and reports entities refused as invalid input.
  - Breaking for provider authors:
    - `createRelationship(rid, rel, { idMinted? })`.
    - `saveVocabulary(rid, vocabulary, expectedVersion, changeRecord?)`.
    - `deleteRepository` returns counts.
    - By-type deletes return exact counts.
    - `importBulk` upsert refuses a reused relationship id whose type or endpoints differ (`RELATIONSHIP_ALREADY_EXISTS`).
  - Breaking for event subscribers:
    - `delete:started` is `{ repositoryId }`, with no totals.
    - `delete:progress` and `DeleteProgressCallback` lose their totals.
    - `delete:completed` carries the actual counts.

  ## Neo4j (`@utaba/deep-memory-storage-neo4j`)

  - Requires Neo4j 5.24 or later.
  - `SCHEMA_VERSION` goes from 1 to 2, adding `dm_vocabulary_change_unique` and `dm_vocabulary_repository`. An older provider fails `ensureSchema` against an upgraded database. To roll back, set `_Meta.schemaVersion` back to 1; see the README.
  - Writes are safe under the driver's managed retry: a per-call `_attempt` token (now reserved), retry-aware deletes, and bookmark-chained sessions. Creates and import chunks lock the repository marker, so a concurrent repository delete leaves no orphans. A reused relationship id is refused across types.
  - The constraint that fired decides the error (slug → `SlugConflictError`), and `cause` is kept. Import falls back to row-by-row only for failures caused by a row.
  - New `searchScoring: 'relevance' | 'isolated'` option.
  - Relationship lookups, deletes, drains and `findEntities` are anchored on the repository. `deleteRepository` no longer pre-counts.
  - By-type deletes run in batches of 500, and the vocabulary change log is written in the same statement as the vocabulary.
  - New `vocabularyCacheTtlMs` option.
  - An unsafe or reserved property key now throws `InvalidInputError`.

  ## CosmosDB (`@utaba/deep-memory-storage-cosmosdb`)

  - Every call throws `RepositoryNotFoundError` on a deleted repository, including on data a stopped delete left behind. `importBulk` refuses a missing repository.
  - `createRelationship` costs a flat ~16 RU and throws `EntityNotFoundError` for a missing endpoint. An id equal to any document in the partition throws `DuplicateRelationshipError`.
  - Slug uniqueness is checked but not atomic; the README documents the windows.
  - Import:
    - Throttle-exhausted rows are re-queued.
    - A 400, 409 or 413 becomes a row error; a 404 stops the import.
    - Upsert no longer rewrites a relationship's type or endpoint fields.
  - `saveVocabulary` is gated on the repository marker and writes a change record in the same traversal. This is not a transaction; see the README.
  - By-type deletes run in batches. Their counts can be low after a 429 or 503 re-send.
  - New `vocabularyCacheTtlMs` option. `getVocabulary` now serves from the cache; pass `fresh: true` to bypass it.
  - Property-key errors are `InvalidInputError`. Document-client errors are `ProviderError`.

  ## SQL Server (`@utaba/deep-memory-storage-sqlserver`)

  - Errors are typed: duplicate errors, `SlugConflictError` and foreign-key errors each map to their own type.
  - `deleteRepository` locks the repository row first and returns counts. By-type deletes are atomic and match the type name exactly.
  - `importBulk` stays all-or-nothing:
    - It holds the repository row for the whole call.
    - It rejects with `ImportError` and a typed `cause`, including for a reused relationship id whose type or endpoints differ. Previously the MERGE re-pointed the edge.
  - Every call throws `RepositoryNotFoundError` on a deleted repository.
  - `saveVocabulary` writes the change log in the same transaction.
  - New `vocabularyCacheTtlMs` vocabulary cache.
  - Property-key checks on writes and import.

  ## MCP server (`@utaba/deep-memory-local-mcp-server`)

  - `memory_create_entities` and `memory_create_relationships` report a partial failure as an error result carrying `{ code, failedIndex, created, suggestion }`.
  - `memory_query_graph` no longer returns `compiledQuery`, `compiledQueryLanguage` or `resourceCost` in its metadata.
  - Tool descriptions document the identifier rule and the traversal bounds.

## 0.23.0

### Minor Changes

- 0e3df87: Neo4j transaction timeouts now surface as `TRAVERSAL_TIMEOUT` (traversals) or the new `QUERY_TIMEOUT` (all other operations), and provider errors keep the driver error as `cause`.

  ## Typed timeout errors

  - `@utaba/deep-memory`: new `QueryTimeoutError` (code `QUERY_TIMEOUT`, `elapsedMs`) for a non-traversal operation that ran past the storage server's transaction timeout. The server rolled the transaction back, so a timed-out write did not commit.
  - `@utaba/deep-memory`: `DeepMemoryError` and `ProviderError` accept an optional `ErrorOptions` argument, so providers can attach the backend error as `cause`. `TraversalTimeoutError` accepts the same options, and its suggestion now says to narrow the query rather than retry it.
  - `@utaba/deep-memory-storage-neo4j`: a server-side transaction timeout (GQL status `25N14`, or a `…TransactionTimedOut…` code) was reported as a generic `ProviderError` on traversals and creates, and as a raw `Neo4jError` on other reads. Hosts treated it as an outage and retried the oversized query. It now raises `TraversalTimeoutError` from `traverse`, `exploreNeighborhood` and `findPaths`, and `QueryTimeoutError` from every other operation, with the driver error as `cause`.
  - `@utaba/deep-memory-storage-neo4j`: every `ProviderError` built from a driver error now sets `cause` to that error, so hosts can read the driver's code without parsing `message`.

  Migration: hosts that detected a timeout by reading `gqlStatus` / `code` on the raw `Neo4jError` from read paths should branch on `QUERY_TIMEOUT` instead, or read the driver error from `cause`.

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
