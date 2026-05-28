# @utaba/deep-memory-storage-neo4j

Neo4j storage provider for [`@utaba/deep-memory`](https://www.npmjs.com/package/@utaba/deep-memory). Implements both `StorageProvider` and `GraphTraversalProvider` against Neo4j Community Edition over Bolt — a single instance gives deep-memory persistent storage **and** native Cypher graph queries.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-storage-neo4j
```

**Runtime dependency:** [`neo4j-driver`](https://www.npmjs.com/package/neo4j-driver) (the official Neo4j JavaScript driver, Apache-2.0, types bundled).

## Quick Start

```typescript
import { DeepMemory } from '@utaba/deep-memory';
import { Neo4jStorageProvider } from '@utaba/deep-memory-storage-neo4j';

const provider = new Neo4jStorageProvider({
  uri: 'bolt://localhost:7687',
  username: 'neo4j',
  password: 'DeepMem-Dev-1234',
  database: 'neo4j',
});

await provider.initialize();   // verifies connectivity
await provider.ensureSchema(); // creates constraints + indexes (idempotent)

const dm = new DeepMemory({
  storage: provider,
  graphTraversal: provider,   // same instance — implements both interfaces
});
```

For local development with Docker, see [Local development setup](#local-development-setup) below.

## Configuration

### `Neo4jStorageProviderConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `uri` | `string` | *required* | Bolt URI. `bolt://` for plain TCP, `bolt+s://` for TLS, `neo4j://` for routed clusters, `neo4j+s://` for AuraDB. |
| `username` | `string` | *required* | Basic-auth username. |
| `password` | `string` | *required* | Basic-auth password. |
| `database` | `string` | `'neo4j'` | Database name. The driver manual recommends specifying this explicitly even on Community Edition single-database instances. |
| `userAgent` | `string` | `'@utaba/deep-memory-storage-neo4j'` | User-agent string sent on the Bolt handshake. |
| `maxTransactionRetryTime` | `number` | driver default | Maximum time (ms) the driver will retry a managed transaction on transient errors. |
| `reportUsage` | `UsageSink` | `undefined` | Optional sink invoked once per public method call with the server-side time (ms) consumed. See [Usage tracking](#usage-tracking). |
| `profileTraversals` | `boolean` | `false` | When `true`, prepends `PROFILE` to compiled traversal queries and surfaces the plan summary on the sink record. `PROFILE` more than doubles wall-clock on short traversals — turn it on only when actively investigating planner behaviour. |

The provider holds a single Neo4j `Driver` per instance, per the driver's documented "create once, share, close on shutdown" lifecycle.

## Lifecycle

```typescript
const provider = new Neo4jStorageProvider({ ... });

await provider.initialize();   // verifyConnectivity over Bolt
await provider.ensureSchema(); // CREATE CONSTRAINT/INDEX … IF NOT EXISTS

const dm = new DeepMemory({ storage: provider, graphTraversal: provider });
// ... use ...

await provider.dispose();      // closes the Bolt driver
```

`ensureSchema()` runs constraint and index DDL idempotently against the configured database and writes a `_Meta` schema-version handshake. Subsequent calls detect the existing schema and return early. It does **not** create the database itself — Neo4j Community Edition has a single user database; the operator is responsible for the target database existing before the provider connects.

## Data Model

### Multi-tenancy via `repositoryId`

Neo4j Community Edition has a single user database, so multiple repositories share one Neo4j database and are isolated by a `repositoryId` property on every node and edge. **Every Cypher statement** issued by this provider — apart from a small allowlist of system queries (`ensureSchema`, `listRepositories`, `_Meta` reads) — carries a required `$rid` parameter and references it in a predicate. The `Neo4jConnection` chokepoint enforces this at runtime: a Cypher string that omits `$rid` raises `ProviderError`, and no other file in the package is allowed to touch the driver directly.

Operators who need physical isolation between tenants can run one Neo4j instance per tenant and create one `Neo4jStorageProvider` per URI — that is an operations choice, not a provider feature.

### Label scheme

| Node kind | Labels | Notes |
|-----------|--------|-------|
| Entity | `:_Entity` | Single umbrella label. The entity type lives in `n.entityType` (indexed). Per-type labels are deliberately **not** written — the steady-state per-call cost of interpolating a parameter into the label slot is not worth the query-convenience benefit. |
| Repository | `:_Repository` | One node per repository. |
| Vocabulary | `:_Vocabulary` | One node per repository; stores the vocabulary as a JSON string. |
| Vocabulary change log | `:_VocabularyChangeLog` | Append-only audit trail. |
| Schema meta | `:_Meta` | Singleton; carries `schemaVersion`. |

Relationship types in Cypher are the vocabulary relationship type slug, uppercased per Cypher convention (e.g. `:KNOWS`, `:REPORTS_TO`). Stored on `StoredRelationship.type` verbatim — the provider applies a deterministic case transform at the boundary.

### Property storage

| Data | Storage | Notes |
|------|---------|-------|
| Schema-managed scalars (`entityType`, `slug`, provenance fields, timestamps) | Native Neo4j properties on the node | Indexed where appropriate. Timestamps are ISO-8601 strings — the driver does not auto-convert `Date` ↔ string, so keeping strings avoids a conversion dance on every read/write. |
| User-supplied entity properties | **Both** native Neo4j scalars (one property per key) **and** a `properties` JSON string | Native scalars exist so `findEntities` predicates resolve to exact server-side equality checks. The JSON blob remains authoritative for round-trip fidelity — values Neo4j cannot represent natively (nested objects, `null`, heterogeneous arrays) preserve their shape via the blob but are **not** predicate-queryable. User keys are validated against the bare-Cypher-identifier shape and the reserved schema-field list on every write. |
| Embeddings | Native `list<float>` on the node (`embedding`) | Pass-through, no JSON encoding step. Excluded from read projections unless `loadEmbeddings: true`. |
| Vocabulary | Single JSON string on the `_Vocabulary` node | Cached in-process for 60 s (see [Vocabulary cache](#vocabulary-cache)). |

### Schema DDL

`ensureSchema()` runs the following statements idempotently. Composite indexes lead with `repositoryId` so the planner picks it as the cheap discriminator.

```cypher
CREATE CONSTRAINT dm_entity_unique IF NOT EXISTS
FOR (n:_Entity) REQUIRE (n.repositoryId, n.id) IS UNIQUE;

CREATE CONSTRAINT dm_entity_slug_unique IF NOT EXISTS
FOR (n:_Entity) REQUIRE (n.repositoryId, n.slug) IS UNIQUE;

CREATE CONSTRAINT dm_repository_unique IF NOT EXISTS
FOR (n:_Repository) REQUIRE n.repositoryId IS UNIQUE;

CREATE INDEX dm_entity_type_lookup IF NOT EXISTS
FOR (n:_Entity) ON (n.repositoryId, n.entityType);

CREATE INDEX dm_entity_modified IF NOT EXISTS
FOR (n:_Entity) ON (n.repositoryId, n.modifiedAt);

CREATE FULLTEXT INDEX dm_entity_text IF NOT EXISTS
FOR (n:_Entity) ON EACH [n.label, n.summary];
```

All constraints and indexes are supported on Neo4j Community Edition. No Enterprise-only features (property-existence, property-type, node-key, or relationship-key constraints, multi-database) are used.

To inspect the statements without connecting:

```typescript
import { getSchemaCypher, SCHEMA_VERSION } from '@utaba/deep-memory-storage-neo4j';

const statements = getSchemaCypher(); // string[]
```

### Vocabulary cache

`getVocabulary` reads through a 60-second in-process cache (per `repositoryId`). Vocabulary is compile-time context for graph traversal and changes rarely; the cache turns the hot path into zero round-trips. Cross-process staleness is bounded by the 60 s TTL; writes inside this process invalidate immediately.

## Search behaviour (`findEntities`)

Every filter shape resolves to an exact server-side predicate; `total` is always exact (no `total: undefined` escape hatch). The data and count queries share the same `WHERE` fragment by construction, so they count the same set.

| Filter shape | How it resolves |
|-------------|------------------|
| `entityTypes` | Predicate on `n.entityType`, backed by `dm_entity_type_lookup`. |
| `searchTerm` | Routes through `CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node, score WHERE node.repositoryId = $rid …`. Lucene query syntax flows through `$term`. |
| `query.properties` | Server-side exact `n.<key> = $val` against native-scalar copies of user properties. Non-storable filter values (nested objects, `null`, heterogeneous arrays) raise `ProviderError` at predicate-build time rather than silently missing matches. |
| `provenance.actors` | `(n.createdBy IN $actors OR n.modifiedBy IN $actors)`. |
| `provenance.conversationIds` | `(n.createdInConversation IN $convIds OR n.modifiedInConversation IN $convIds)`. |
| `provenance.dateRange` | ISO-8601 string comparison on `createdAt` / `modifiedAt` — chronologically correct because the canonical Z-suffixed format compares lexicographically. |

### Fulltext vs `CONTAINS`

The search branch ships the fulltext-index path only — no `WHERE … CONTAINS` fallback. Measured behaviour on `neo4j:5-community`:

- At ~1k entities, `CONTAINS` keeps up to within ~0.7 ms.
- At 10k entities the fulltext path is uniformly 3–6× faster (the gap widens with cohort size because `CONTAINS` is O(N) in entities while fulltext is O(matches)).

A dual-path branch was rejected — the small win at 1k disappears as cohorts grow and the extra code surface is not worth carrying.

Note that fulltext is token-based (Lucene). Sub-token matches like `alph` matching `alpha` would work under `CONTAINS` but **not** under tokenised fulltext. This is by design — the schema's intent is term-based search.

## Graph traversal capabilities

`Neo4jStorageProvider` implements `GraphTraversalProvider` and reports:

| Capability | Value |
|-----------|-------|
| `supportsNativeQuery` | `true` |
| `nativeQueryLanguage` | `'cypher'` |
| `maxTraversalDepth` | `10` |
| `supportsRelationshipPropertyFilters` | `true` |
| `supportsEntityPropertyFilters` | `true` |
| `supportsAggregation` | `true` |
| `supportsRepeat` | `true` |
| `supportsDedup` | `true` |
| `supportsRelationshipSummary` | `false` |

`traverse`, `exploreNeighborhood`, and `findPaths` are all compiled via the shared `CypherCompiler` and submitted as native Cypher. `findPaths` resolves in a single Bolt round-trip via `MATCH p = (s)-[*1..N]-(t)`; edge-uniqueness inside each returned path is automatic in Cypher 25 (default `DIFFERENT RELATIONSHIPS` match mode), so no application-side dedup filter is needed.

`QueryMetadata.resourceCost` is populated on every traversal result as `{ units: 'server_ms', value }` — the server-side time the database spent producing the result. With `profileTraversals: true` the result's `details.profile` also carries the `PROFILE` plan summary.

## Bulk operations

`exportAll()` returns an async iterable of chunks (batches of 100), entities first then relationships. Pagination is cursor-based (`WHERE n.id > $cursor ORDER BY n.id LIMIT $batchSize`) rather than `SKIP`/`LIMIT`, so reads stay O(n) instead of O(n²) on large repositories. Embeddings are included in export projections for round-trip fidelity.

```typescript
for await (const chunk of provider.exportAll(repositoryId)) {
  // chunk.type: 'entities' | 'relationships'
  // chunk.data: StoredEntity[] | StoredRelationship[]
  // chunk.isLast: boolean
}
```

`importBulk()` uses fixed-shape `UNWIND` templates — one Cypher string per chunk regardless of contents — so the plan cache stays at a single entry per import. Default chunk size is 100; concurrency is a simple bounded pool (default 8) — Neo4j Community has no per-query cost limit, so there is no adaptive controller. Use `skipExistenceCheck: true` when the caller knows the data is fresh (faster `CREATE` path); leave it `false` for idempotent `MERGE`-based upsert.

## Native query escape hatch

`executeNativeQuery(repositoryId, cypher, params)` runs a raw Cypher statement through the provider's connection. This bypasses the repository-scoping discipline that the rest of the provider enforces — the caller is fully responsible for scoping the query themselves.

**Do not expose this method to AI-agent-facing surfaces.** It exists for admin tooling and migration scripts only; the MCP server intentionally does not surface it.

## Error handling

All errors use the `@utaba/deep-memory` error hierarchy. Mapping is by `error.code`:

| Driver code | Maps to |
|-------------|---------|
| `Neo.ClientError.Schema.ConstraintValidationFailed` (entity scope) | `DuplicateEntityError` |
| `Neo.ClientError.Schema.ConstraintValidationFailed` (relationship scope) | `DuplicateRelationshipError` |
| `Neo.ClientError.Schema.ConstraintValidationFailed` (repository scope) | `DuplicateRepositoryError` |
| `Neo.ClientError.Statement.SyntaxError` | `ProviderError` |
| `Neo.ClientError.Security.*` | `ProviderError` (original code attached) |
| Anything else | `ProviderError` with `cause: error` |

"Not found" outcomes (`EntityNotFoundError`, `RelationshipNotFoundError`, `RepositoryNotFoundError`) come from inspecting the result summary's counters — they are not driver errors.

Transient errors are retried automatically by `driver.executeQuery` and `session.executeWrite/Read`; the provider does not check `error.isRetryable()` itself on those code paths.

When `summary.gqlStatusObjects` carries a non-`INFORMATION` notification (missing index, cartesian product, deprecation), the connection emits a single `console.warn` with the truncated query text and the notification list. The sink record's `details` does not carry the full notification array — keeps the sink shape bounded.

## Usage tracking

When `reportUsage` is supplied, the provider emits one `OperationUsage` record per public method call:

```typescript
{
  provider: 'neo4j',
  operation: 'findEntities',
  unit: 'server_ms',
  value: 12,                // sum of summary.resultConsumedAfter across all round-trips
  repositoryId: 'my-repo',
  timestamp: new Date(),
  details: {
    calls: 2,               // round-trips inside the operation
    retries: 0,
    recordCount: 47,
    counters: { … },        // aggregated nodesCreated, relationshipsCreated, etc.
    availableAfterMs: 8,
    profile: { … },         // present only when profileTraversals: true
  },
}
```

`server_ms` is the Neo4j-native equivalent of CosmosDB's RU — it is the time the server spent producing the result. See [docs/usage-tracking.md](../../docs/usage-tracking.md) for how to wire a sink for billing, rate limiting, or observability.

## Local development setup

The repo ships a `docker-compose.neo4j.yml` at its root:

```bash
docker compose -f docker-compose.neo4j.yml up -d
```

This starts `neo4j:5.26-community` with:

- Bolt on `7687`
- Browser UI on `http://localhost:7474`
- Credentials: `neo4j` / `DeepMem-Dev-1234`
- APOC plugin installed (not used by the provider, but useful for ad-hoc admin work)

The default password is for local development only — change it before exposing the instance to anything other than localhost.

## AuraDB / production deployment

The `neo4j+s://` URI scheme works against AuraDB out of the box:

```typescript
const provider = new Neo4jStorageProvider({
  uri: 'neo4j+s://<dbid>.databases.neo4j.io',
  username: 'neo4j',
  password: process.env.NEO4J_PASSWORD!,
  database: 'neo4j',
});
```

AuraDB-specific test coverage (cert pinning, IAM-style auth) is deferred — file an issue if you need it.

## Differences from the CosmosDB provider

Operators familiar with `@utaba/deep-memory-storage-cosmosdb` should know the following are intentional:

| Topic | CosmosDB provider | Neo4j provider | Why the difference |
|-------|-------------------|----------------|---------------------|
| Multi-tenant isolation | One CosmosDB partition per repository | `repositoryId` property on every node/edge with a connection-layer chokepoint | Neo4j has no partition model. Property-scoping with composite indexes is the idiomatic Cypher approach; a root-`(:_Repository)-[:CONTAINS]->(:_Entity)` pattern would create supernodes (an anti-pattern). |
| Repository listing | Sentinel `_repository_index` vertex in `_index` partition | Direct `MATCH (r:_Repository) RETURN r` | No partition fan-out cost to amortise — the sentinel exists in Cosmos *because of* its cost model. |
| `findEntities` totals | `total: number \| undefined` depending on filter shape | Always exact `total: number` | Cypher's `count(n)` runs as a parallel server-side aggregation against the same `WHERE` fragment. |
| Search backend | Slug-based `TextP.containing()` | Fulltext index via `db.index.fulltext.queryNodes` | Neo4j has a first-class fulltext index; Cosmos's Gremlin subset does not. |
| `getRepositoryStats` | Gremlin `.group().by(label).by(count())` per metric | Native Cypher `count()` aggregation | Cypher's aggregation is direct; Gremlin's path is gymnastic. |
| Bulk import concurrency | Adaptive controller that dials down on 429s | Fixed bounded pool (default 8) | Neo4j has no per-query cost limit and no equivalent throttle signal — adaptation has nothing to react to. |
| Usage unit | `RU` | `server_ms` | The Neo4j-native cost-adjacent signal is `summary.resultConsumedAfter`. |
| `findPaths` | Application-level BFS / Gremlin `repeat().emit()` | Single `MATCH p = (s)-[*1..N]-(t)` | Cypher's variable-length pattern resolves in one round-trip; edge-uniqueness within a path is automatic in Cypher 25. |
| Greedy-expand on traverse pages | Required (Gremlin streams nodes and edges into a single deduped stream that `.range()` slices by element) | Not needed | Cypher's `MATCH` binds endpoints to relationships at MATCH time and `LIMIT` slices whole rows, so an endpoint can never fall outside a page without its row going with it. |

The two providers share the same `StorageProvider` / `GraphTraversalProvider` contract — application code is portable between them.

## Testing

The conformance suite is gated on `NEO4J_URI`:

```bash
NEO4J_URI=bolt://localhost:7687 \
NEO4J_USERNAME=neo4j \
NEO4J_PASSWORD=DeepMem-Dev-1234 \
  pnpm --filter @utaba/deep-memory-storage-neo4j test
```

Without `NEO4J_URI`, the live tests are skipped. The pure-unit tests (mapping, schema snapshot, isolation chokepoint guards) always run.

## Licensing

| Component | License | Notes |
|-----------|---------|-------|
| `@utaba/deep-memory-storage-neo4j` (this package) | **Apache-2.0** | Same as the rest of the monorepo. |
| `neo4j-driver` (npm runtime dependency) | **Apache-2.0** | TypeScript types bundled in the package — no separate `@types/neo4j-driver` needed. |
| `neo4j:5-community` (Docker image referenced for local dev) | **GPLv3** (binary) | The Dockerfile scripts are Apache-2.0; the binary itself is GPLv3. |

This package speaks to Neo4j over the Bolt protocol — that is mere aggregation, the same model that has allowed GPLv2/v3 database clients to ship inside non-GPL applications for the last twenty years. Your application linking this package does **not** bring GPL obligations.

If you bundle or redistribute the Neo4j binary inside your own distribution, GPLv3 obligations on the binary attach to *your* distribution, not to this package. We **do not** depend on or reference Neo4j Enterprise (no `-enterprise` tags, no Enterprise-only features such as property-existence / property-type / node-key / relationship-key constraints, multi-database, or fine-grained role auth).

## Exports

```typescript
import {
  Neo4jStorageProvider,
  getSchemaCypher,
  SCHEMA_VERSION,
} from '@utaba/deep-memory-storage-neo4j';

import type { Neo4jStorageProviderConfig } from '@utaba/deep-memory-storage-neo4j';
```

## See also

- [Architecture](../../docs/architecture.md) — Component architecture and provider interface contracts.
- [Usage tracking](../../docs/usage-tracking.md) — Wiring a `UsageSink` for billing, rate limiting, or observability.
- [CosmosDB Storage Provider](../storage-cosmosdb/README.md) — The dual-interface graph-native provider this one most closely parallels.
- [SQL Server Storage Provider](../storage-sqlserver/README.md) — The relational alternative when a graph database is not available.
