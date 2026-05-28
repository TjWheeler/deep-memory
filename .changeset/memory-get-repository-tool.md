---
'@utaba/deep-memory-local-mcp-server': minor
---

Added `memory_get_repository` and exposed `legal` on `memory_update_repository` so the full repository record is reachable through the MCP surface.

- New tool `memory_get_repository` returns the full `StoredRepository` for one repository by `repositoryId` or `label` — including `legal`, `owner`, `governanceConfig`, `metadata` (e.g. `embeddingModelId`, `embeddingDimensions`), and creation provenance. Previously the MCP surface had no read path for these fields: `memory_list_repositories` excludes them from summaries and `memory_open_repository` returns only vocabulary and stats.
- `memory_update_repository` now accepts `legal`. The field has always been on the `RepositoryUpdate` type and is plumbed through all three storage providers (`@utaba/deep-memory-storage-sqlserver`, `@utaba/deep-memory-storage-cosmosdb`, `@utaba/deep-memory-storage-neo4j`); only the MCP input schema was missing, which meant `legal` could be set at create time but never modified.
