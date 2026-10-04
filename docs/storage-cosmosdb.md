# CosmosDB Gremlin Storage Provider

CosmosDB Gremlin implementation of both `StorageProvider` and `GraphTraversalProvider` for `@utaba/deep-memory` — persistent graph storage plus native graph queries from a single provider.

**Full documentation:** [`packages/storage-cosmosdb/README.md`](../packages/storage-cosmosdb/README.md) — installation, configuration (including `vocabularyCacheTtlMs`), lifecycle, data model, slug uniqueness, vocabulary writes and the change log, repository delete and `RepositoryNotFoundError` on every repository-scoped call, batched type deletes, query capabilities, bulk operations (relationship-id rules, row errors and the throttle re-queue), **local emulator setup (Windows + WSL2)**, **Azure production deployment**, RU cost considerations, and testing.

**Where CosmosDB guarantees less than the other providers.** Gremlin on CosmosDB has no multi-document transaction and no unique constraint on a property, so some checks run apart from the write they guard:

- **Slug uniqueness** is checked, not enforced. `createEntity` checks the slug in the same request as the write, but two creates racing onto one slug can both pass and both write. An `updateEntity` that changes the slug checks with a separate read first, so its race window is wider. Neo4j, SQL Server and the in-memory provider enforce slug uniqueness atomically.
- **Repository-deleted checks** on relationship deletes, `importBulk` (per chunk), `exportAll` and a few reads run in a separate request from the work, so a racing `deleteRepository` can land between them.
- **A vocabulary change and its change record** are written in one traversal, not one transaction: a failure after the vocabulary write can leave the change without its record.
- **By-type delete counts** may come back lower than what was removed when a 429/503 re-send re-runs a partly applied drop.

The README's [Slug uniqueness](../packages/storage-cosmosdb/README.md#slug-uniqueness) and [Repository delete](../packages/storage-cosmosdb/README.md#repository-delete) sections give the detail.

**Related:**

- [Adaptive Import](storage-cosmosdb-adaptive-import.md) — how `importBulk` adapts concurrency to RU-constrained tiers (control loop, throttle detection, throttle-exhausted rows re-queued, circuit breaker).
- [Gremlin Compatibility & Performance Notes](cosmosdb-gremlin-compatibility.md) — what we've verified works (and doesn't) in CosmosDB's Gremlin subset, with the RU cost of each shape. **Read this before changing emitted Gremlin** in the compiler or any query module.
