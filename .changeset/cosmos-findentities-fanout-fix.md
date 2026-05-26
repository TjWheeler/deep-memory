---
'@utaba/deep-memory-storage-cosmosdb': minor
---

CosmosDB `findEntities` no longer fans out across every vertex of a type. `searchTerm` and `properties` filters now route through the Cosmos NoSQL (Document) endpoint via a new `CosmosDocumentClient`, with server-side case-insensitive `CONTAINS`, an approximate property-blob prefilter with client-side exact-match verification, and parallel `SELECT VALUE COUNT(1)` for exact totals. RU now scales with page size + result-set count rather than with type population.

**Breaking:** `PaginatedResult.total` is now `number | undefined`. It is `undefined` only for Cosmos `findEntities` queries with a `properties` filter (where the approximate prefilter would distort an exact count); every other query shape continues to return an exact `number`. Callers should rely on `hasMore` for pagination control and check for `undefined` before arithmetic on `total`.

The previous `UnsupportedQueryError` thrown for cross-type `searchTerm`/`properties` queries has been removed — those queries now succeed.

`ensureSchema()` now warns if an externally-provisioned container excludes any of the indexed paths the SQL rewrite hits (`/entityLabel`, `/slug`, `/summary`, `/entityType`, `/properties`, `/repositoryId`).
