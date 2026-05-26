# CosmosDB Gremlin — Compatibility & Performance Notes

CosmosDB's Gremlin implementation is a **subset** of Apache TinkerPop. Queries that work against TinkerPop reference servers (e.g. a local `tinkergraph-test`) can silently drop rows, throw runtime errors, or have surprising performance against CosmosDB. This document is the project's reference for what we've empirically verified works (and doesn't work) in CosmosDB's subset, plus the performance-critical operator differences.

**How to use this doc:** before changing emitted Gremlin in `GremlinCompiler.ts` or `packages/storage-cosmosdb/src/queries/`, scan the relevant section here. Before assuming a TinkerPop pattern works, **probe it live against the emulator first** — see [§Probing methodology](#probing-methodology).

**How to add findings:** when you live-validate a new shape (works or doesn't), append it to the appropriate section with a one-line provenance note (the date and, if useful, the probe script). Keep entries scannable.

---

## Probing methodology

The MCP server's `traverse` tool goes through `GremlinCompiler` — useful for confirming the *current* compiler output, but circular when validating *new* shapes. To probe raw Gremlin against the emulator, write a small Node script that uses the `gremlin` driver directly. Reference template:

```js
import gremlin from '<path>/node_modules/gremlin/index.js';

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const auth = new gremlin.driver.auth.PlainTextSaslAuthenticator(
  `/dbs/${DATABASE}/colls/${CONTAINER}`,
  KEY,
);
const client = new gremlin.driver.Client(ENDPOINT, {
  authenticator: auth,
  traversalsource: 'g',
  rejectUnauthorized: false,
  mimeType: 'application/vnd.gremlin-v2.0+json',
});
await client.open();

const result = await client.submit(query, bindings);
const items = Array.from(result);
// inspect items, errors, RU (result.attributes['x-ms-total-request-charge'])

await client.close();
```

Discard the probe after the finding is recorded here; the doc is the durable artifact.

---

## Confirmed-working operators and patterns

Verified either by live probe (cited below) or by being in production code that successfully runs in the CosmosDB emulator + Azure.

### Traversal navigation

| Operator | Notes |
|---|---|
| `g.V().has('repositoryId', x)` | Partition-scoped vertex start. `repositoryId` is the partition key; this predicate routes the query to a single physical partition. |
| `g.V().hasId(x)` | Direct doc fetch by system id. Cheaper than `has('id', x)` (property-equality lookup). Always pair with the partition predicate. |
| `g.V().hasId(within(x, y, z))` | Batch doc fetch by system id. Live-validated 2026-05-25 against vertices and edges. Same semantics as `has('id', within(...))` but routes via the doc-id index rather than the property index. |
| `g.E().hasId(x)` | Edge variant of the above. Works in the emulator (live-validated 2026-05-25). Without a partition predicate, the engine still fans out — pair with `has('repositoryId', rid)` for partition-scoped routing where the source vertex id is not known. |
| `g.V().has('id', x)` | Property-equality lookup on `id`. Works but slower than `hasId`. See [§Performance](#performance-critical-operator-differences). |
| `out(t)`, `in(t)`, `both(t)` | Simple vertex-to-vertex steps. Type args are optional. |
| `outE(t)`, `inE(t)`, `bothE(t)` | Edge-explicit steps. |
| `inV()`, `outV()`, `otherV()` | Edge-to-vertex hops. `otherV()` returns the vertex on the opposite end of the edge from the prior vertex. |
| `hasLabel('X')`, `has('label', 'X')` | Label filtering. Both forms work; `hasLabel` is the idiom. |
| `hasNot(key)`, `has(key)` | Property absence / presence filter. Used by the `isNull` / `isNotNull` operators in `compilePropertyFilter`. |

### Projection and value retrieval

| Operator | Notes |
|---|---|
| `valueMap(true)` | Multi-cardinality property map including `id` and `label`. Property values are array-wrapped (e.g. `entityType: ["Person"]`). Ships **all** properties on the vertex/edge including large blobs like `embedding`. **High RU cost.** Prefer explicit `project()` chains for read paths. |
| `valueMap('f1', 'f2', ...)` | Restricted-key valueMap. Lower cost. Used in `getTimeline`. |
| `values('field')` | Returns the value(s) of a single property. Used in `getRepositoryStats` to fetch the vocabulary JSON. |
| `project('k1','k2',...).by(...).by(...)` | Explicit projection — keys are arg list, values come from sequential `by()` modulators in order. **The right tool for projecting only the fields you actually consume.** Live-validated 2026-05-25. |
| `.by(id)` | Use `id` as the by-modulator argument to extract the system id. `id` is a Gremlin **token**, not a string — `by(id)` works, `by('id')` does not (the latter is a property-name lookup). |
| `.by('propertyName')` | Property-value as by-modulator. Required properties only — see [§Constraints](#constraints--patterns-that-fail) for the optional-field case. |
| `.by(constant(literal))` | Literal value as by-modulator. Used to inject discriminator fields like `__kind: 'v'`/`'e'`. |
| `.by(coalesce(values('foo'), constant(default)))` | Missing-field-safe property read. Required for optional properties. Live-validated 2026-05-25. |
| `path()` | Collects every traversed object (vertices and edges in walk order) into a Path object. |
| `path().by(<vertexProject>).by(<edgeProject>)` | Two-by **round-robin** on a mixed vertex+edge path: by-1 applies to vertices, by-2 to edges, alternating in path order. **Verified working.** Live-validated 2026-05-25 — single-by across mixed objects crashes; this is the working alternative. |

### Pagination and counting

| Operator | Notes |
|---|---|
| `range(start, end)` | Pagination. `start` inclusive, `end` exclusive. Works on every query type tested. |
| `limit(n)` | Hard cap. |
| `count()` | Terminal step. Works but RU-charged per matched row; for `hasMore` detection prefer the `range(offset, offset+limit+1)` trick (see [Performance issue #8](../plans/performance-issues.md)). |

### Deduplication

| Operator | Notes |
|---|---|
| `dedup()` | Dedup by object identity. Works on vertices and edges. |
| `dedup().by(select('id'))` | Dedup on a projected-map field. **Required form** when the upstream stream is `project(...)` output, because the items are Maps, not vertices. Live-validated 2026-05-25 — `dedup().by('id')` on projected maps **does not work** (see [§Constraints](#constraints--patterns-that-fail)). |

### Predicates (within `.has(key, pred)`)

| Predicate | Notes |
|---|---|
| `eq(v)`, `neq(v)` | Implicit equality is the bare form `has(key, value)`. |
| `gt`, `gte`, `lt`, `lte` | Numeric / lexicographic comparisons. Used in `compilePropertyFilter`. |
| `within(v1, v2, ...)` | Set membership. Used in batched id lookups (`getEntities`). |

### Set algebra and branching

| Operator | Notes |
|---|---|
| `union(__.<branch1>, __.<branch2>, ...)` | Set union of branch outputs. Each branch must be an **anonymous traversal** prefixed with `__.` — a leading-dot chain off the receiver inside `union(...)` is a syntax error. |
| `coalesce(<traversal>, <fallback>)` | First-non-empty. Used at both the by-modulator level (for missing-field defaults) and the query level (for upsert via `fold().coalesce(unfold(), addV(...))`). |
| `fold()` | Collapses a stream to a single list-valued traverser. Idiom for upsert: `g.V().has(...).fold().coalesce(unfold()..., addV(...)...)`. |
| `unfold()` | Inverse of `fold()` — emits each list element as a separate traverser. |
| `choose(<predicateTraversal>, <true-branch>, <false-branch>)` | Conditional execution. **Verified working** — live-validated 2026-05-26. Used for the "fixed-shape property ladder" pattern: `.choose(__.constant(vN).is(neq(absentSentinel)), __.property('key', vN), __.identity())` skips a `.property(...)` write at runtime when the binding equals the sentinel. All three sub-traversals must be anonymous (`__.` prefix). Composes inside `addV().property(...).choose(...)` chains and survives across the `fold().coalesce(unfold()..., addV()...)` upsert shape. |

### Repeat / variable-depth

| Operator | Notes |
|---|---|
| `repeat(<traversal>).times(n)` | Bounded repeat. |
| `repeat(<traversal>).until(<pred>)` | Conditional termination. |
| `repeat(...).emit()` | Emit intermediate frontiers (`emit()` before `repeat` for intermediates, after for terminal-only). |
| `simplePath()` | Cycle prevention via no-repeat-vertex. **Verified working** — live-validated 2026-05-25. Placed **before** `.path()` so it filters traversers (not the collected Path objects). Composes cleanly with `.path().by(...).by(...)` two-by projection — the projection runs after the filter. Confirmed at depth 1 and depth 2; cycle-rejecting walks reduce the path count vs the same walk without it. Also composes with `.emit().repeat(...).times(N).simplePath().path()` for multi-length emission (see entry below). |
| `.emit().repeat(<step>).times(N).path()` | Emit a path at every iteration boundary (length 0, 1, …, N). **Verified working** — live-validated 2026-05-25. Used by `findPaths` to surface paths of any length up to `maxDepth` in one round-trip — replaces the previous N-deep BFS that issued K-per-frontier-vertex queries per layer. Composes with `.simplePath()` placed after `.times(N)`; cycles are filtered globally rather than per-iteration. The first emission (length 0, just the start vertex alone) is included; callers filter it out by checking the terminal vertex against the target. |

### Mutation

| Operator | Notes |
|---|---|
| `addV('label')` | Create a vertex with a label. The label is the Gremlin vertex label (immutable); the property `entityType` is what every read query filters on. |
| `addE('label').to(<traversal>)` | Create an edge from the current traverser to the target traversal's first vertex. |
| `.property(k, v)` | Set a property. Multiple `.property` chains on a single addV/addE are atomic within that query. |
| `.sideEffect(properties('foo').drop())` | Delete a single property. Used by `updateEntity` for null-assignment. |
| `.drop()` | Delete vertex or edge. On a vertex, also drops incident edges. |
| `fold().coalesce(unfold().<update-chain>, <create-chain>)` | Atomic upsert pattern. Production use in [packages/storage-cosmosdb/src/queries/bulk.ts:246-303](../packages/storage-cosmosdb/src/queries/bulk.ts#L246-L303). |

### Side-effect collectors

| Operator | Notes |
|---|---|
| `aggregate('bucket')` | Collect the current traverser into a named side-effect bucket; passes the traverser through unchanged. **Verified working with mixed vertex+edge accumulation in one bucket** — see [§Aggregating raw vertices and edges together](#aggregating-raw-vertices-and-edges-together) below. |
| `aggregate('bucket').by(<projection>)` | Collect the by-modulator's *output* into the bucket instead of the raw traverser. The projection runs on a LIVE element (vertex or edge), so the by-modulator idioms that work for terminal-mode projection (`.by(id)` token, `.by('propertyName')`, `coalesce(values, constant)` for optionals) also work here. **This is the load-bearing pattern** if you ever need ready-to-emit projected Maps in the bucket — the alternative of projecting after `cap+unfold` is not viable in the CosmosDB subset (see [§`cap+unfold` strips property accessors](#capbucketunfold-strips-property-accessors)). |
| `store('bucket')` | Eager variant of `aggregate`. Available but `aggregate` is the idiom used in the codebase. |
| `cap('bucket')` | Retrieve a collected bucket. Emits one traverser whose value is the list. `.cap('bucket').unfold()` re-emits each element as a separate traverser. |
| `group().by('field').by(count())` | Group-by aggregation. Used by `getRepositoryStats`. RU scales with the input set, not the output set — full-partition group-by is expensive on large repos. |

---

## Constraints — patterns that fail

Each entry: the pattern, the symptom (with the literal error text where available), and the workaround.

### Path `.by()` with a single project across mixed vertex+edge objects

```gremlin
.path().by(project('id','entityType').by(id).by('entityType'))
```

**Symptom:** Server error — *"Project By: Next: The provided traverser of key 'entityType' maps to nothing."* Triggered when the path contains objects (edges) that lack a key the project tries to read.

**Workaround:** Use two `.by()` modulators in round-robin — one for vertex shape, one for edge shape:

```gremlin
.path().by(<vertexProject>).by(<edgeProject>)
```

Gremlin applies the modulators alternately to objects in path order (vertex-edge-vertex-edge-…). **Verified working** — live-validated 2026-05-25.

### `dedup().by('id')` on projected maps

```gremlin
.union(__.identity().project('id','entityType').by(id).by('entityType'), ...)
  .dedup().by('id')
```

**Symptom:** Server error — *"Deduplicate: Next: The provided traversal or property name of Dedup does not map to a value."* When the upstream stream consists of projected Maps (not vertices/edges), a property-name string doesn't resolve.

**Workaround:** Use `select('id')` — this extracts the `id` key from the projected Map:

```gremlin
.dedup().by(select('id'))
```

**Verified working** — live-validated 2026-05-25.

### Bare `.by('optionalField')` on a vertex without that property

```gremlin
project('id','data').by(id).by('data')
```

**Symptom:** Server error on the first row where the property is absent. Gremlin's `.by('foo')` does a property-value lookup that throws when the property doesn't exist.

**Workaround:** Wrap every optional field with `coalesce(values('foo'), constant(<default>))`:

```gremlin
.by(coalesce(values('data'), constant('')))
.by(coalesce(values('bidirectional'), constant(false)))
```

For required fields (which by data contract should always be present), bare `.by('field')` is fine — and if the field is genuinely missing, you want to know about it. Decide field-by-field at compile time.

**Verified working** — live-validated 2026-05-25.

### `TextP.containing()` for substring search

```gremlin
g.V().has('label', TextP.containing('foo'))
```

**Symptom:** Silently returns no rows (no error). The TinkerPop `TextP` predicates are not supported in CosmosDB's subset.

**Workaround (current):** `findEntities` routes `searchTerm` and `properties` queries through the **Cosmos NoSQL (Document) endpoint** via `CosmosDocumentClient` — a separate code path from the Gremlin connection, sharing the same backing container. See the "Cosmos SQL `findEntities` path" section below for the wire shape, indexing-policy requirements, and an RU baseline. The old approach (load candidate set, filter client-side) is gone.

### Property-key interpolation prevents server-side plan caching

```gremlin
g.addV('Person').property('entityType', p0).property('label', p1)...
```

When the property *key* (`'entityType'`, `'label'`, …) is interpolated into the query string, every write of a different shape becomes a unique query. CosmosDB can't reuse a compiled plan across them. Property *values* go through bindings (parameterized), which is correct security-wise, but the key interpolation defeats plan caching.

**Resolution (2026-05-26):** every create/upsert/insert path in `packages/storage-cosmosdb/src/queries/` now emits one of seven module-level constant query strings (one per `addV` / `addE` create + one per upsert + one per `_repository` create). The query shape is fixed by:

1. **String-literal property keys** (`'entityType'`, `'entityLabel'`, …) in the canonical fixed order defined in [packages/storage-cosmosdb/src/mapping.ts](../packages/storage-cosmosdb/src/mapping.ts).
2. **`choose`-skip wrapper** for optional fields: `.choose(__.constant(vN).is(neq(absentSentinel)), __.property('key', vN), __.identity())`. When the binding `vN` equals the sentinel (`''`), the choose's predicate evaluates false and the `__.identity()` branch fires — no property is written. This keeps the query string constant regardless of which optional fields the caller populated.
3. **The `id` and `repositoryId` slots are written separately on the create branch only** (`.property('id', vid).property('repositoryId', rid)`) because Cosmos rejects partition-key mutation after `unfold()`. The ladder excludes them so the same ladder string can be reused unchanged in both the create branch and the upsert update branch.

The sentinel choice — empty string `''` — preserves the `isNull`/`isNotNull` PropertyFilter contract: choose-skipped properties are GENUINELY absent on the vertex, so `hasNot('summary')` correctly finds entities written without a summary. Confirmed by live probe 2026-05-26.

This is the resolved form of [Performance issue #20](../plans/performance-issues.md). Plan-cache observability is Azure-only — the emulator does not surface it.

---

## Performance-critical operator differences

These are correctness-OK choices that have non-obvious RU/latency consequences.

### `g.V().has('id', x)` vs `g.V().hasId(x)`

In CosmosDB Gremlin, `id` is the **system id** — the document id used for partition routing. `hasId(x)` is a direct doc fetch; `has('id', x)` is a property-equality lookup that goes through the property index. Both return the same row, but the cost differs:

- `g.V().has('repositoryId', rid).hasId(x)` — partition predicate routes to one partition, then a direct doc fetch. Cheap.
- `g.V().has('repositoryId', rid).has('id', x)` — partition predicate routes to one partition, then an index seek on the `id` property. More RU, more latency.

Use `hasId` for entity-id-anchored starts. The compiler emits `hasId(p0)` on every entityId-anchored traversal start.

### `g.E().has('repositoryId', rid)` doesn't always push partition down

Edges in CosmosDB Gremlin live in the source vertex's partition, but `g.E().has('repositoryId', rid)` is not guaranteed to push the partition predicate down to physical-partition routing — it can fan out across all partitions and filter afterward.

**Preferred:** when the source vertex id is known, start at the vertex and walk to the edge:

```gremlin
g.V().has('repositoryId', rid).hasId(srcId).has('entityType').outE().hasId(relId)
```

When only the relationship id is known, the `g.E().hasId(relId).has('repositoryId', rid)` form is still correct but inherently fans out. See [Performance issue #2](../plans/performance-issues.md).

### `valueMap(true)` ships every property

For an entity with a 1536-float `embedding` (the default for `text-embedding-3-large` at 1024 dimensions or `text-embedding-3-small` at 1536), the JSON-stringified embedding is ~30 KB per vertex. `valueMap(true)` ships it on every traversal, even though `projectEntity` strips it client-side at every detail level.

In `'path'` mode the same vertex is shipped once per containing path — so a vertex visited by K walks ships K × 30 KB. RU and bandwidth both scale linearly with that.

**Preferred:** use explicit `.project(...).by(...)` chains listing only the fields the mapper consumes. Every read path except the export path emits project chains; only the bulk-export path still uses `valueMap(true)` (it must include the embedding so a re-import is field-for-field faithful).

### Union branches with shared prefix are NOT a quadratic-compute problem (surprising — verified)

A union shape like

```gremlin
.union(
  __.identity(),
  __.outE(r1),
  __.outE(r1).inV(),
  __.outE(r1).inV().outE(r2),
  __.outE(r1).inV().outE(r2).inV()
)
```

LOOKS like each branch re-walks the shared prefix from scratch — O(N²) hops at depth N. The emitted query string is also quadratic in the number of vertex-step references. This is the conventional Gremlin-correctness reading.

**But empirically the CosmosDB engine already recognises the shared prefix and walks it once.** With unbounded pagination, this union shape and an equivalent linear walk (`aggregate('els').by(<project>)...cap('els').unfold().dedup().range(...)` — see [§Aggregating raw vertices and edges together](#aggregating-raw-vertices-and-edges-together)) produce **identical RU at every depth** on the Mining Fleet repo (4504 entities, 6642 relationships):

| Anchor | Depth | Union RU | Aggregate-walk RU |
|---|---|---|---|
| Caterpillar (1213 edges) | 1 | 534.82 | 534.82 |
| Cat 309 CR (194 edges) | 2 | 830.80 | 830.80 |
| Cat 309 CR (194 edges) | 3 | 2014.90 | 2014.90 |

So the engine compiles the union shape to a linear execution plan. The quadratic concern only applies to emitted-string length, not to runtime cost.

### `range()` pushdown through `union(...).dedup()` is the real perf lever

The union shape's *real* runtime advantage is that **`.union(...).dedup().by(select('id')).range(0, N)` short-circuits the union once N deduped items have been produced.** Deeper-depth branches never fire if shallower branches saturate the cap. On Caterpillar at depth-3 with `range(0, 200)`, the union shape walks just enough to produce 200 unique items (94.36 RU). The equivalent `aggregate('els')` shape, capped at the same 200, pays **2014.90 RU (21×)** because side-effect aggregation has no early-termination — the walk completes in full and `range` only trims the deduped output.

| Anchor | Depth | range(0, 200) | range(0, 99999) |
|---|---|---|---|
| Cat 309 — union | 3 | 94.36 RU | 2014.90 RU |
| Cat 309 — aggregate-walk | 3 | 2014.90 RU | 2014.90 RU |

Workarounds attempted for early termination on the aggregation shape that did **not** work in the CosmosDB subset:

- `where(cap('els').count(local).is(P.gte(N)))` mid-walk — unsupported.
- `until(cap('els').count(local).is(P.gte(N)))` as a `repeat()` modulator — only fires inside `repeat`, doesn't apply to per-step walks of differing directions.
- `.limit(N)` before `aggregate` — only caps the entry-point stream, not the side-effect bucket.

**Prefer the union-with-shared-prefix shape over incremental aggregation for `'all'`-mode reads with a user-supplied limit.** The current `GremlinCompiler` `'all'` mode does this (`union(__.identity().<v>, __.<edges-and-vertices-per-depth>).dedup().by(select('id')).range(...)`); do not replace it.

### `cap('bucket').unfold()` strips property accessors

After `.cap('bucket').unfold()`, the elements ARE returned as Vertex / Edge objects — `.label()`, `.id()`, and `.valueMap(true)` all work on them. But **by-modulator property access fails silently**:

| After `cap+unfold`, on a stream that includes vertices and edges | Behaviour |
|---|---|
| `.values('entityType')` | Returns empty even on vertices that have `entityType` set. |
| `.has('entityType')` as a filter | Filters out every element, vertices included. |
| `.by('propertyName')` inside `project(...).by('foo')` | Resolves to `""` rather than the actual property value. |
| `.by(coalesce(values('foo'), constant('')))` | Returns the constant default for every element. |
| `.by(id)` (bare Gremlin token) inside `project(...).by(id)` | Throws `Project By: Next: The provided traverser of key "id" maps to nothing`. |
| `.by(__.id())` (anonymous traversal step) inside `project(...).by(__.id())` | Works — returns the system id. |
| `.id()` as a step | Works — returns the system id. |
| `.label()` as a step | Works — returns the label. |
| `.valueMap(true)` as a step | Works — returns the full property map. |

So you can do `.cap('bucket').unfold().dedup().range(0, N).id()` (cheap id list) or `.cap('bucket').unfold().dedup().range(0, N).valueMap(true)` (full map, ships embeddings). But you cannot project a custom shape via `project(...).by(...)` *after* `cap+unfold` — the by-modulators that you need for selectively reading properties don't work on the re-emitted stream.

**Workaround when you DO need a custom projection from a side-effect bucket:** project at aggregate-time (`aggregate('bucket').by(<projectionWithSelectiveBys>)`) — the projection runs on a LIVE element before it enters the bucket. The bucket then contains Maps, and `.cap('bucket').unfold().dedup().by(select('id'))` is the right downstream form (`dedup().by('id')` on Maps doesn't work either — see [§dedup().by('id') on projected maps](#dedupbyid-on-projected-maps)).

### Aggregating raw vertices and edges together

`aggregate('bucket')` accepts both Vertex and Edge traversers into the same bucket and preserves type. After `.cap('bucket').unfold()`, you get back a mixed-type stream. To distinguish:

- A discriminator key projected at aggregate time: `aggregate('b').by(project('__kind','id').by(constant('v')).by(__.id()))` for vertices and `…by(constant('e')).by(__.id())` for edges. The downstream consumer then reads `__kind`.
- `.label()` on the cap-unfold stream — returns the vertex's entity label (`Person`, `Equipment`, …) or the edge's relationship label (`WORKS_AT`, `IS_IDENTITY_FOR`, …). Useful for filtering when the label set is known statically.

Mixed-type bucket dedup by id requires the aggregate-at-project-time form because `dedup().by(__.id())` after cap+unfold *does* work on raw elements but loses access to the discriminator the downstream parser needs. If your bucket holds Maps, use `dedup().by(select('id'))`.

### Sorting without a Range index does a full scan

```gremlin
g.V().has(...).order().by('id').limit(N).valueMap(true)
```

If the container's indexing policy doesn't include a Range index on the `id` path (or whatever field you order by), `order().by(...)` falls back to scanning every matching vertex into memory, sorting, then truncating. Per-batch cost grows with partition size.

**Mitigation:** confirm the indexing policy covers every field used in `order().by(...)` ordering. Used by bulk export ([packages/storage-cosmosdb/src/queries/bulk.ts:32-40](../packages/storage-cosmosdb/src/queries/bulk.ts#L32-L40)) — verify before relying on it for large exports.

### Full-partition `group().by(field).by(count())`

```gremlin
g.V().has('repositoryId', rid).has('entityType').group().by('entityType').by(count())
```

Fine on small repos; expensive at millions of vertices because the engine has to touch every matching doc to build the group. `getRepositoryStats` uses this — its RU scales with the partition's vertex count, not with the number of distinct types.

**Mitigation options:** write-side counter vertex (atomic increments on every mutation), or eventual-consistency stats refreshed on a schedule. Currently deferred — see [Performance issue #11](../plans/performance-issues.md).

---

## Cosmos SQL `findEntities` path

`findEntities` does **not** use the Gremlin endpoint. It routes entirely through the Cosmos NoSQL (Document) endpoint via `CosmosDocumentClient` — raw `fetch` + HMAC, no SDK dep, sharing the backing container with the Gremlin reads. The reason is in the section above: `TextP.containing()` silently returns zero rows, so substring `searchTerm` cannot be expressed server-side in the Gremlin subset, and the JS-filter workaround loaded every type-matched vertex into Node memory.

The SQL rewrite (Step D of [plans/findentities-cosmos-fanout-2026-05-25.md](../plans/findentities-cosmos-fanout-2026-05-25.md)) issues two parallel queries against the same `WHERE` clause:

```sql
-- data
SELECT <projection> FROM c
WHERE c.repositoryId = @rid
  [AND c.entityType[0]._value IN (@etype0, @etype1, ...)]
  [AND (CONTAINS(c.entityLabel[0]._value, @term, true)
     OR CONTAINS(c.slug[0]._value,        @term, true)
     OR CONTAINS(c.summary[0]._value,     @term, true))]
  [AND CONTAINS(c.properties[0]._value, @kv0, false) AND ...]
ORDER BY c.id OFFSET @off LIMIT @lim

-- count (skipped when query.properties is non-empty)
SELECT VALUE COUNT(1) FROM c WHERE <same clause>
```

The `count` is skipped on `properties` queries because the `CONTAINS` on the JSON-stringified blob is **approximate** — exact-match verification happens client-side after the page lands. Counting the approximate set would overstate `total`, so `PaginatedResult.total` is `undefined` for those queries by convention.

### Path conventions (the `[0]._value` gotcha)

Every Gremlin-managed property is stored as `[{ "_value": ..., "id": "..." }]` when read from the Document endpoint. The SQL must address `c.<field>[0]._value`, **including the `entityType` filter** — `c.entityType = @t` returns zero docs at `indexUtilizationRatio=0.00`. The only flat scalars are `c.id`, `c.repositoryId`, and the Gremlin label token `c.label` (which is **stale after `updateEntity`** — read `c.entityType[0]._value` for authoritative type).

### Indexing-policy requirement

The SQL rewrite assumes the default Cosmos indexing policy (`includedPaths: /*`, only `/_etag` excluded). All six guarded paths — `/entityLabel`, `/slug`, `/summary`, `/entityType`, `/properties`, `/repositoryId` — must be indexed or `CONTAINS` falls back to scan.

`CosmosDbProvider.ensureSchema()` includes an indexing-policy diagnostic (Step E): after schema version is settled, it fetches container metadata and `console.warn`s if any guarded path is in `excludedPaths`. Code-managed containers (`ensureSchema()` provisions them) get the default policy and never warn. Operators provisioning via ARM/Bicep outside this codebase should review the template — the warning will surface mismatches at startup.

### RU baseline (200-entity emulator workload, 2026-05-26)

Full results: [local-tests/baseline/findentities-cosmos-sql-results.md](../local-tests/baseline/findentities-cosmos-sql-results.md). Probe script: [local-tests/findentities-cosmos-sql-probe.mjs](../local-tests/findentities-cosmos-sql-probe.mjs).

| Query shape | items | total | RU | calls |
|---|---:|---:|---:|---:|
| no filters | 25 | 200 | 10.89 | 2 |
| `entityTypes: ['Person']` | 25 | 150 | 14.46 | 2 |
| `searchTerm: 'ALICE'` | 25 | 39 | 23.06 | 2 |
| `searchTerm` + `entityTypes` | 25 | 39 | 21.65 | 2 |
| `properties: { role: 'engineer' }` | 25 | undefined | 7.91 | 1 |
| offset 50, limit 25 | 25 | 200 | 10.57 | 2 |

Compared to the deleted Gremlin JS-filter path at the same fixture (~10 RU to load 150 Person vertices, ~12 RU for the whole 200-vertex partition): **the new path scales with page size; the old path scaled with type population.** At 4500 entities (Mining Fleet scale) the old path would project ~300 RU per call; the new path stays at ~25 RU regardless of population. The qualitative wins — case-insensitive `CONTAINS` server-side, no `UnsupportedQueryError` for cross-type substring queries — were the actual motivation; the RU number confirms it isn't a regression at small scale either.

### Case-insensitive contract

The third argument to `CONTAINS(field, @term, true)` is `ignoreCase`. The conformance test (`packages/core/src/providers-builtin/conformance.ts`) locks the invariant cross-provider — `searchTerm: 'ALPHA'` matches an entity labelled `'Alpha'`. In-memory lowercases both sides; SQL Server's default `*_CI_AS` collation gives the same; Cosmos now matches via the third-arg flag instead of a JS fallback.

---

## Idioms and gotchas

### Anonymous traversal prefix `__.`

Branches inside `union(...)`, `repeat(...)`, `coalesce(...)`, `choose(...)`, and similar take **anonymous traversals**. Anonymous traversals must start with `__.` (the TinkerPop anonymous-traversal helper). A leading-dot chain off the receiver is a syntax error:

```gremlin
// ❌ Syntax error
union(outE(), inE().has('bidirectional', true))

// ✅ Works
union(__.outE(), __.inE().has('bidirectional', true))
```

The `GremlinCompiler` already does this in `compileRepeatStep` and the `'all'`-mode union.

### `id` is a token, not a string

Gremlin's `id` is a built-in token referencing the system id. `T.id` and bare `id` both work where a by-modulator argument is expected (we use bare `id` in the project chains). `'id'` (a string) is a *property name* — it's a different lookup that goes through the property index.

```gremlin
.by(id)            // system id (cheap)
.by('id')          // property named 'id' (property-index lookup)
```

### `valueMap` returns array-wrapped values; `project` returns scalars

`valueMap(true)` represents the multi-cardinality property model — every value is `Array<T>` even though CosmosDB stores single-cardinality properties:

```json
{ "entityType": ["Person"], "label": ["Alice"] }
```

`project(...).by(...)` returns scalar values:

```json
{ "entityType": "Person", "label": "Alice" }
```

The mappers in `packages/storage-cosmosdb/src/mapping.ts` use an `unwrap(val)` helper that tolerates both forms, so the mapper code doesn't need to know which form produced the input. Keep that compatibility — future changes to `unwrap()` or its callers must keep both forms working.

### Property values in bindings — strings, numbers, booleans only

Gremlin bindings serialize as primitives. For complex values (`properties` JSON blob, `embedding` float array), the project pre-stringifies them with `JSON.stringify` and the mapper parses on the way back. This pattern is set in `entityToGremlinProps` / `relationshipToGremlinProps`; don't bypass it.

### CosmosDB request-charge header

The RU cost of every query is returned in the `x-ms-total-request-charge` response attribute. `CosmosDbConnection.submit` exposes it as `result.requestCharge`. **Note:** the local emulator returns `0` for this header — RU verification needs the live account.

---

## Sources of findings

| Finding category | Source |
|---|---|
| Operators in production use | [packages/storage-cosmosdb/src/queries/](../packages/storage-cosmosdb/src/queries/) — every Gremlin string in these files has been exercised against the emulator at least once via the test suite. |
| Live shape probes — projection (2026-05-25) | `path()` two-by round-robin; `'all'` union per-branch project + `dedup().by(select('id'))`; `coalesce(values, constant)` for optional fields; failure modes of single-by mixed projection, `dedup().by('id')`, and bare `.by('optionalField')`. |
| Live shape probes — id lookup (2026-05-25) | `hasId(x)` single-id and `hasId(within(x, y, z))` batch forms work on both `g.V()` and `g.E()` — drop-in replacements for the equivalent `has('id', ...)` shapes. |
| Live shape probes — simplePath (2026-05-25) | `simplePath()` placed before `.path()` filters cycle-revisiting traversers in the CosmosDB Gremlin subset. Composes correctly with the two-by projection `.path().by(<vertexProject>).by(<edgeProject>)`. |
| Live shape probes — aggregation vs union (2026-05-25) | (1) `aggregate('bucket')` accepts mixed vertex+edge accumulation; `aggregate('bucket').by(<projection>)` projects at aggregate time on a live element. (2) `cap('bucket').unfold()` strips by-modulator property accessors — only `.id()`/`.label()`/`.valueMap(true)` survive. (3) The union-with-shared-prefix shape is NOT quadratic on the engine — CosmosDB recognises the shared prefix and walks it once; both shapes have identical RU at every depth in unbounded mode. (4) `range()` pushdown through `union(...).dedup()` short-circuits the walk once the cap is hit; side-effect aggregation has no equivalent — the bounded union shape is up to 21× cheaper than the equivalent aggregation shape at depth 3 with cap=200 on Mining-Fleet–size data. |
| Live shape probes — fixed-shape ladder (2026-05-26) | (1) `choose(predicateTraversal, trueTraversal, falseTraversal)` works in the CosmosDB Gremlin subset; all three sub-traversals must be anonymous (`__.`-prefixed). (2) The `.choose(__.constant(vN).is(neq(absentSentinel)), __.property('k', vN), __.identity())` pattern leaves the property GENUINELY absent on the vertex when `vN` equals the sentinel — verified via `hasNot('summary')` finding choose-skipped vertices, preserving the `isNull` PropertyFilter contract. (3) Property values can be bound through parameters in both required and choose-skipped slots; the same fixed query string handles every write of any entity/edge type. (4) The fixed-shape ladder composes correctly with the upsert `fold().coalesce(unfold()<ladder>, addV().property('id', vid).property('repositoryId', rid)<ladder>)` pattern — both branches reuse the SAME ladder string. |
| Performance catalogue | [plans/performance-issues.md](../plans/performance-issues.md) — 20 ranked RU/round-trip issues, drawn from code review and Cosmos documentation. |
| Performance fixes plan | [plans/performance-fixes-2026-05-25.md](../plans/performance-fixes-2026-05-25.md) — phased plan that consumes this doc and adds findings back to it as each phase probes new shapes. |

---

## To-probe before next changes

- `T.id` vs bare `id` token as a by-modulator argument — empirically `id` works; `T.id` not yet tested.
- `select('id')` behaviour on edges where the projected map has a discriminator-prefixed key (e.g. if we project `__id` instead of `id` to avoid colliding with Gremlin's `id` token).
- Plan-cache empirical validation on the live Azure account — the emulator does not surface a clear plan-cache signal, so the fixed-shape ladder's latency win is currently structural-only. Capture a 50-write burst against Azure to confirm tail latency drops below first-call cost.
