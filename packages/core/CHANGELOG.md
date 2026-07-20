# @utaba/deep-memory

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
