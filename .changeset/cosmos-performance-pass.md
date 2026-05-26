---
'@utaba/deep-memory-storage-cosmosdb': minor
---

Major performance pass on the CosmosDB Gremlin provider — substantially reduced RU and round-trip cost across the AI-agent hot path. Observable behaviour is unchanged except for the additive surface noted below.

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
