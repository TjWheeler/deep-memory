---
'@utaba/deep-memory': minor
---

Fix the 16 reports filed against 0.23.0: traversal identifier safety, error fidelity, retry-safe and race-free Neo4j writes, repository-scoped query cost, `REPOSITORY_NOT_FOUND` on every call to a deleted repository, a written vocabulary change log, resumable type deletion, fresh vocabulary for writes, batch create outcome reporting, property-name rules, and one relationship-id contract for import. Behaviour is now consistent across the InMemory, SQL Server, Neo4j and CosmosDB providers. Several changes break provider authors and event subscribers.

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
