# @utaba/deep-memory-local-mcp-server

Local MCP server that exposes [@utaba/deep-memory](https://www.npmjs.com/package/@utaba/deep-memory) as Model Context Protocol tools. Designed for AI agents (Claude Code, Claude Desktop, etc.) to interact with knowledge graphs over stdio.

> **Note:** Indexing pipeline tools live in a separate server — [`@utaba/deep-memory-indexer-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-mcp-server). This server focuses on memory repository operations only.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-local-mcp-server
```

## Claude Code / Desktop Integration

Add to `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["node_modules/@utaba/deep-memory-local-mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent"
      }
    }
  }
}
```

Restart Claude Code after editing `.mcp.json`.

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEP_MEMORY_ACTOR_ID` | `mcp-agent` | Actor ID stamped on provenance |
| `DEEP_MEMORY_ACTOR_TYPE` | `agent` | Actor type: `agent`, `human`, or `system` |

The server uses `InMemoryStorageProvider` and `InMemorySearchProvider` by default — all data is lost on restart. For persistent storage, wire up your own server using the core library directly with a storage provider like `@utaba/deep-memory-storage-sqlserver` or `@utaba/deep-memory-storage-cosmosdb`.

## Tools (28)

### Repository lifecycle (8)

| Tool | Description |
|------|-------------|
| `memory_create_repository` | Create a new repository with optional vocabulary and governance mode |
| `memory_open_repository` | Open a repository by ID or label — call first before entity/relationship operations |
| `memory_list_repositories` | List all available repositories |
| `memory_update_repository` | Update repository metadata — label, description, governance mode, similarity threshold |
| `memory_delete_repository` | Delete a repository (or only its contents, keeping vocabulary) |
| `memory_ensure_schema` | Ensure storage provider schema exists; no-op for in-memory, creates tables/indexes for persistent providers |
| `memory_validate_entities` | Audit entities against the vocabulary; returns issues fixable with `memory_update_entity` |
| `memory_validate_relationships` | Audit relationships against the vocabulary |

### Entity operations (6)

| Tool | Description |
|------|-------------|
| `memory_create_entities` | Create one or more entities (batched) |
| `memory_update_entity` | Update entityType, label, summary, properties, or data (RFC 7396 merge semantics) |
| `memory_get_entity` | Retrieve an entity by ID/slug with configurable detail level (brief / summary / full) |
| `memory_find_entities` | Search by label, type, or properties with pagination |
| `memory_delete_entities` | Delete one or more entities and their relationships (batched) |
| `memory_reembed_repository` | Re-embed all entities, optionally switching embedding model or dimensionality |

### Relationship operations (3)

| Tool | Description |
|------|-------------|
| `memory_create_relationships` | Create one or more relationships (edges) between entities (batched) |
| `memory_remove_relationships` | Remove one or more relationships (batched) |
| `memory_get_relationships` | Get all relationships for an entity with type/direction filters |

### Graph traversal and query (4)

| Tool | Description |
|------|-------------|
| `memory_get_graph` | Get the full graph for small repos — up to 200 entities per page with cursor |
| `memory_query_graph` | Vertex lookups, property projection, and multi-hop traversals in one tool |
| `memory_explore_neighborhood` | BFS neighbourhood exploration (depth 1-3) |
| `memory_find_paths` | Find paths between two entities |

### Search (1)

| Tool | Description |
|------|-------------|
| `memory_search_by_concept` | Semantic search by concept similarity (requires an `EmbeddingProvider`) |

### Vocabulary (2)

| Tool | Description |
|------|-------------|
| `memory_get_vocabulary` | Get the vocabulary definition for a repository |
| `memory_propose_vocabulary_extension` | Propose a new entity or relationship type |

### Stats and timeline (2)

| Tool | Description |
|------|-------------|
| `memory_get_stats` | Entity count, relationship count, type breakdowns |
| `memory_get_timeline` | Activity timeline for an entity |

### Portability (2)

| Tool | Description |
|------|-------------|
| `memory_import_repository` | Import a `.dkg` archive — `create` mode for a new repo, `merge` (default) into an existing one |
| `memory_export_repository` | Export a repository to a `.dkg` file on the local filesystem |

## Key Behaviours

- **Entity IDs are GUIDs**, with a deterministic `slug` (`{entityType}:{slugified-label}`) as a human-friendly secondary identifier. Tools accept either GUID or slug for entity references.
- **Relationship types** are normalised to `SCREAMING_SNAKE_CASE`. Agents can pass any casing (camelCase, kebab-case, etc.) and it will be normalised.
- **Repository lifecycle** — a repository must be created before it can be opened. Tools that operate on entities/relationships auto-open the repository if needed.

## Export / Import

Two paths are available:

**1. MCP tools (filesystem-based).** `memory_import_repository` reads a `.dkg` file from disk; `memory_export_repository` writes one. Use these when an agent needs to load a bundled sample, hand off a repo to another instance, or back up its memory. See the Portability row in the Tools table above.

**2. Core library APIs (programmatic).** Use these from application code when you need to pipe an archive to HTTP, S3, a zip stream, etc. — not just the local filesystem:

| Method | Use case |
|--------|----------|
| `exportRepository(id)` | Small repos — returns the full `ExportArchive` in memory |
| `exportRepositoryStream(id)` | Large repos — `AsyncGenerator<ExportStreamItem>` yielding manifest → vocabulary → entity chunks → relationship chunks |
| `importRepository(archive, options)` | Small repos — accepts a complete `ExportArchive` |
| `importRepositoryStream(header, chunks, options)` | Large repos — accepts `ImportStreamHeader` + `AsyncIterable<ImportChunk>` |

The streaming variants avoid buffering the entire repository in memory. The buffered methods are convenience wrappers that delegate to the streaming ones internally.

**Stream item order (export):** `manifest` → `vocabulary` → `entities` (1..n chunks) → `relationships` (1..n chunks). Chunk size is determined by the underlying `StorageProvider.exportAll()` implementation.

## See also

- [`@utaba/deep-memory`](https://www.npmjs.com/package/@utaba/deep-memory) — the underlying graph memory library
- [`@utaba/deep-memory-indexer-mcp-server`](https://www.npmjs.com/package/@utaba/deep-memory-indexer-mcp-server) — sibling MCP server for driving the indexing pipeline
