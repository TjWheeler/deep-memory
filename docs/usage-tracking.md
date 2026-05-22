# Usage Tracking

Provider-agnostic cost and consumption telemetry for `@utaba/deep-memory`. Every built-in provider (storage, embeddings, LLM) can emit one `OperationUsage` record per public API call to a caller-supplied sink. Use it for billing, rate limiting, SLA monitoring, or simple debugging.

Usage is opt-in per provider, delivered out-of-band to the calling process, and **never surfaced to AI agents** — the MCP servers deliberately do not plumb a sink through.

## The `OperationUsage` record

```typescript
import type { OperationUsage, UsageSink } from '@utaba/deep-memory';

interface OperationUsage {
  provider: string;           // 'cosmosdb' | 'sqlserver' | 'openai' | 'anthropic' | ...
  operation: string;          // 'createEntity' | 'findEntities' | 'embed' | ...
  unit: string;               // 'RU' | 'ms' | 'tokens'
  value: number;              // magnitude in the stated unit (always ≥ 0)
  repositoryId?: string;      // present for repository-scoped operations
  timestamp: Date;            // when the operation completed
  details?: Record<string, number>;  // provider-specific breakdown
}

type UsageSink = (usage: OperationUsage) => void;
```

The sink is a plain callback. Implement it however makes sense for your host — append to an array, push to a metrics system, increment a per-tenant counter, log to stderr.

## Hooking a sink

Every provider accepts an optional `reportUsage` field in its constructor config:

```typescript
import { CosmosDbProvider } from '@utaba/deep-memory-storage-cosmosdb';
import { SqlServerStorageProvider } from '@utaba/deep-memory-storage-sqlserver';
import { OpenAIEmbeddingProvider } from '@utaba/deep-memory-embeddings-openai';
import { AnthropicLLMProvider } from '@utaba/deep-memory-indexer-llm-anthropic';
import type { OperationUsage } from '@utaba/deep-memory';

const reportUsage = (u: OperationUsage) => {
  billing.record(u.repositoryId, u.provider, u.unit, u.value);
};

new CosmosDbProvider({ /* ... */, reportUsage });
new SqlServerStorageProvider({ /* ... */, reportUsage });
new OpenAIEmbeddingProvider({ /* ... */, reportUsage });
new AnthropicLLMProvider({ /* ... */, reportUsage });
```

If you don't supply a sink, the tracking path is a zero-overhead no-op — no accumulation, no allocation.

## Per-provider behaviour

Each provider emits the unit that maps best to its real cost model. They all share the same `OperationUsage` shape, so a single sink can handle them all.

### CosmosDB (`cosmosdb` / `RU`)

Every public `StorageProvider` + `GraphTraversalProvider` method emits one record. The provider wraps every internal Gremlin `submit()` call in an async-local accumulator so a single public call — even one that issues multiple underlying queries — produces exactly one record summing all request charges.

| Field | Value |
|---|---|
| `unit` | `'RU'` |
| `value` | Total request units consumed across all internal Gremlin queries |
| `repositoryId` | Present for all repository-scoped methods. Absent for `listRepositories`, `ensureSchema`, `executeNativeQuery` (cross-partition by design). |
| `details` | `{ calls: number, retries: number }` — count of Gremlin round-trips and transient-error retries |

**Nesting is flattened.** `traverse()` internally calls `getVocabulary()`, which also emits normally. When called from inside `traverse`, the inner call joins the outer scope instead of emitting separately — so one `traverse` call yields exactly one record, not two.

**Streaming `exportAll`** emits one aggregated record when the consumer finishes iterating (or breaks early), covering all chunks produced.

### SQL Server (`sqlserver` / `ms`)

The provider wraps itself in a `Proxy` that measures wall-clock time around every tracked public method.

| Field | Value |
|---|---|
| `unit` | `'ms'` |
| `value` | Wall-clock duration of the public method in milliseconds |
| `repositoryId` | Present for all repository-scoped methods. Absent for `listRepositories` and `ensureSchema`. |
| `details` | Not populated |

**Important:** `ms` is *wall-clock*, not SQL Server's internal execution time. It includes connection-pool wait, network round-trip, query execution, and result deserialization. It is a good proxy for rate limiting and SLA monitoring; it is **not** dollar-accurate billing. For accurate SQL cost metrics you would need server-side stats (`SET STATISTICS TIME`, `sys.dm_exec_query_stats`, Azure SQL DTU telemetry) — not currently exposed.

**Fires on failure.** If the underlying method throws, the record still emits (with the elapsed time up to the throw), then the error is re-raised. You will see failed calls in your usage stream — useful for spotting attack patterns or broken clients.

**Not tracked:** `initialize`, `dispose`, `exportAll`. Lifecycle methods are not billable; `exportAll` returns an `AsyncIterable` and isn't wrapped.

### OpenAI-compatible embeddings (`openai` / `tokens`)

Emits one record per public method call. `embedBatch` chunks large inputs into multiple HTTP requests internally; all chunks roll up into a single record.

| Field | Value |
|---|---|
| `unit` | `'tokens'` |
| `value` | `usage.total_tokens` summed across all HTTP calls |
| `repositoryId` | Not populated — the embeddings provider operates outside any single repository context |
| `details` | `{ promptTokens: number, totalTokens: number, calls: number }` — `calls` is the number of HTTP requests |

If the endpoint does not return a `usage` block, the record is not emitted.

### Anthropic LLM (`anthropic` / `tokens`)

Emits one record per `chatCompletion` or `chatCompletionWithTools` call, covering a single turn.

| Field | Value |
|---|---|
| `unit` | `'tokens'` |
| `value` | Sum of `inputTokens + outputTokens + cacheReadTokens + cacheCreationTokens` |
| `repositoryId` | Not populated |
| `details` | `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` |

The detail breakdown lets you compute dollar cost precisely with your own model pricing (cached input tokens bill at ~10% of uncached input tokens on Claude).

## What the MCP servers do

Neither the core MCP server (`@utaba/deep-memory-local-mcp-server`) nor the indexer MCP server (`@utaba/deep-memory-indexer-mcp-server`) configures a sink when constructing providers. Usage tracking is **never** active on the MCP path, so records cannot leak into tool responses visible to the LLM.

If you want to observe usage while exercising the MCP servers — e.g. to profile a real indexing run — fork or wrap the server to pass your own `reportUsage` at provider-construction time. The public MCP response format has no field for usage data, so even an instrumented MCP build could not surface it to the model.

## Isolation and safety guarantees

**A throwing sink never breaks the underlying operation.** Every provider wraps the caller-supplied sink with `createSafeSink` (from `@utaba/deep-memory`), which swallows sink errors silently. A buggy billing collector will lose records but will not abort storage or API calls.

**Nested calls don't double-count.** Providers that issue internal sub-operations (CosmosDB `traverse` → `getVocabulary`) detect the active usage scope and join it rather than emitting a second record. One user-visible call = one record.

**Failures still emit.** If a tracked method throws, the usage record is still delivered before the error propagates. You will see failed operations in your stream with non-zero values (they consumed time, tokens, or RUs before failing).

**No buffering, no batching.** Records are delivered synchronously on the same call stack that produced them (on the microtask that resolves the returned promise). If your sink needs batching, do it in your own implementation.

## Common patterns

### Per-tenant billing

```typescript
const billing = new Map<string, { ru: number; ms: number; tokens: number }>();

const reportUsage = (u: OperationUsage) => {
  if (!u.repositoryId) return;  // Only bill repository-scoped calls
  const acc = billing.get(u.repositoryId) ?? { ru: 0, ms: 0, tokens: 0 };
  if (u.unit === 'RU')     acc.ru     += u.value;
  if (u.unit === 'ms')     acc.ms     += u.value;
  if (u.unit === 'tokens') acc.tokens += u.value;
  billing.set(u.repositoryId, acc);
};
```

### Rate limiting

```typescript
const windowMs = 60_000;
const limits = new Map<string, number[]>();  // repositoryId → recent timestamps

const reportUsage = (u: OperationUsage) => {
  if (!u.repositoryId) return;
  const now = Date.now();
  const window = (limits.get(u.repositoryId) ?? []).filter(t => now - t < windowMs);
  window.push(now);
  limits.set(u.repositoryId, window);
  if (window.length > 100) {
    abuseDetector.flag(u.repositoryId, 'high-call-rate');
  }
};
```

### Cost observability

```typescript
const reportUsage = (u: OperationUsage) => {
  metrics.increment(`deepmemory.${u.provider}.${u.operation}`, 1);
  metrics.distribution(`deepmemory.${u.provider}.${u.unit}`, u.value, {
    operation: u.operation,
    repositoryId: u.repositoryId ?? 'unscoped',
  });
};
```

### Debug logging (development only)

```typescript
const reportUsage = (u: OperationUsage) => {
  process.stderr.write(
    `[usage] ${u.provider}.${u.operation} = ${u.value}${u.unit}` +
    (u.repositoryId ? ` (repo=${u.repositoryId})` : '') +
    '\n'
  );
};
```

## Limitations

- **SQL Server wall-clock is not billable DB time.** Use it for rate limiting; use server-side stats for billing.
- **`executeNativeQuery` on CosmosDB is unscoped.** It emits with `repositoryId: undefined` because the query is not partition-bound. Treat it as administrative cost, not tenant cost.
- **In-memory providers don't emit.** `InMemoryStorageProvider`, `InMemorySearchProvider`, and `NoOpEmbeddingProvider` have no cost model and no sink hook.
- **Streaming iterables emit on completion.** `exportAll` on CosmosDB aggregates until the consumer finishes iterating — large exports will see a single large record, not progressive records. If progressive reporting matters, consume in chunks with fresh provider instances.
- **Records are not persisted.** The library never stores usage records. Persistence, retention, and aggregation are entirely the caller's concern.

## Adding usage tracking to a custom provider

If you implement your own `StorageProvider`, `EmbeddingProvider`, or indexer `LLMProvider`:

1. Accept `reportUsage?: UsageSink` in your config interface.
2. Wrap it at construction time: `this.reportUsage = createSafeSink(config.reportUsage)` (imported from `@utaba/deep-memory`).
3. Invoke it exactly once per public method call, on both success and failure paths, with `provider` set to your stable provider identifier.
4. Populate `repositoryId` from the method argument when the operation is repository-scoped.
5. Use `details` for any breakdown that would help callers explain or debug the `value`.

The `createSafeSink` helper returns `undefined` if the input is `undefined`, letting you cheaply skip emission in the common no-sink case.
