---
'@utaba/deep-memory': patch
---

Vocabulary changes are now compare-and-set with a bounded retry, so concurrent proposals no longer silently overwrite each other, and writes to a deleted repository are rejected.

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
