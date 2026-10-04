# @utaba/deep-memory

Vocabulary-driven graph memory for AI agents.

Deep Memory is a TypeScript library that gives AI agents structured, persistent memory as a knowledge graph. Instead of dumping raw text into vector stores, agents work with typed entities, validated relationships, and governed vocabularies — making memory queryable, portable, and auditable.

## Why

AI agents need memory that goes beyond retrieval. They need to:

- **Store structured knowledge** — entities with typed properties and defined relationships, not just embeddings
- **Enforce consistency** — a vocabulary system acts as a schema contract, preventing drift as agents write autonomously
- **Trace provenance** — every mutation records who changed what, when, and in what conversation
- **Stay portable** — export a repository, import it elsewhere, migrate vocabularies across versions

Deep Memory provides these capabilities as functions, not tools. It is protocol-agnostic — the consuming application maps library functions to MCP tools, OpenAI function calls, Anthropic tool definitions, or whatever interface the agent framework requires.

## Quick Start

```typescript
import { DeepMemory, InMemoryStorageProvider } from '@utaba/deep-memory';

const memory = new DeepMemory({
  storage: new InMemoryStorageProvider(),
  provenance: { actorId: 'my-agent', actorType: 'agent' },
});

const repo = await memory.createRepository({
  repositoryId: 'my-knowledge',
  label: 'My Knowledge Graph',
  vocabulary: {
    entityTypes: [
      { type: 'person', description: 'A person' },
      { type: 'topic', description: 'A topic or concept' },
    ],
    relationshipTypes: [
      {
        type: 'interested_in',
        description: 'A person is interested in a topic',
        allowedSourceTypes: ['person'],
        allowedTargetTypes: ['topic'],
      },
    ],
  },
});

// Create entities — IDs are auto-generated GUIDs, with a deterministic slug
const alice = await repo.createEntity({
  entityType: 'person',
  label: 'Alice',
  summary: 'Software engineer interested in graph databases',
});
// alice.id === 'a1b2c3d4-...' (GUID), alice.slug === 'person:alice'

const graphs = await repo.createEntity({
  entityType: 'topic',
  label: 'Graph Databases',
});

// Create relationships — validated against vocabulary constraints
await repo.createRelationship({
  relationshipType: 'interested_in',
  sourceEntityId: alice.entityId,
  targetEntityId: graphs.entityId,
});

// Explore the graph
const neighbours = await repo.exploreNeighbourhood(alice.entityId);
// neighbours.layers[0]['interested_in'].entities === [{ label: 'Graph Databases', ... }]
```

## Installation

```bash
npm install @utaba/deep-memory
```

## Core Concepts

- **Repository** — an isolated knowledge graph with its own vocabulary and entity space
- **Vocabulary** — a typed schema defining allowed entity types, relationship types, and property constraints. Governance modes (locked, managed, open) control how the vocabulary evolves
- **Entity** — a node in the graph with a type, label, summary, typed properties, and optional rich data
- **Relationship** — a typed, directional edge between two entities
- **Provenance** — automatic tracking of actor, timestamp, and conversation context on every mutation

## Architecture

- **Zero runtime dependencies** — the core library has no npm dependencies
- **Provider pattern** — storage, search, and embedding are pluggable interfaces
- **Dual CJS/ESM build** — works in any Node.js environment
- **Functions, not tools** — Deep Memory is a library; wrap its functions as MCP tools, OpenAI functions, or Anthropic tools

## Sub-path Exports

```typescript
// Main API — classes, errors, built-in providers
import { DeepMemory, MemoryRepository, InMemoryStorageProvider } from '@utaba/deep-memory';

// Provider interfaces — for implementing custom providers
import type { StorageProvider, SearchProvider, EmbeddingProvider } from '@utaba/deep-memory/providers';

// Types only — for type annotations
import type { Entity, Relationship, MemoryVocabulary } from '@utaba/deep-memory/types';

// Testing — conformance suite for custom StorageProvider implementations
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';
```

## Provider Pattern

| Provider | Required | Purpose |
|----------|----------|---------|
| `StorageProvider` | Yes | Persistence (entities, relationships, vocabulary) |
| `SearchProvider` | No | Full-text search enhancement |
| `EmbeddingProvider` | No | Semantic/vector similarity search |
| `LockProvider` | No | Distributed locking (reserved) |

`InMemoryStorageProvider` ships as the reference implementation. For production, implement `StorageProvider` against your database and validate with the conformance test suite:

```typescript
import { runStorageProviderConformanceTests } from '@utaba/deep-memory/testing';

runStorageProviderConformanceTests(() => new MyCosmosDBProvider(config));
```

## Vocabulary & Governance

Vocabularies define what kinds of entities and relationships can exist, with typed property schemas:

```typescript
const repo = await memory.createRepository({
  repositoryId: 'legal',
  label: 'Legal Analysis',
  vocabulary: {
    entityTypes: [{
      type: 'contract',
      description: 'A legal contract',
      properties: [
        { name: 'value', type: 'number', required: false },
        { name: 'status', type: 'enum', required: true, enumValues: ['draft', 'active', 'expired'] },
      ],
    }],
    relationshipTypes: [/* ... */],
  },
  governance: { mode: 'managed' },
});
```

Governance modes control vocabulary evolution:
- **locked** — vocabulary cannot change
- **managed** — changes require validation (and optionally human approval)
- **open** — validated changes auto-approve (with deduplication)

**Name rules.** New entity and relationship type names, and every property name, must match `SAFE_IDENTIFIER_PATTERN` (`^[A-Za-z_][A-Za-z0-9_]*$`): `start_date`, not `start-date`. Property names must also not be reserved for a system field (`RESERVED_ENTITY_PROPERTY_KEYS` / `RESERVED_RELATIONSHIP_PROPERTY_KEYS`, e.g. `label`, `slug`, `createdAt`). The rules are the same on every storage provider: a proposal that breaks them is rejected, and a write throws `InvalidInputError` (field `properties.<key>`). An update may still remove, or carry over unchanged, a key stored before these rules.

**Change log and type deletes.** Every landed vocabulary change is recorded with it, and `getVocabularyChangeLog` lists them newest first. A type deletion writes the vocabulary first, then deletes the type's data; if the data delete fails part-way, resend the same proposal: it finishes the delete and answers `approved`, or `rejected` "not found" when nothing was left.

**Vocabulary freshness.** Writes are validated against the vocabulary the storage provider returns. The persistent providers cache it for `vocabularyCacheTtlMs` (60 s by default; `0` disables the cache), so a change made by another process is enforced here within that window. To enforce changes at once, at the cost of a store read per validation, open the repository with fresh reads:

```typescript
const repo = await memory.openRepository('legal', { freshVocabulary: true });
```

## Events & Hooks

```typescript
// Listen to lifecycle events
repo.on('entity:created', (event) => {
  console.log(`Created: ${event.payload.entity.label}`);
});

// Cancel operations with pre-mutation hooks
repo.onHook('entity:creating', (event) => {
  if (event.payload.input.entityType === 'secret') {
    return { cancel: true, reason: 'Secrets are not allowed' };
  }
  return {};
});
```

- **`search:index_failed`** (`{ entityId, error }`) — a committed entity create, update or delete whose `SearchProvider` update failed. Search indexing is best-effort: the write stands and the call does not reject; reindex the entity to repair the search index.
- **`delete:started`** is `{ repositoryId }`. Repository deletes do not count the repository first, so `delete:progress` carries the running counts removed so far (no totals), and `delete:completed` the counts actually removed.

## Error Handling

All errors extend `DeepMemoryError` with a `code` and actionable `suggestion`:

```typescript
import { EntityNotFoundError, VocabularyValidationError } from '@utaba/deep-memory';

try {
  await repo.getEntity('nonexistent');
} catch (err) {
  if (err instanceof EntityNotFoundError) {
    console.log(err.code);       // 'ENTITY_NOT_FOUND'
    console.log(err.suggestion);  // 'Check the entity ID is correct...'
  }
}
```

Errors worth handling specifically:

- **`RepositoryNotFoundError`** — every call on a repository that does not exist, or has been deleted, throws it, ahead of any not-found or empty answer. That includes a merge-mode `importRepository`.
- **`SlugConflictError`** (`SLUG_CONFLICT`) — another entity holds the slug. Creates and updates retry with the next slug suffix before this reaches you.
- **`BatchPartialFailureError`** (`BATCH_PARTIAL_FAILURE`) — `createEntities` / `createRelationships` validate every member first and write nothing if one fails validation. If a write fails after some members were stored, this error carries `created` (the stored members), `failedIndex` and `cause`. Resend only the members not in `created`: resending a stored member creates it again under a new id.
- **`TraversalValidationError`** — traversal options out of bounds (explore `depth` 1–3; findPaths `maxDepth` 1–5, `limit` 1–200, `offset` 0–1,000; traverse `limit` 1–200, `offset` 0–1,000), a relationship type or filter key that is not an identifier, or a projection of a reserved field. Checked before storage runs, on every provider.

## Export / Import

Portable repository archives with vocabulary migration:

```typescript
// Export
const archive = await memory.exportRepository('my-repo');

// Import into a new repository
await memory.importRepository(archive, {
  target: { mode: 'create', repositoryId: 'copy', config: { repositoryId: 'copy', label: 'Copy' } },
});

// Merge into an existing repository
await memory.importRepository(archive, {
  target: { mode: 'merge', repositoryId: 'existing' },
  vocabularyConflict: 'extend',  // 'reject' | 'extend' | 'prompt'
  entityConflict: 'skip',        // 'skip' | 'overwrite' | 'rename'
});
```

## Examples

See [`examples/`](examples/) for complete integration examples:

- **[Basic Usage](examples/basic-usage/)** — personal knowledge graph, legal domain vocabulary
- **[MCP Server](examples/mcp-server/)** — tool definitions for Model Context Protocol
- **[OpenAI Functions](examples/openai-functions/)** — function definitions for Chat Completions API
- **[Anthropic Tools](examples/anthropic-tools/)** — tool definitions for Messages API

## Status

Under active development. Not yet published to npm.

## License

Apache 2.0
