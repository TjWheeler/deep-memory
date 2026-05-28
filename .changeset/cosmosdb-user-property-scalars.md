---
'@utaba/deep-memory-storage-cosmosdb': minor
---

Four CosmosDB-provider changes that ship together. Together they bring the Cosmos
backend's observable contract in line with Neo4j: server-side projection over user
properties now works, neighbourhood traversal dedup matches across providers, and
`findEntities` returns exact `total` counts whenever the filter values allow it.

## User properties are dual-written as native vertex / edge scalars

`createEntity`, `updateEntity`, `createRelationship`, both branches of bulk-import
`upsertEntity` / `upsertRelationship`, and the `skipExistenceCheck: true` bulk path
through `insertEntity` / `insertRelationship` now write every user-supplied property
to **both**:

1. The canonical JSON-stringified `properties` schema slot (unchanged — still the
   read-side source of truth for `entity.properties` / `relationship.properties`).
2. A per-key native vertex/edge scalar (`.property('<key>', <value>)`) for every value
   that passes `isNativeStorableValue` (`string`, finite `number`, `boolean`,
   homogeneous arrays of those). Nested objects, `null`, mixed arrays, and arrays of
   objects survive via the blob but stay non-predicate-queryable — same observable
   subset as `@utaba/deep-memory-storage-neo4j`.

The native scalars are what unblock server-side `g.V().has('orgType', 'company')`,
`group().by(values('orgType')).by(count())` projections, and the exact-path SQL
prefilter used by `findEntities`. The Cosmos Gremlin subset has no in-step JSON
traversal, so reaching inside the blob from a Gremlin step is structurally impossible
— the dual-write is how the contract gets honoured. The `skipExistenceCheck: true`
bulk path previously wrote blob-only rows, so a row produced by that path did not
participate in projection or the exact-path `findEntities` prefilter unless it was
later touched by `createEntity` / `updateEntity`; every dual-write entry point now
honours the same contract.

- Reserved user-property keys (`entityType`, `entityLabel`, `slug`, `summary`, …
  every schema slot, plus `id` / `repositoryId` and the Gremlin `'label'` edge token
  for relationships) throw `ProviderError` synchronously on every write path via
  `assertSafeEntityUserPropertyKey` / `assertSafeRelationshipUserPropertyKey`.
- `updateEntity` pre-reads the existing blob and drops native scalars whose keys
  leave the new payload via per-key `.sideEffect(properties('<key>').drop())`.
- Bulk-import upserts add and overwrite but do NOT drop stale scalars (no pre-read
  in the bulk path) — callers needing exact-shape semantics use `updateEntity`.
- Pre-existing entities written before this change are not backfilled. Lazy
  migration: their scalars appear on next write. Projections and the exact-path
  `findEntities` prefilter undercount unmigrated records until then.

See `docs/cosmosdb-gremlin-compatibility.md` (new "Properties model" section) for
the full contract.

## `exploreNeighborhood` dedup now matches the Neo4j semantic

`CosmosDbProvider.exploreNeighborhood` previously deduped traversal rows by
`(relationship-id, connected-entity-id)`. When two stored half-edges connected the
same pair of vertices (e.g. two `IS_MARRIED_TO` edges, one in each direction), each
distinct edge id passed the dedup and the same entity appeared twice in the
`(layer, relationship-type)` bucket — over-reporting `entities.length` and `total`.

Fixed to dedup by `(relationship-type, connected-entity-id)` per layer, matching
the `Map<relType, Set<entityId>>` pattern Neo4j and InMemory already use. The
cross-provider conformance test `dedupes connected entities per (layer,
relationship-type) bucket` locks the invariant; previously over-reported responses
now match the Neo4j and InMemory baselines.

## `findEntities` `PaginatedResult.total` widens to exact `number` on storable filter sets

`buildWhereClause` now picks one of three property-filter modes per call:

| Mode | Triggered by | Prefilter | `total` |
|---|---|---|---|
| `none` | `query.properties` absent / empty | (no clause) | exact `number` |
| `exact` | every value passes `isNativeStorableValue` | `c.<key>[0]._value = @valN` per clause against the dual-written native column | **exact `number`** |
| `approximate` | any value fails `isNativeStorableValue` | `CONTAINS(c.properties[0]._value, …)` substring match on the JSON blob | `undefined` |

Before this change, every non-empty `query.properties` set fell back to the
substring `CONTAINS` prefilter, so the COUNT branch was skipped and
`PaginatedResult.total` was always `undefined`. The exact path runs the COUNT
alongside the data query against the same `WHERE` clause, giving the precise total
for the dominant filter shape (eq over native-storable values). Filter sets that
mix in a non-storable value (nested object, mixed array, …) stay on the
approximate path with `total: undefined` — same observable shape as before for
those callers.

## `findEntities` throws on reserved-key collisions in `query.properties`

A reserved schema-slot key in `query.properties` (`{ entityType: 'Person' }`,
`{ id: '…' }`, etc.) now throws `ProviderError` synchronously on the exact path
via `assertSafeEntityUserPropertyKey`. Previously these were substring-matched
against the JSON blob through the old `CONTAINS` prefilter — usually returning
zero rows silently. Callers passing a schema field name through `properties` were
almost certainly meaning the typed field (`query.entityTypes`); the throw makes
the bug visible at the caller instead of swallowing it.
