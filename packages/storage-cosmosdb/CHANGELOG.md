# @utaba/deep-memory-storage-cosmosdb

## 1.0.0

### Patch Changes

- Updated dependencies [e4d470f]
  - @utaba/deep-memory@1.0.0

## 0.17.0

### Minor Changes

- a6bd492: CosmosDB `findEntities` no longer fans out across every vertex of a type. `searchTerm` and `properties` filters now route through the Cosmos NoSQL (Document) endpoint via a new `CosmosDocumentClient`, with server-side case-insensitive `CONTAINS`, an approximate property-blob prefilter with client-side exact-match verification, and parallel `SELECT VALUE COUNT(1)` for exact totals. RU now scales with page size + result-set count rather than with type population.

  **Breaking:** `PaginatedResult.total` is now `number | undefined`. It is `undefined` only for Cosmos `findEntities` queries with a `properties` filter (where the approximate prefilter would distort an exact count); every other query shape continues to return an exact `number`. Callers should rely on `hasMore` for pagination control and check for `undefined` before arithmetic on `total`.

  The previous `UnsupportedQueryError` thrown for cross-type `searchTerm`/`properties` queries has been removed — those queries now succeed.

  `ensureSchema()` now warns if an externally-provisioned container excludes any of the indexed paths the SQL rewrite hits (`/entityLabel`, `/slug`, `/summary`, `/entityType`, `/properties`, `/repositoryId`).

- a6bd492: Major performance pass on the CosmosDB Gremlin provider — substantially reduced RU and round-trip cost across the AI-agent hot path. Observable behaviour is unchanged except for the additive surface noted below.

  - **Embeddings no longer ship on read.** `valueMap(true)` is replaced by explicit `.project(...)` chains across the compiler and every non-export read path. New opt-in `loadEmbeddings?: boolean` (default `false`) on `StorageProvider.getEntity` / `getEntities` / `findEntities` — only the vector-search path opts in.
  - **Per-process vocabulary cache** (60s TTL, invalidate-on-write) eliminates the per-traversal `_vocabulary` round-trip.
  - **`hasId(...)` everywhere.** Entity-id-anchored lookups (and edge-id lookups) now use direct doc fetch instead of property-index lookup.
  - **`exploreNeighborhood` and `findPaths` rewritten to the compiler model.** `exploreNeighborhood` issues `depth` round-trips (was `1 + fanout + fanout² + …`); `findPaths` issues exactly one via `.emit().repeat().times(N).simplePath().path()`.
  - **Single-round-trip writes.** `createEntity`, `createRelationship`, and `updateEntity` collapse to one round-trip via `fold().coalesce(...)` and inline projection.
  - **Single-round-trip deletes.** `deleteEntities` / `deleteRelationships` drop with `.aggregate('found')` and infer `notFound` client-side.
  - **Parallel paginated reads.** `getEntityRelationships`, `getVocabularyChangeLog`, `listRepositories` fire count + data in parallel via `Promise.all`. `getEntityRelationships` skips the count when `propertyFilters` is set and surfaces `total: undefined` rather than the previous (incorrect) unfiltered count.
  - **Fixed-shape write templates** for create/upsert across entities, relationships, and repositories — enables server-side prepared-plan caching on bulk-import paths. Absent optional properties are choose-skipped server-side, preserving the `hasNot(key)` semantic the `isNull` PropertyFilter relies on.

  **New public exports from `@utaba/deep-memory`:** `buildVertexProjectChain`, `buildEdgeProjectChain`, `GREMLIN_VERTEX_PROJECTION_FIELDS`, `GREMLIN_EDGE_PROJECTION_FIELDS` (used by storage providers to align projections with the stored-field contract). New `EntityReadOptions` type on the `StorageProvider` interface — implementers must accept `options?: EntityReadOptions` on `getEntity` / `getEntities` / `findEntities`.

  Fixes a pre-existing bulk-import bug where `upsertEntity` / `upsertRelationship` emitted `.property('repositoryId', ...)` on the update branch, which Cosmos rejects at parse time as "Partition key property of a vertex is readonly".

### Patch Changes

- @utaba/deep-memory@0.17.0
