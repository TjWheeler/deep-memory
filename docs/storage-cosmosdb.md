# CosmosDB Gremlin Storage Provider

CosmosDB Gremlin implementation of both `StorageProvider` and `GraphTraversalProvider` for `@utaba/deep-memory` — persistent graph storage plus native graph queries from a single provider.

**Full documentation:** [`packages/storage-cosmosdb/README.md`](../packages/storage-cosmosdb/README.md) — installation, configuration, lifecycle, data model, query capabilities, **local emulator setup (Windows + WSL2)**, **Azure production deployment**, RU cost considerations, and testing.

**Related:** [Adaptive Import](storage-cosmosdb-adaptive-import.md) — how `importBulk` adapts concurrency to RU-constrained tiers (control loop, throttle detection, circuit breaker).
