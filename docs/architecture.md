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
5. Generate deterministic ID (`{type}:{sourceId}→{targetId}`)
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

**Caching:** The resolved vocabulary is cached in memory and invalidated after any mutation.

### GraphTraversal

BFS-based graph exploration and path finding.

- **exploreNeighbourhood** — from a centre entity, expand outward by depth (1–3 hops). Returns layers grouped by relationship type, with per-type entity lists. Supports filtering by relationship types, entity types, and direction.
- **findPaths** — BFS from source to target, returns multiple paths (default limit 5, max depth 3). Each path includes the sequence of entities and relationships traversed.

Both methods delegate the raw traversal to StorageProvider and map results to public types.

### SearchOrchestrator

Coordinates multiple providers to serve search queries.

- **findEntities** — if a SearchProvider is available and a search term is given, merges results from StorageProvider (label/type matching) and SearchProvider (full-text). Otherwise falls back to storage only.
- **searchByConcept** — requires EmbeddingProvider. Embeds the query, computes cosine similarity against entity embeddings, returns scored results above a threshold (default 0.7).

### EventBus

Zero-dependency typed event emitter supporting both fire-and-forget events and pre-mutation hooks.

**Event types (20+):** `repository:created`, `entity:creating`, `entity:created`, `entity:updating`, `entity:updated`, `entity:deleting`, `entity:deleted`, `relationship:creating`, `relationship:created`, `relationship:removing`, `relationship:removed`, `vocabulary:updated`, `vocabulary:extension:proposed`, `vocabulary:extension:approved`, `vocabulary:extension:rejected`, `validation:failed`, `search:executed`, `export:completed`, `import:completed`.

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
  ├── StorageProvider.createEntity(storedEntity)
  ├── SearchProvider?.indexEntity(entity)         ← if available
  ├── EventBus.emit('entity:created', ...)
  └── return Entity
```

### Vocabulary Extension

```
Client
  │
  ▼
MemoryRepository.proposeVocabularyExtension(proposal)
  │
  ▼
VocabularyEngine.proposeExtension(proposal, actorId)
  ├── SemanticDeduplicator.checkDuplicate(...)
  │     ├── EmbeddingProvider?.embed(...)          ← if available
  │     └── jaroWinklerSimilarity(...)             ← fallback
  ├── VocabularyGovernor.processProposal(...)
  │     ├── canPropose(governance, proposal)
  │     └── apply or queue based on mode
  ├── StorageProvider.saveVocabulary(updated)
  ├── EventBus.emit('vocabulary:extension:approved', ...)
  └── return VocabularyProposalResult
```

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
