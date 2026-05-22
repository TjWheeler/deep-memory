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
