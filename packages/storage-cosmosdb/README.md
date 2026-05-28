# @utaba/deep-memory-storage-cosmosdb

CosmosDB Gremlin storage provider for [`@utaba/deep-memory`](https://www.npmjs.com/package/@utaba/deep-memory). Implements both `StorageProvider` and `GraphTraversalProvider` — a single instance gives deep-memory persistent storage *and* native graph query capabilities backed by Azure CosmosDB.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-storage-cosmosdb
```

**Runtime dependency:** [`gremlin`](https://www.npmjs.com/package/gremlin) (Apache TinkerPop JavaScript driver).

## Quick Start (production / Azure)

```typescript
import { DeepMemory } from '@utaba/deep-memory';
import { CosmosDbProvider } from '@utaba/deep-memory-storage-cosmosdb';

const provider = new CosmosDbProvider({
  endpoint: 'wss://your-account.gremlin.cosmos.azure.com:443/',
  key: process.env.COSMOSDB_KEY!,
  database: 'deep-memory',
  container: 'graph',
});

await provider.ensureSchema();   // creates db + container if needed
await provider.initialise();     // opens Gremlin WebSocket

const dm = new DeepMemory({
  storage: provider,
  graphTraversal: provider,   // same instance — implements both interfaces
});
```

For local development with the CosmosDB emulator, see [Local emulator setup](#local-emulator-setup) below.

## Configuration

### `CosmosDbProviderConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `endpoint` | `string` | *required* | Gremlin WebSocket endpoint (e.g. `wss://your-account.gremlin.cosmos.azure.com:443/`) |
| `restEndpoint` | `string` | derived from `endpoint` | CosmosDB REST endpoint for database/container provisioning. Defaults to the Gremlin hostname on port 8081. |
| `key` | `string` | *required* | CosmosDB primary key |
| `database` | `string` | *required* | Database name |
| `container` | `string` | *required* | Container (graph) name |
| `partitionKey` | `string` | `/repositoryId` | Partition key path |
| `maxRetries` | `number` | `3` | Retries for transient errors (429 throttling, 503 unavailable) |
| `defaultTimeoutMs` | `number` | `30000` | Default query timeout |
| `rejectUnauthorized` | `boolean` | `true` | Set `false` for the local emulator (self-signed certs) |

CosmosDB Gremlin API does **not** support managed identity for data plane operations — authentication always uses an account key.

## Lifecycle

```typescript
const provider = new CosmosDbProvider({ ... });

await provider.ensureSchema();   // creates db + container, writes _meta vertex
await provider.initialise();     // opens Gremlin WebSocket

const dm = new DeepMemory({ storage: provider, graphTraversal: provider });
// ... use ...

await provider.dispose();        // closes WebSocket
```

`ensureSchema()` uses the CosmosDB REST API to create the database and container if they don't exist, then writes a `_meta` schema version vertex. Subsequent calls detect the existing schema and return early.

## Data Model

All data is partitioned by `repositoryId` — every vertex and edge stores it. This enables:

- Single-partition queries for all operations within a repository
- Efficient cascade deletes (drop all documents in a partition)
- Cross-partition queries only for `listRepositories()`

### Vertex Types

| Label | Purpose | ID Format |
|-------|---------|-----------|
| `_meta` | Schema version tracking | `_meta:schema` |
| `_repository` | Repository definitions and governance config | `repo:{repositoryId}` |
| `_vocabulary` | One vocabulary JSON document per repository | `vocab:{repositoryId}` |
| `_vocabularyChangeLog` | Audit trail for vocabulary changes | `vocablog:{changeId}` |
| `{entityType}` | Graph nodes — vertex label is the entity type | Entity GUID |

### Edge Types

Edge labels are relationship types. Each edge stores `sourceEntityId`, `targetEntityId`, `bidirectional`, user properties (dual-written — see [Property Storage](#property-storage)), and provenance.

### Property Storage

User-supplied properties on entities and relationships are **dual-written**: the full payload is JSON-stringified into the `properties` slot (round-trip authoritative — every shape JS can serialise survives), and every key whose value is natively Cosmos-storable (`string`, finite `number`, `boolean`, homogeneous arrays of those) is mirrored as a per-key native vertex/edge scalar so it can be reached by server-side Gremlin predicates (`has('orgType', 'company')`, `values('orgType')`, `group().by(...)`) and the exact-path `findEntities` SQL prefilter. Nested objects, `null`, mixed arrays, and arrays of objects live only in the blob and are not predicate-queryable. Schema-slot collisions on user keys (`entityType`, `id`, `'label'` on edges, …) throw `ProviderError` synchronously on every write path AND on `findEntities` property filters. See the [Properties model section in the Gremlin compatibility doc](https://github.com/TjWheeler/deep-memory/blob/main/docs/cosmosdb-gremlin-compatibility.md#properties-model) for the full contract.

| Data | Storage | Notes |
|------|---------|-------|
| Entity / relationship user properties | JSON blob in `properties` + per-key native vertex/edge scalars for native-storable values | Blob is authoritative on read. The scalars are a write-only mirror that powers server-side predicates and aggregation; the read path never consumes them. |
| Embeddings | JSON string in `embedding` vertex property | Stored for export/import fidelity; not searchable via Gremlin |
| Governance config | JSON string in `governanceConfig` vertex property | On `_repository` vertices |
| Vocabulary | JSON string in `vocabulary` vertex property | On `_vocabulary` vertices |

## Capabilities

`findEntities()` runs against the Cosmos NoSQL (Document) endpoint over the same backing container the Gremlin reads use — a separate code path because the Gremlin subset cannot express case-insensitive substring search server-side (`TextP.containing()` silently returns zero rows in the Cosmos Gremlin subset). The two paths share the container; `CosmosDocumentClient` issues raw HTTPS + HMAC requests with no SDK dependency. Supports:

- **Type filter** — `c.entityType[0]._value IN (@etype0, …)`
- **Text search** — case-insensitive substring via `CONTAINS(<field>, @term, true)` across `entityLabel` / `slug` / `summary`
- **Property filter** — three modes set by the filter values:
  - no filter → `PaginatedResult.total` is an exact `number`
  - every value native-storable → exact prefilter (`c.<key>[0]._value = @val` per clause against the dual-written scalar column); `total` is an exact `number`
  - any value non-storable → fallback `CONTAINS` substring on the JSON blob; `total: undefined` (the count branch is skipped because the substring prefilter over-reports)
  - Reserved-key collisions in `query.properties` throw `ProviderError` synchronously
- **Pagination** — SQL `ORDER BY c.id OFFSET @off LIMIT @lim`; data and count queries share one `WHERE` clause so `total` is consistent with the data page by construction

`GraphTraversalProvider` capabilities:

| Capability | Supported |
|-----------|-----------|
| Native Gremlin queries | Yes |
| Relationship property filters | Yes (server-side `has('<userKey>', value)` against the dual-written edge scalar) |
| Entity property filters | Yes (server-side `has('<userKey>', value)` against the dual-written vertex scalar) |
| Repeat/loop traversals | Yes |
| Dedup | Yes |
| Server-side aggregation over user properties | Yes — `group().by(values('<userKey>')).by(count())` and `dedup().by(values('<userKey>'))` resolve through the dual-written scalars |
| Relationship summaries | No |

RU cost is reported in `QueryMetadata.resourceCost` for graph traversal operations.

## Limitations

| Limitation | Impact |
|-----------|--------|
| No ranked / fuzzy / phrase text search | `findEntities()` text matching is substring `CONTAINS` over `entityLabel` / `slug` / `summary` only — pair with a separate `SearchProvider` for ranked, fuzzy, or multi-token search |
| No vector similarity | Embeddings stored for portability but not searchable |
| `group().by(values('<key>'))` cost scales with partition size | Server-side aggregation over user-property scalars works but touches every matching vertex in the partition — costly at millions of vertices. Mitigation options (write-side counter vertex, scheduled stats refresh) are deferred |
| No lambda steps | Cannot use closures in Gremlin queries |
| Nested-shape user properties are blob-only | Nested objects, `null`, mixed-type arrays, and arrays of objects survive via the JSON blob but get no native scalar mirror — so they are not server-side predicate-queryable. Homogeneous arrays of native-storable values *are* dual-written as multi-cardinality native properties. |

## Bulk Operations

`exportAll()` returns an async iterable of chunks (batches of 100), entities first then relationships. `importBulk()` uses upsert semantics and adapts concurrency to RU-constrained tiers — see [Adaptive import deep-dive](https://github.com/TjWheeler/deep-memory/blob/main/docs/storage-cosmosdb-adaptive-import.md) for the control loop, throttle detection, and circuit breaker behavior.

## Error Handling

All errors use the `@utaba/deep-memory` error hierarchy (`ProviderError`, `RepositoryNotFoundError`, `DuplicateEntityError`, etc.). Transient errors (429 throttling, 503 unavailable) are automatically retried with exponential backoff up to `maxRetries`.

## Local emulator setup

The **Windows desktop** CosmosDB emulator supports the Gremlin API. The Docker emulator does **not**.

### Installation

1. Install the [Azure CosmosDB Emulator](https://learn.microsoft.com/en-us/azure/cosmos-db/local-emulator) on Windows.
2. The default emulator key is: `C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==`

### Starting the emulator with Gremlin

From an **admin** PowerShell:

```powershell
& "C:\Program Files\Azure Cosmos DB Emulator\Microsoft.Azure.Cosmos.Emulator.exe" /EnableGremlinEndpoint
```

This starts the emulator with:
- REST API on port **8081** (HTTPS)
- Gremlin endpoint on port **8901** (WebSocket)

### Starting with network access (required for WSL2)

If you're connecting from WSL2, the emulator must listen on all interfaces. `/AllowNetworkAccess` requires the `/Key` parameter:

```powershell
& "C:\Program Files\Azure Cosmos DB Emulator\Microsoft.Azure.Cosmos.Emulator.exe" `
  /AllowNetworkAccess `
  /Key=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw== `
  /EnableGremlinEndpoint
```

You may also need Windows Firewall rules:

```powershell
netsh advfirewall firewall add rule name="CosmosDB REST" dir=in action=allow protocol=TCP localport=8081
netsh advfirewall firewall add rule name="CosmosDB Gremlin" dir=in action=allow protocol=TCP localport=8901
```

### Connecting from WSL2

From WSL2, connect using `host.docker.internal` which resolves to the Windows host:

```typescript
const provider = new CosmosDbProvider({
  endpoint: 'ws://host.docker.internal:8901/',
  restEndpoint: 'https://host.docker.internal:8081',
  key: 'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==',
  database: 'deep-memory-test',
  container: 'graph-test',
  rejectUnauthorized: false,
});
```

**Note:** The Gremlin endpoint uses `ws://` (plain WebSocket), not `wss://`. The emulator's self-signed certificate causes TLS errors with the Gremlin client when using `wss://`.

### Troubleshooting

| Problem | Solution |
|---------|----------|
| "Multiple attempts to restart" error | Full reset: shut down, delete `%LOCALAPPDATA%\CosmosDBEmulator`, reinstall if needed |
| Port 8081/8901 not reachable from WSL2 | Start with `/AllowNetworkAccess` and add firewall rules |
| Gremlin endpoint not starting | Ensure `/EnableGremlinEndpoint` flag is present at startup |
| Emulator crash loop | Delete data: `Remove-Item -Recurse -Force "$env:LOCALAPPDATA\CosmosDBEmulator"` then restart |
| TLS errors on Gremlin connection | Use `ws://` not `wss://`, and set `rejectUnauthorized: false` |

## Azure production deployment

1. Create a CosmosDB account with **Apache Gremlin** API in the Azure portal.
2. Note the Gremlin endpoint (e.g. `wss://your-account.gremlin.cosmos.azure.com:443/`).
3. Get the primary key from the Keys blade.
4. Call `ensureSchema()` once on first deployment — it creates the database and container.

```typescript
const provider = new CosmosDbProvider({
  endpoint: 'wss://your-account.gremlin.cosmos.azure.com:443/',
  key: process.env.COSMOSDB_KEY!,
  database: 'deep-memory',
  container: 'graph',
});
```

### Request Unit (RU) cost considerations

CosmosDB charges per Request Unit. The provider reports RU costs in `QueryMetadata.resourceCost` for `GraphTraversalProvider` operations. Key cost drivers:

- **Write operations** — entity/relationship creation costs ~5-10 RU per document
- **Cross-partition queries** — `listRepositories()` is the only cross-partition query
- **Graph traversals** — cost scales with depth and fan-out; use filters to constrain
- **Bulk imports** — `importBulk()` uses an adaptive concurrency controller that ramps down on 429s and back up when the cluster keeps up. See the [adaptive import deep-dive](https://github.com/TjWheeler/deep-memory/blob/main/docs/storage-cosmosdb-adaptive-import.md).

## Testing

The conformance test suite requires a running CosmosDB emulator with Gremlin enabled:

```bash
COSMOSDB_GREMLIN_ENDPOINT=ws://host.docker.internal:8901/ \
COSMOSDB_REST_ENDPOINT=https://host.docker.internal:8081 \
COSMOSDB_KEY=<emulator-key> \
  pnpm --filter @utaba/deep-memory-storage-cosmosdb test
```

Without `COSMOSDB_GREMLIN_ENDPOINT`, tests are skipped.

## Exports

```typescript
// Provider class (implements StorageProvider + GraphTraversalProvider)
import { CosmosDbProvider } from '@utaba/deep-memory-storage-cosmosdb';

// Config type
import type { CosmosDbProviderConfig } from '@utaba/deep-memory-storage-cosmosdb';

// Low-level connection (for advanced usage)
import { CosmosDbConnection } from '@utaba/deep-memory-storage-cosmosdb';
import type { CosmosDbConnectionConfig, GremlinResult } from '@utaba/deep-memory-storage-cosmosdb';
```

## See also

- [Adaptive import deep-dive](https://github.com/TjWheeler/deep-memory/blob/main/docs/storage-cosmosdb-adaptive-import.md) — how `importBulk` adapts concurrency to RU-constrained tiers
