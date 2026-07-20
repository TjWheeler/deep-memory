# @utaba/deep-memory-local-mcp-server

## 0.21.1

### Patch Changes

- Updated dependencies
  - @utaba/deep-memory-storage-neo4j@0.21.1
  - @utaba/deep-memory@0.21.1
  - @utaba/deep-memory-embeddings-openai@0.21.1
  - @utaba/deep-memory-storage-cosmosdb@0.21.1
  - @utaba/deep-memory-storage-sqlserver@0.21.1

## 0.21.0

### Patch Changes

- Updated dependencies
  - @utaba/deep-memory-embeddings-openai@0.21.0
  - @utaba/deep-memory@0.21.0
  - @utaba/deep-memory-storage-cosmosdb@0.21.0
  - @utaba/deep-memory-storage-sqlserver@0.21.0
  - @utaba/deep-memory-storage-neo4j@0.21.0

## 0.20.1

### Patch Changes

- Updated dependencies [1e77fb9]
  - @utaba/deep-memory-embeddings-openai@0.20.1
  - @utaba/deep-memory@0.20.1
  - @utaba/deep-memory-storage-cosmosdb@0.20.1
  - @utaba/deep-memory-storage-sqlserver@0.20.1
  - @utaba/deep-memory-storage-neo4j@0.20.1

## 0.20.0

### Minor Changes

- a1f5560: Added `memory_get_repository` and exposed `legal` on `memory_update_repository` so the full repository record is reachable through the MCP surface.

  - New tool `memory_get_repository` returns the full `StoredRepository` for one repository by `repositoryId` or `label` — including `legal`, `owner`, `governanceConfig`, `metadata` (e.g. `embeddingModelId`, `embeddingDimensions`), and creation provenance. Previously the MCP surface had no read path for these fields: `memory_list_repositories` excludes them from summaries and `memory_open_repository` returns only vocabulary and stats.
  - `memory_update_repository` now accepts `legal`. The field has always been on the `RepositoryUpdate` type and is plumbed through all three storage providers (`@utaba/deep-memory-storage-sqlserver`, `@utaba/deep-memory-storage-cosmosdb`, `@utaba/deep-memory-storage-neo4j`); only the MCP input schema was missing, which meant `legal` could be set at create time but never modified.

### Patch Changes

- Updated dependencies [bbc6ba8]
- Updated dependencies [3e3e4c8]
- Updated dependencies [3b77ed0]
- Updated dependencies [58be448]
- Updated dependencies [e4d470f]
  - @utaba/deep-memory-storage-cosmosdb@0.20.0
  - @utaba/deep-memory-storage-sqlserver@0.20.0
  - @utaba/deep-memory@0.20.0
  - @utaba/deep-memory-embeddings-openai@0.20.0
  - @utaba/deep-memory-storage-neo4j@0.20.0

## 0.17.0

### Patch Changes

- Updated dependencies [a6bd492]
- Updated dependencies [a6bd492]
  - @utaba/deep-memory-storage-cosmosdb@0.17.0
  - @utaba/deep-memory@0.17.0
  - @utaba/deep-memory-embeddings-openai@0.17.0
  - @utaba/deep-memory-storage-sqlserver@0.17.0
