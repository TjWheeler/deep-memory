# Deep Memory — Component Architecture

## System Overview

Deep Memory is a vocabulary-driven graph memory library for AI agents. It stores knowledge as typed entities (nodes) and relationships (edges) governed by a vocabulary schema. The library has zero runtime dependencies and uses a provider pattern for pluggable persistence, search, and embedding backends.

```
┌─────────────────────────────────────────────────────────────────┐
│                         DeepMemory                              │
│  (top-level facade: repository lifecycle, export/import)        │
│                                                                 │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                    MemoryRepository                       │  │
│  │  (primary working surface for a single knowledge graph)   │  │
│  │                                                           │  │
│  │  ┌──────────────┐  ┌───────────────────┐                 │  │
│  │  │ EntityManager │  │ RelationshipManager│                │  │
│  │  │  (CRUD +      │  │  (CRUD +           │                │  │
│  │  │   validation) │  │   constraint check) │                │  │
│  │  └──────┬───────┘  └────────┬──────────┘                 │  │
│  │         │                   │                             │  │
│  │  ┌──────┴───────────────────┴──────────┐                 │  │
│  │  │         VocabularyEngine             │                 │  │
│  │  │  (validation, governance, dedup)     │                 │  │
│  │  └─────────────────────────────────────┘                 │  │
│  │                                                           │  │
│  │  ┌────────────────┐  ┌──────────────────┐                │  │
│  │  │ GraphTraversal  │  │ SearchOrchestrator│                │  │
│  │  │  (BFS explore,  │  │  (find, full-text, │                │  │
│  │  │   path finding) │  │   concept search)  │                │  │
│  │  └────────────────┘  └──────────────────┘                │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                 │
│  ┌──────────┐  ┌───────────────────┐  ┌──────────────────────┐  │
│  │ EventBus  │  │ ProvenanceTracker  │  │ Portability          │  │
│  │ (events + │  │ (actor/timestamp   │  │ (export, import,     │  │
│  │  hooks)   │  │  stamping)         │  │  migration)          │  │
│  └──────────┘  └───────────────────┘  └──────────────────────┘  │
└────────────────────────────┬────────────────────────────────────┘
                             │
              ┌──────────────┼──────────────┐
              ▼              ▼              ▼
      ┌──────────────┐ ┌──────────┐ ┌───────────────┐
      │StorageProvider│ │SearchProv│ │EmbeddingProv  │
      │  (required)   │ │(optional)│ │  (optional)   │
      └──────────────┘ └──────────┘ └───────────────┘
```

## Component Descriptions

### DeepMemory

Top-level entry point. Manages the lifecycle of repositories and coordinates cross-repository operations.

**Responsibilities:**
- Create, open, list, delete repositories
- Export repositories to portable archives
- Import archives (create new or merge into existing)
- Hold global configuration (storage, search, embedding providers)
- Own the shared EventBus

**Does not:** Directly manipulate entities or relationships — that is delegated to MemoryRepository.

### MemoryRepository

The primary working surface for a single knowledge graph. All entity, relationship, vocabulary, and query operations go through this class.

**Responsibilities:**
- Entity CRUD (delegates to EntityManager)
- Relationship CRUD (delegates to RelationshipManager)
- Graph traversal: neighbourhood exploration, path finding (delegates to GraphTraversal)
- Search: find entities, full-text search, concept search (delegates to SearchOrchestrator)
- Vocabulary access and extension proposals (delegates to VocabularyEngine)
- Repository statistics
- Event subscription and hook registration (delegates to EventBus)

### EntityManager

Orchestrates entity creation, reading, updating, and deletion with validation and event lifecycle.

**Creation flow:**
1. Validate entity type and properties against vocabulary
2. Fire `entity:creating` hook (allows cancellation)
3. Generate GUID for `id` and deterministic `slug` (`{type}:{slugified-label}`)
4. Stamp provenance (actor, timestamp, conversation)
5. Persist via StorageProvider
6. Emit `entity:created` event
7. Return public Entity

**Detail levels:** Entities can be retrieved at three levels — `EntityBrief` (id, type, label), `EntitySummary` (+ summary, properties), or full `Entity` (+ data, provenance).

### RelationshipManager

Orchestrates relationship creation and removal with vocabulary constraint validation.

**Creation flow:**
1. Verify source and target entities exist
2. Validate relationship type against vocabulary (including allowedSourceTypes/allowedTargetTypes)
3. Fire `relationship:creating` hook
4. Check bidirectional flag from vocabulary
5. Use the caller's ID, or generate a random one (GUID)
6. Stamp provenance
7. Persist via StorageProvider
8. Emit `relationship:created` event

### VocabularyEngine

Central authority for vocabulary operations. Validates all mutations against the vocabulary schema, manages governance rules, and handles vocabulary evolution.

**Sub-components:**
- **VocabularyValidator** — validates entity/relationship inputs against type definitions and property schemas. Property types: `string`, `number`, `boolean`, `date`, `enum`.
- **VocabularyGovernor** — enforces governance modes:
  - `locked` — vocabulary cannot change
  - `managed` — proposals validated, optionally require approval
  - `open` — proposals auto-approved after validation
- **SemanticDeduplicator** — detects duplicate type proposals using embedding similarity (if EmbeddingProvider available) or Jaro-Winkler string similarity as fallback.
- **VocabularyDiff** — computes differences between vocabulary versions (used by MigrationEngine during import).

**Vocabulary freshness:** The engine keeps no copy of its own. Every validation reads through `StorageProvider.getVocabulary`, so it sees what the provider's cache holds: the persistent providers cache for `vocabularyCacheTtlMs` (60 s by default; `0` disables the cache), so a change made by another process reaches this one's write validation within that window. `openRepository(id, { freshVocabulary: true })` makes the handle validate writes against `{ fresh: true }` reads, bypassing the cache. A batch create reads the vocabulary once for the whole batch.

**Name rules:** New entity and relationship type names, and every property name (in a proposal and on every write), must match `SAFE_IDENTIFIER_PATTERN` (`^[A-Za-z_][A-Za-z0-9_]*$`). Property names must also not be reserved system-field names (`RESERVED_ENTITY_PROPERTY_KEYS` / `RESERVED_RELATIONSHIP_PROPERTY_KEYS`). The rules are the same on every provider, because graph stores write these names into query text, where they cannot be bound as parameters. A write that breaks them throws `InvalidInputError` (field `properties.<key>`).

**Change log:** An approved vocabulary change is saved together with its change record (`saveVocabulary(…, changeRecord)`), so `getVocabularyChangeLog` lists every landed change, newest first.

**Resumable type deletes:** A `delete_*_type` proposal writes the vocabulary first, then deletes the type's data. If the data delete fails part-way, resending the proposal finds the type already absent, runs the data delete again, and answers `approved` (no new vocabulary version) when it removed anything, or `rejected` "not found" when nothing was left.

### GraphTraversal

BFS-based graph exploration and path finding.

- **exploreNeighbourhood** — from a centre entity, expand outward by depth (1–3 hops). Returns layers grouped by relationship type, with per-type entity lists. Supports filtering by relationship types, entity types, and direction.
- **findPaths** — BFS from source to target, returns multiple paths (`maxDepth` default 3, max 5; `limit` default 5, max 200; `offset` max 1,000). Each path includes the sequence of entities and relationships traversed.

Options are validated before storage runs: out-of-range or non-integer bounds, and relationship type names or property-filter keys that are not identifiers (`SAFE_IDENTIFIER_PATTERN`), throw `TraversalValidationError` on every provider. `traverse` applies the same rule to its steps and filters, caps `limit` at 200 and `offset` at 1,000, and refuses a projection of a reserved or system field name.

Both methods delegate the raw traversal to StorageProvider and map results to public types.

### SearchOrchestrator

Coordinates multiple providers to serve search queries.

- **findEntities** — if a SearchProvider is available and a search term is given, merges results from StorageProvider (label/type matching) and SearchProvider (full-text). Otherwise falls back to storage only.
- **searchByConcept** — requires EmbeddingProvider. Embeds the query, computes cosine similarity against entity embeddings, returns scored results above a threshold (default 0.7).

### EventBus

Zero-dependency typed event emitter supporting both fire-and-forget events and pre-mutation hooks.

**Event types (20+):** `repository:created`, `entity:creating`, `entity:created`, `entity:updating`, `entity:updated`, `entity:deleting`, `entity:deleted`, `relationship:creating`, `relationship:created`, `relationship:removing`, `relationship:removed`, `vocabulary:updated`, `vocabulary:extension:proposed`, `vocabulary:extension:approved`, `vocabulary:extension:rejected`, `validation:failed`, `search:executed`, `search:index_failed`, `export:completed`, `import:completed`, `delete:started`, `delete:progress`, `delete:completed`.

`search:index_failed` (`{ entityId, error }`) reports a committed entity create, update or delete whose SearchProvider update failed; the write stands. The repository-delete events carry no up-front totals, because nothing counts the repository before deleting it: `delete:started` is `{ repositoryId }`, `delete:progress` carries the running counts removed so far, and `delete:completed` the counts actually removed.

**Hooks:** Pre-mutation hooks (`entity:creating`, `entity:updating`, `entity:deleting`, `relationship:creating`, `relationship:removing`) can return `{ cancel: true, reason }` to abort the operation. Multiple hooks run in registration order; first cancellation wins.

### ProvenanceTracker

Stamps every mutation with traceability metadata.

**Fields:** `createdBy`, `createdByType`, `createdAt`, `createdInConversation`, `createdFromMessage`, and corresponding `modified*` fields. On creation, both created and modified fields are set. On update, created fields are preserved and modified fields are updated.

### Portability (Export/Import)

Three components handle repository portability:

- **RepositoryExporter** — serialises a repository to an `ExportArchive` containing manifest, vocabulary, entities, and relationships. Includes embedding metadata (modelId, dimensions) for compatibility tracking.
- **RepositoryImporter** — imports an archive in two modes:
  - `create` — creates a new repository from the archive
  - `merge` — imports into an existing repository with conflict resolution (vocabulary: reject/extend/prompt; entities: skip/overwrite/rename)
- **MigrationEngine** — computes vocabulary diffs and applies migrations when merging into a repository with a different vocabulary.

## Provider Interfaces

### StorageProvider (required)

The primary persistence interface. Every read and write goes through this provider.

**Surface area:**
- Repository lifecycle (create, get, list, delete, stats)
- Vocabulary persistence (get, save, changelog)
- Entity CRUD (create, get, getMany, update, delete, find)
- Relationship CRUD (create, get, getForEntity, delete)
- Graph traversal (exploreNeighbourhood, findPaths)
- Timeline queries
- Bulk export/import

**Vocabulary contract for implementers:**
- `createRepository(config)` must also persist the repository's vocabulary — `config.vocabulary` when supplied, otherwise `createEmptyVocabulary(config.createdBy)`. This is the only place a vocabulary is created.
- `getVocabulary(repositoryId, options?: { fresh?: boolean })` — `fresh: true` bypasses any provider-side cache. Providers without a cache ignore it.
- `saveVocabulary(repositoryId, vocabulary, expectedVersion, changeRecord?)` is compare-and-set. The write lands only if the stored version equals `expectedVersion`, and the check and the write must be atomic. A mismatch throws `VocabularyVersionConflictError` (code `VOCABULARY_VERSION_CONFLICT`, carrying `repositoryId`, `expectedVersion` and `actualVersion`) and leaves the stored vocabulary unchanged. It never creates: when the repository or its vocabulary does not exist it throws `RepositoryNotFoundError`. A `changeRecord` is persisted with the write (in the same transaction where the store has one) and only when the write lands; `getVocabularyChangeLog` returns the records newest first by `proposedAt`, then `changeId`.
- `deleteEntitiesByType` / `deleteRelationshipsByType` return exact counts, `0` when nothing of the type is left; the engine relies on that to resume a type deletion.

**Other contract points for implementers** (each has a case in the conformance suite):
- **Missing repository.** Every repository-scoped call throws `RepositoryNotFoundError` when the repository is gone, ahead of any not-found, empty or per-id answer — including while an interrupted delete has left data behind. The only exception is a cached `getVocabulary` hit within the cache's TTL. CosmosDB checks some calls in a separate request from their work; the `StorageProvider` JSDoc lists those windows.
- **Slugs** are unique per repository. `createEntity` / `updateEntity` throw `SlugConflictError` when another entity holds the slug; `DuplicateEntityError` means the id is taken. The engine retries a slug clash with the next suffix.
- **Relationship creates** throw `EntityNotFoundError` for a missing endpoint and `DuplicateRelationshipError` for a used id. `createRelationship(…, { idMinted: true })` tells the provider the engine generated the id, so it may skip the id check.
- **`deleteRepository`** returns `{ deletedEntities, deletedRelationships }`. It does not count the repository first.
- **`importBulk`** refuses a relationship id that already exists with a different type or endpoints (`RELATIONSHIP_ALREADY_EXISTS`); the same id, type and endpoints update in place. Most providers record it as a row error; SQL Server's import is all-or-nothing and rejects the whole import with an `ImportError` whose `cause` carries the code.
- **Property names** that break the [name rules](#vocabularyengine) are refused with `InvalidInputError`.

**Included implementation:** `InMemoryStorageProvider` — uses `Map`s, no persistence across process restarts. A conformance test suite (`runStorageProviderConformanceTests`) validates any implementation.

### SearchProvider (optional)

Enhances entity search with full-text indexing.

**Surface area:** `indexEntity`, `removeEntity`, `search`, optional `reindexRepository`.

**Included implementation:** `InMemorySearchProvider` — basic word-matching scorer.

### EmbeddingProvider (optional)

Enables semantic search and vocabulary deduplication.

**Surface area:** `embed`, `embedBatch`, `dimensions`, `modelId`, optional `similarity`.

**Included implementation:** `NoOpEmbeddingProvider` — throws on every call (fail-fast when no real provider configured).

### LockProvider (optional, reserved)

Distributed locking for multi-process deployments. Interface defined but not yet consumed.

## Data Flow

### Entity Creation

```
Client
  │
  ▼
MemoryRepository.createEntity(input)
  │
  ▼
EntityManager.create(input)
  ├── VocabularyEngine.validateEntity(input)
  │     └── VocabularyValidator.validateEntity(input, vocabulary)
  ├── EventBus.emitHook('entity:creating', ...)  ← can cancel
  ├── EntityIdGenerator.generateUniqueEntityId(...)
  ├── ProvenanceTracker.stampCreate()
  ├── StorageProvider.createEntity(storedEntity)  ← SlugConflictError → next slug suffix, up to 3 retries
  ├── SearchProvider?.indexEntity(entity)         ← if available; best-effort (failure → 'search:index_failed')
  ├── EventBus.emit('entity:created', ...)
  └── return Entity
```

**Batch creates** (`createEntities` / `createRelationships`) validate every member first and write nothing if any member fails validation. Members are then written one at a time. If a write fails after one or more members were stored, the call throws `BatchPartialFailureError` (code `BATCH_PARTIAL_FAILURE`) carrying `created` (the stored members, as a successful call would return them), `failedIndex` and `cause`; the caller should resend only the members not in `created`. A failure with nothing stored throws the original error.

### Vocabulary Extension

```
Client
  │
  ▼
MemoryRepository.proposeVocabularyChange(proposal)
  │
  ▼
VocabularyEngine.proposeChange(proposal, actorId)
  └── up to 3 attempts:
        ├── StorageProvider.getVocabulary({ fresh: true })   ← bypasses caches
        ├── SemanticDeduplicator.checkDuplicate(...)         ← add proposals
        │     ├── EmbeddingProvider?.embed(...)              ← if available
        │     └── jaroWinklerSimilarity(...)                 ← fallback
        ├── property-schema validation
        ├── VocabularyGovernor.processProposal(...)
        │     ├── canPropose(governance, proposal)
        │     └── apply or queue based on mode
        ├── if approved:
        │     ├── StorageProvider.saveVocabulary(updated, readVersion, changeRecord)   ← compare-and-set
        │     └── cascade-delete data                    ← delete proposals, after the write
        ├── VocabularyVersionConflictError → next attempt (re-evaluates everything)
        └── return VocabularyProposalResult
  after the 3rd conflict → VocabularyVersionConflictError to the caller
```

The read is fresh so the version passed to `saveVocabulary` is the stored one, not a cached copy another process has superseded. A conflict means another writer changed the vocabulary between the read and the write; the retry re-runs deduplication, validation and governance against the vocabulary that won. The vocabulary is written before a delete proposal's data is removed: the vocabulary is the source of truth, and data left under a removed type can be deleted again, whereas data deleted for a type whose removal then failed to persist cannot be recovered.

## Module Dependency Graph

```
DeepMemory
├── MemoryRepository
│   ├── EntityManager
│   │   ├── VocabularyEngine
│   │   ├── ProvenanceTracker
│   │   └── EventBus
│   ├── RelationshipManager
│   │   ├── VocabularyEngine
│   │   ├── ProvenanceTracker
│   │   └── EventBus
│   ├── GraphTraversal
│   │   └── StorageProvider
│   └── SearchOrchestrator
│       ├── StorageProvider
│       ├── SearchProvider?
│       └── EmbeddingProvider?
├── VocabularyEngine
│   ├── SemanticDeduplicator
│   │   ├── EmbeddingProvider?
│   │   └── similarity (Jaro-Winkler)
│   ├── VocabularyGovernor
│   └── VocabularyValidator
├── EventBus
├── ProvenanceTracker
├── RepositoryExporter
│   └── StorageProvider
└── RepositoryImporter
    └── MigrationEngine
        └── VocabularyDiff
```

## Directory Structure

```
src/
├── index.ts                        # Public API barrel export
├── core/
│   ├── DeepMemory.ts               # Top-level facade
│   ├── MemoryRepository.ts         # Repository working surface
│   ├── EventBus.ts                 # Typed events + hooks
│   ├── ProvenanceTracker.ts        # Mutation stamping
│   ├── VocabularyEngine.ts         # Vocabulary orchestration
│   └── errors.ts                   # Error hierarchy (14 types)
├── entities/
│   ├── EntityManager.ts            # Entity CRUD orchestration
│   └── IdGenerator.ts              # GUID + deterministic slug generation
├── relationships/
│   ├── RelationshipManager.ts      # Relationship CRUD orchestration
│   └── GraphTraversal.ts           # BFS explore + path finding
├── vocabulary/
│   ├── VocabularySchema.ts         # Vocabulary construction
│   ├── VocabularyValidator.ts      # Entity/relationship validation
│   ├── VocabularyGovernor.ts       # Governance mode enforcement
│   ├── SemanticDeduplicator.ts     # Duplicate type detection
│   ├── VocabularyDiff.ts           # Vocabulary version diffing
│   └── similarity.ts              # Jaro-Winkler (zero deps)
├── search/
│   └── SearchOrchestrator.ts       # Multi-provider search
├── portability/
│   ├── RepositoryExporter.ts       # Repository → archive
│   ├── RepositoryImporter.ts       # Archive → repository
│   └── MigrationEngine.ts         # Vocabulary migration
├── providers/
│   ├── StorageProvider.ts          # Persistence interface
│   ├── SearchProvider.ts           # Full-text search interface
│   ├── EmbeddingProvider.ts        # Vector embedding interface
│   ├── LockProvider.ts             # Distributed lock interface
│   └── index.ts                    # Provider re-exports
├── providers-builtin/
│   ├── InMemoryStorageProvider.ts  # Reference storage impl
│   ├── InMemorySearchProvider.ts   # Basic search impl
│   ├── NoOpEmbeddingProvider.ts    # Fail-fast stub
│   └── conformance.ts             # StorageProvider test suite
├── types/                          # All type definitions
│   ├── entities.ts
│   ├── relationships.ts
│   ├── vocabulary.ts
│   ├── queries.ts
│   ├── results.ts
│   ├── events.ts
│   ├── provenance.ts
│   ├── repositories.ts
│   ├── portability.ts
│   └── index.ts
└── validation/
    └── validation.ts               # Property validation helpers
```
