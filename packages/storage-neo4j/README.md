# @utaba/deep-memory-storage-neo4j

Neo4j storage provider for [`@utaba/deep-memory`](https://www.npmjs.com/package/@utaba/deep-memory). Implements both `StorageProvider` and `GraphTraversalProvider` against Neo4j Community Edition over Bolt — a single instance gives deep-memory persistent storage **and** native Cypher graph queries.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-storage-neo4j
```

**Runtime dependency:** [`neo4j-driver`](https://www.npmjs.com/package/neo4j-driver) (the official Neo4j JavaScript driver, Apache-2.0, types bundled).

**Server requirement:** Neo4j **5.24 or later**. Traversal and relationship-read statements use `OPTIONAL CALL`, which earlier servers reject.

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
| `maxTransactionRetryTime` | `number` | driver default (30 s) | Maximum time (ms) the driver keeps retrying a managed transaction on transient errors. It only bounds how long retries run. Creates, deletes by id and insert imports answer correctly when retried (see [Error handling](#error-handling)), so there is no need to set it to `0`, which does not turn retry off anyway. |
| `reportUsage` | `UsageSink` | `undefined` | Optional sink invoked once per public method call with the server-side time (ms) consumed. See [Usage tracking](#usage-tracking). |
| `profileTraversals` | `boolean` | `false` | When `true`, prepends `PROFILE` to compiled traversal queries and surfaces the plan summary on the sink record. `PROFILE` more than doubles wall-clock on short traversals — turn it on only when actively investigating planner behaviour. |
| `searchScoring` | `'relevance' \| 'isolated'` | `'relevance'` | How `findEntities` orders the hits of a `searchTerm` query. `'relevance'` orders by full-text score; `'isolated'` orders by `label`, then `id`, so no statistic computed from other repositories reaches the order. See [Search ordering and tenant isolation](#search-ordering-and-tenant-isolation). |

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

`ensureSchema()` runs constraint and index DDL idempotently against the configured database and writes a `_Meta` schema-version handshake. Subsequent calls skip the DDL when the schema version is current. Every call also repairs the `version` property on `_Vocabulary` nodes: it adds the property where it is missing and corrects it where it no longer matches the version in the JSON blob. Compare-and-set in `saveVocabulary` depends on that property (see [Vocabulary writes](#vocabulary-writes)). It does **not** create the database itself — Neo4j Community Edition has a single user database; the operator is responsible for the target database existing before the provider connects.

## Data Model

### Multi-tenancy via `repositoryId`

Neo4j Community Edition has a single user database, so multiple repositories share one Neo4j database and are isolated by a `repositoryId` property on every node and edge. **Every Cypher statement** issued by this provider — apart from a small allowlist of system queries (`ensureSchema`, `listRepositories`, `_Meta` reads) — carries a required `$rid` parameter and references it in a predicate. The `Neo4jConnection` chokepoint enforces this at runtime: a Cypher string that omits `$rid` raises `ProviderError`, and no other file in the package is allowed to touch the driver directly.

Operators who need physical isolation between tenants can run one Neo4j instance per tenant and create one `Neo4jStorageProvider` per URI — that is an operations choice, not a provider feature.

Repository-scoped statements are planned so that their cost grows with the repository, not with the database. Lookups and deletes by relationship id (`getRelationship`, `deleteRelationship`, `deleteRelationships`), `deleteRelationshipsByType`, `findEntities` without a search term, `getEntityRelationships`, the `getRepositoryStats` counts and the batched drains of `deleteRepository` / `deleteAllContents` anchor on the repository's entities through an entity index, usually with `(e:_Entity {repositoryId: $rid}) WHERE e.id IS NOT NULL` (the relationship drain uses a range on `e.id` instead, as a keyset cursor that visits each entity once; `getEntityRelationships` seeks its entity by id; a filtered `findEntities` may seek another `(repositoryId, …)` entity index): the id predicate lets the planner seek the `(repositoryId, id)` unique index, where a bare `repositoryId` anchor would scan every `_Entity` in the database and an unanchored relationship pattern would scan every relationship. `Neo4jStorageProvider.queryPlans.test.ts` checks these plans with `EXPLAIN`.

The exceptions, whose cost grows with the database:

- **Full-text matching.** The `dm_entity_text` index covers every repository; see [Search ordering and tenant isolation](#search-ordering-and-tenant-isolation).
- **Vocabulary reads.** `_Vocabulary` and `_VocabularyChangeLog` have no index on `repositoryId`, so a `getVocabulary` cache miss scans the `_Vocabulary` label (one node per repository) and `getVocabularyChangeLog` scans the `_VocabularyChangeLog` label across every repository.
- **The `_VocabularyChangeLog` drain** in `deleteRepository`, a scan of that label across every repository.
- **The untyped-node sweep** in `deleteRepository`, which removes nodes with any label carrying the `repositoryId` (written through `executeNativeQuery`) and has no label to seek on, so each of its batches scans every node in the database. It runs once per delete, after the labelled drains.

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

`getVocabulary` reads through a 60-second in-process cache (per `repositoryId`). Vocabulary is compile-time context for graph traversal and changes rarely; the cache turns the hot path into zero round-trips. Cross-process staleness is bounded by the 60 s TTL. Writes inside this process invalidate the entry immediately, and so does a version conflict. `getVocabulary(id, { fresh: true })` skips the cache, reads the node (one round-trip) and replaces the cache entry with the result.

### Vocabulary writes

The vocabulary version is stored twice: inside the JSON blob and as a `version` property on the `_Vocabulary` node, so the database can compare it. `saveVocabulary(id, vocabulary, expectedVersion)` is compare-and-set. It takes the node's write lock before it checks the version, so two concurrent writers against the same base version cannot both land. A mismatch throws `VocabularyVersionConflictError`. `saveVocabulary` never creates the node, because `createRepository` writes it together with the `_Repository` node. When neither exists, it throws `RepositoryNotFoundError`. A node with a missing or stale `version` property throws `ProviderError`, and the message says to run `ensureSchema()`.

### Repository delete

`deleteRepository` deletes the `_Repository` marker first. Every create statement — `createEntity`, `createRelationship` and each `importBulk` chunk — write-locks the marker in the same statement as its write, then matches it again and writes only while it still exists. Deleting the marker takes the same lock, so a delete waits for a create that holds it, and its drain then removes what that create wrote; a create that waited on the delete finds the marker gone and fails with `RepositoryNotFoundError`. No create commits after the drain has passed it, so nothing outlives the repository. The delete then drains relationships, entities, the change log and any other node carrying the `repositoryId`, each in batches of its own transaction. The `_Vocabulary` node goes last. The relationship drain, the anchored relationship get/delete and `deleteRelationshipsByType` reach an edge from its source, one of the repository's `_Entity` nodes; an edge written through `executeNativeQuery` whose source is not one of them is not reached by those statements, and is removed only when its source node is (by the entity drain or the untyped-node sweep, if that node carries the `repositoryId`). Nothing counts the repository before the delete starts, because a whole-repository read could outlast the server's transaction timeout and then fail every retry the same way. The progress callback reports the running counts of entities and relationships removed so far (no totals), and `deleteRepository` / `deleteAllContents` return the counts removed. A delete that is interrupted part-way can be finished by calling `deleteRepository` again. It throws `RepositoryNotFoundError` only when nothing at all was left to delete. `deleteAllContents` reads the marker first (a seek of its unique constraint index) and throws `RepositoryNotFoundError` when there is none. While a delete is unfinished (a `_Vocabulary` node or `_Entity` nodes remain with no marker), `createRepository` refuses with a `ProviderError` that tells you to finish the delete first.

Once the marker is gone, every repository-scoped call throws `RepositoryNotFoundError`, even while an interrupted delete has left data behind: reads, writes, type deletes, `getTimeline`, `getVocabularyChangeLog`, `exportAll`, `importBulk` and the traversals (`traverse`, `exploreNeighborhood`, `findPaths`). Each checks the marker before any per-id or empty-result answer, in the same statement where it can. A traversal checks it whatever the vocabulary cache holds, and the refusal drops the cached vocabulary. The only call that can still answer is a `getVocabulary` served from the cache within its TTL.

### Upgrading

After upgrading this package, run `ensureSchema()` once, after **every** process that writes to the database has moved to the new release. This repairs the `version` property on vocabularies written by earlier releases. The local MCP server runs `ensureSchema()` at startup, and the indexer runs it before each import. Running old and new releases against one database at the same time is unsupported, because an older release rewrites the vocabulary blob without updating the `version` property.

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

### Search ordering and tenant isolation

`dm_entity_text` is one full-text index over every `_Entity` in the database. A search queries it and then keeps only the caller's repository, so the hits and `total` are always the repository's own. Two things still depend on the rest of the database:

- **Order, under `searchScoring: 'relevance'` (the default).** The Lucene score's term statistics (how common a word is) are computed over the whole index, so the order of one repository's hits can shift when another repository's data changes. In a store shared by several tenants, a tenant that controls its own data could probe, through its own result order, how common chosen words are in other tenants' data — frequencies, not content. Set `searchScoring: 'isolated'` to order hits by `label`, then `id`, instead; no score reaches the order, at the cost of relevance ranking. Single-tenant hosts can keep the default.
- **Cost, under either setting.** The index produces every match in the database before the repository filter applies, so a search in a small repository pays for matches in every other repository.

A database (or instance) per tenant is the full isolation option: it removes both effects.

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

`importBulk()` uses fixed-shape `UNWIND` templates — one Cypher string per chunk regardless of contents — so the plan cache stays at a single entry per import. Default chunk size is 500; chunks are dispatched through a simple bounded pool (default 8) — Neo4j Community has no per-query cost limit, so there is no adaptive controller. Each chunk write-locks the repository marker for the length of its statement (see [Repository delete](#repository-delete)), so the chunks of one repository's import — and any other create in that repository — run one at a time on the server; the pool overlaps round-trips, not writes. Imports into different repositories do not wait on each other.

Use `skipExistenceCheck: true` when the caller knows the data is fresh (faster path: no existence check against the store); leave it `false` for idempotent `MERGE`-based upsert. Relationship ids are unique across every type in a repository, and Neo4j relationship constraints cover one type only, so the two paths treat ids differently:

- **Insert** (`skipExistenceCheck: true`) trusts the caller that its relationship ids are not already in the store and does not look; checking every chunk against every edge in the repository would make a large import quadratic. An id repeated within the one call is refused: the first occurrence is attempted, and each later one is reported with `RELATIONSHIP_ALREADY_EXISTS` whatever the first occurrence's outcome.
- **Upsert** (`skipExistenceCheck: false`) checks each id against the repository's existing edges. An edge with the same id, type and endpoints is updated in place; one whose type or endpoints differ makes the row fail with `RELATIONSHIP_ALREADY_EXISTS`. The endpoints are checked before the id, because telling the same edge from another one needs the bound source and target, so a row with a missing endpoint reports `ENTITY_NOT_FOUND` even when its id is in use. An id repeated within one chunk is applied in input order. Occurrences in different chunks (a different type, or more than a chunk apart) are applied in no defined order, but each meets the others' writes, so the id never ends up on two edges.

`result.errors` is not in input order: entity rows come before relationship rows, and among relationships the repeats an insert refuses come before each chunk's failures, in chunk order. Each record's `item` names its row.

`createRelationship` checks a caller-supplied id the same way as upsert, and refuses any existing edge with `DuplicateRelationshipError`. The check seeks the repository's entities through the `(repositoryId, id)` index and then reads their edges, so its cost grows with the repository's relationship count, and it runs under the marker lock. When the engine minted the id (`createRelationship(rid, relationship, { idMinted: true })`, which `RelationshipManager` passes whenever the caller gave no id), the id is a random UUID and the check is skipped: the statement locks the marker, seeks the two endpoints and `MERGE`s the edge between them on its id and the call's write token, so its cost does not grow with the repository.

## Native query escape hatch

`executeNativeQuery(repositoryId, cypher, params)` runs a raw Cypher statement through the provider's connection. This bypasses the repository-scoping discipline that the rest of the provider enforces — the caller is fully responsible for scoping the query themselves.

The provider's relationship statements reach an edge from its source entity: `getRelationship`, `deleteRelationship`, `deleteRelationships` and the relationship drain of `deleteRepository` / `deleteAllContents` start at the repository's `_Entity` nodes. An edge created here whose source is not one of the repository's `_Entity` nodes is not seen by them, even if it carries the `repositoryId`; it is removed only with its source node (see [Repository delete](#repository-delete)).

**Do not expose this method to AI-agent-facing surfaces.** It exists for admin tooling and migration scripts only; the MCP server intentionally does not surface it.

## Error handling

All errors use the `@utaba/deep-memory` error hierarchy. Mapping is by `error.code`:

| Driver code | Maps to |
|-------------|---------|
| `Neo.ClientError.Schema.ConstraintValidationFailed` (entity scope) | `DuplicateEntityError` |
| `Neo.ClientError.Schema.ConstraintValidationFailed` (repository scope) | `DuplicateRepositoryError` |
| `Neo.ClientError.Statement.SyntaxError` | `ProviderError` |
| `Neo.ClientError.Security.*` | `ProviderError` (original code attached) |
| Anything else | `ProviderError` with `cause: error` |

`DuplicateRelationshipError` does not come from a driver constraint: Neo4j relationship constraints cover one type only, so relationship id uniqueness is checked by the create statement itself (`createRelationship`), and the import reports a clash as an `id-exists` row outcome (`RELATIONSHIP_ALREADY_EXISTS`).

"Not found" outcomes (`EntityNotFoundError`, `RelationshipNotFoundError`, `RepositoryNotFoundError`) come from the statement's own result (counters or a returned outcome) — they are not driver errors.

One driver code is a not-found outcome: `Neo.ClientError.Statement.EntityNotFound`, which a server may raise when a create statement waited on the repository marker's lock and the marker was deleted meanwhile. `createEntity` reports it as `RepositoryNotFoundError`. `createRelationship` can also meet a deleted endpoint (entity deletes do not take the marker lock), so it reads the marker and both endpoints once more and throws `RepositoryNotFoundError` or `EntityNotFoundError` for the first one missing — or the mapped original error when all three exist. `importBulk` re-runs a chunk refused this way row by row: each re-run reports a deleted endpoint as an `ENTITY_NOT_FOUND` row and a deleted marker as `RepositoryNotFoundError`, which stops the import. A row still refused on its own is recorded with `ENTITY_NOT_FOUND` once a read confirms the marker is still there; if the marker is gone, the import stops with `RepositoryNotFoundError`.

Transient errors are retried automatically by `driver.executeQuery` and `session.executeWrite/Read`; the provider does not check `error.isRetryable()` itself on those code paths.

Creates, deletes by id and insert imports are retry-safe. The driver re-runs a transaction after a retryable failure, including a failure on commit: when the connection drops after the server committed but before the client heard back, the re-run meets what the first run already wrote. The provider answers that case as the success it was:

- `createEntity`, `createRelationship` and `createRepository` write a per-call token (`_attempt`) on the record they create. When the re-run is refused (`DuplicateEntityError`, `SlugConflictError`, `DuplicateRepositoryError`, or the relationship id already in use), the provider reads the stored token back. This call's token means the create succeeded; any other token, or none, is a genuine duplicate and the error stands. A `createRelationship` with an engine-minted id `MERGE`s on the id and the token, so its re-run matches the edge the first run wrote and succeeds without a read-back.
- `deleteEntity`, `deleteEntities` and `deleteRelationships` run in a transaction function that knows its attempt number and remembers what earlier attempts deleted. An id an earlier attempt deleted and the re-run finds absent counts as deleted (`deleteEntity` succeeds rather than throwing `EntityNotFoundError`).
- `importBulk` with `skipExistenceCheck: true` writes a token per chunk statement. Relationships are MERGEd on their id together with that token, so a re-run, or the chunk's per-row fallback, matches the edge the first run wrote instead of writing it again; an edge written by any other call never matches. An entity chunk refused on re-run counts as imported when every row's id holds an entity with the chunk's token; otherwise its rows are written one at a time, each with its own token, and a row refused for its id or slug counts as imported when the stored entity carries its own token or the chunk's. A genuine duplicate is still reported with `ENTITY_ALREADY_EXISTS` or `SLUG_CONFLICT`, once per refused row: an entity id new to the repository and repeated N times within one call lands once and yields N-1 `ENTITY_ALREADY_EXISTS` errors.

`_attempt` is a reserved property: it cannot be used as an entity property key, typed reads never return it on entities, relationships or repositories, and a traversal that filters on or projects it is refused with `TraversalValidationError`. `executeNativeQuery` returns stored properties as they are, so a native query that returns whole nodes or relationships includes it. Records written by an upsert import (`skipExistenceCheck: false`) carry no token; upserts MERGE on the id and are safe to re-run as they are.

Other writes are retried the same way without a token, and a re-run of them leaves the store correct: `updateEntity` and `updateRepository` re-apply the same values, which is harmless. The one answer a re-run can change is a count: a re-run of a committed `deleteEntitiesByType` or `deleteRelationshipsByType` reports only what was left to delete.

`maxTransactionRetryTime` only bounds how long the driver keeps retrying. Setting it to `0` does not disable retry (the driver can still re-run once), and is not needed for correct write outcomes.

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

import type { Neo4jStorageProviderConfig, Neo4jSearchScoring } from '@utaba/deep-memory-storage-neo4j';
```

## See also

- [Architecture](../../docs/architecture.md) — Component architecture and provider interface contracts.
- [Usage tracking](../../docs/usage-tracking.md) — Wiring a `UsageSink` for billing, rate limiting, or observability.
- [CosmosDB Storage Provider](../storage-cosmosdb/README.md) — The dual-interface graph-native provider this one most closely parallels.
- [SQL Server Storage Provider](../storage-sqlserver/README.md) — The relational alternative when a graph database is not available.
