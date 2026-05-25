# @utaba/deep-memory-local-mcp-server

Local MCP server that exposes [@utaba/deep-memory](https://www.npmjs.com/package/@utaba/deep-memory) as Model Context Protocol tools. Gives AI agents (Claude Desktop, Claude Code, and any other MCP-capable client) persistent, structured memory backed by a knowledge graph — accessed over stdio.

## Quick start — Claude Desktop / Claude Code

Memory is only useful if it survives restarts. The recommended setup runs a local SQL Server in Docker — everything stays on your machine, the database survives reboots, and you don't have to manage anything once it's installed.

**Full step-by-step (Windows / Mac / Linux):** [quickstart-claude-desktop.md](https://github.com/TjWheeler/deep-memory/blob/main/quickstart-claude-desktop.md) — three installers + one config file, around 15 minutes.

The summary version: install Docker Desktop and Node.js, download the project ZIP, run `docker compose up sqlserver -d`, create the `deep-memory` database, then paste this into your MCP client's config:

**Mac / Linux:**

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "npx",
      "args": ["-y", "@utaba/deep-memory-local-mcp-server"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "claude-desktop",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "sqlserver",
        "DEEP_MEMORY_SQL_HOST": "localhost",
        "DEEP_MEMORY_SQL_PORT": "1435",
        "DEEP_MEMORY_SQL_DATABASE": "deep-memory",
        "DEEP_MEMORY_SQL_USER": "sa",
        "DEEP_MEMORY_SQL_PASSWORD": "DeepMem@Dev1234",
        "DEEP_MEMORY_SQL_TRUST_CERT": "true"
      }
    }
  }
}
```

**Windows** (the `cmd /c` wrapper is needed so the launcher can resolve `npx`):

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "@utaba/deep-memory-local-mcp-server"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "claude-desktop",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "sqlserver",
        "DEEP_MEMORY_SQL_HOST": "localhost",
        "DEEP_MEMORY_SQL_PORT": "1435",
        "DEEP_MEMORY_SQL_DATABASE": "deep-memory",
        "DEEP_MEMORY_SQL_USER": "sa",
        "DEEP_MEMORY_SQL_PASSWORD": "DeepMem@Dev1234",
        "DEEP_MEMORY_SQL_TRUST_CERT": "true"
      }
    }
  }
}
```

**Config file locations:**

| Client | Path |
|--------|------|
| Claude Desktop (Mac) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Claude Code | `.mcp.json` at your project root, or `~/.mcp.json` for global |

The password and port above match the bundled `docker-compose.yml` in the project repo — change them in both places if you customise the database setup. CosmosDB Gremlin is also supported; see the [project repository](https://github.com/TjWheeler/deep-memory) for that path.

> **Security — change the default password.** `DeepMem@Dev1234` is a publicly known development default. Anyone who can reach your machine on port 1435 can read your entire memory with it. Before you put anything personal or sensitive into the database, change the `SA_PASSWORD` / `MSSQL_SA_PASSWORD` in `docker-compose.yml` (and the matching `DEEP_MEMORY_SQL_PASSWORD` in the MCP config above) to a strong, unique password. The default is only safe when the database is bound to `localhost` on a trusted machine.

Quit and reopen the MCP client. The server should show as connected with around 28 memory tools.

## Test-only configuration (in-memory)

> **Use this only to verify the install works. Do not use it as your real memory — it is wiped every time the server restarts.**

If you just want to confirm the MCP server connects before going through the database setup, you can run with no storage at all:

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "npx",
      "args": ["-y", "@utaba/deep-memory-local-mcp-server"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "test",
        "DEEP_MEMORY_ACTOR_TYPE": "agent"
      }
    }
  }
}
```

(On Windows, use the `cmd /c npx ...` form from above.) Once you've confirmed the tools are wired up, switch to the SQL Server configuration above before storing anything you want to keep.

## Configuration reference

Environment variables passed via the MCP client's `env` block:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEP_MEMORY_ACTOR_ID` | `mcp-agent` | Actor ID stamped on provenance |
| `DEEP_MEMORY_ACTOR_TYPE` | `agent` | Actor type: `agent`, `human`, or `system` |
| `DEEP_MEMORY_STORAGE` | `memory` | `memory` (test only — wiped on restart) or `sqlserver` (recommended) |
| `DEEP_MEMORY_SQL_HOST` | — | SQL Server hostname (when `DEEP_MEMORY_STORAGE=sqlserver`) |
| `DEEP_MEMORY_SQL_PORT` | `1433` | SQL Server port. The bundled `docker-compose.yml` publishes the container on host port **1435** (to avoid clashing with any local SQL install on the default 1433); use `1435` for that path. For a different SQL Server instance, check the port that instance is listening on. |
| `DEEP_MEMORY_SQL_DATABASE` | — | Database name |
| `DEEP_MEMORY_SQL_USER` | — | SQL Server username |
| `DEEP_MEMORY_SQL_PASSWORD` | — | SQL Server password |
| `DEEP_MEMORY_SQL_SCHEMA` | `dbo` | SQL Server schema |
| `DEEP_MEMORY_SQL_TRUST_CERT` | `false` | Trust self-signed certificates (set `true` for local Docker) |
| `DEEP_MEMORY_EMBEDDINGS_BASE_URL` | — | Embeddings API URL (enables semantic search). See [quickstart-embeddings.md](https://github.com/TjWheeler/deep-memory/blob/main/quickstart-embeddings.md) for provider-specific recipes. |
| `DEEP_MEMORY_EMBEDDINGS_MODEL` | — | Embeddings model identifier |
| `DEEP_MEMORY_EMBEDDINGS_DIMENSIONS` | auto-detected | Embedding vector dimensionality. Set only when the model supports configurable dimensions (e.g. OpenAI `text-embedding-3-*`). |
| `DEEP_MEMORY_EMBEDDINGS_API_KEY` | — | API key for authenticated embeddings endpoints |

## Programmatic use

If you're embedding the server into your own code rather than launching it from an MCP client, install it as a dependency:

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-local-mcp-server
```

The package exports the same entry point its `bin` invokes — see the [project repository](https://github.com/TjWheeler/deep-memory) for examples.

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
- [Project repository](https://github.com/TjWheeler/deep-memory) — source, quickstarts, starter kits, and the document-indexing pipeline (run from a clone of the repo)
