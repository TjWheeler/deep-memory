# @utaba/deep-memory

A vocabulary-driven graph memory library for AI agents. Give your AI structured, persistent memory that it can read, write, and traverse with zero friction.

## Why Vocabulary-Driven?

AI agents working with knowledge graphs face a cold-start problem: before storing a single fact, they need to understand what entity types exist, what properties each type has, what relationship types connect them, and what constraints apply. Without this, every interaction starts with guesswork, inconsistency, and wasted tokens.

Deep-memory solves this with **vocabulary governance**. When an agent opens a repository, the first thing it sees is the vocabulary: a complete schema of entity types, relationship types, property definitions, and relationship constraints. This means:

- **No guesswork.** The agent knows exactly what types exist and what properties to set. It can create an entity in a single tool call.
- **No inconsistency.** Validation catches invalid types and missing required properties before they enter the graph. Two agents working on the same repository produce structurally consistent data.
- **No friction when extending.** In `open` governance mode, the agent proposes a new type and it is auto-approved with deduplication. The agent never stops working to wait for approval.
- **Efficient token usage.** The vocabulary is a compact schema, not thousands of example documents. An agent can internalize the full vocabulary in a few hundred tokens and then work confidently.

The result: an AI agent can go from opening a repository to creating entities and traversing relationships in seconds, with no training data, no few-shot examples, and no trial-and-error.

## A note on getting started quickly

This repo has been designed to provide detailed documentation that AI can use.  The AI can help guide the setup and configuration and get you started.

**Pick a quickstart and paste its prompts into Claude Code:**

- [quickstart-inmemory.md](quickstart-inmemory.md) — zero setup; the graph lives in memory. Fastest 2-minute path.
- [quickstart-sqlserver.md](quickstart-sqlserver.md) — persistent storage in SQL Server. Bundled Docker Compose for local use.
- [quickstart-cosmosdb.md](quickstart-cosmosdb.md) — Azure CosmosDB Gremlin API (local emulator on Windows, or an Azure account).
- [quickstart-indexer.md](quickstart-indexer.md) — build your own knowledge graph from source documents via the indexing pipeline.

**Not a developer? Using Claude Desktop instead of Claude Code?**

- [quickstart-claude-desktop.md](quickstart-claude-desktop.md) — no coding, no git, no build. Three installers + one config file. ~15 minutes.

## Packages

| Package | Path | Description |
|---------|------|-------------|
| `@utaba/deep-memory` | `packages/core` | Core library — zero runtime deps, dual CJS/ESM via tsup |
| `@utaba/deep-memory-embeddings-openai` | `packages/embeddings-openai` | OpenAI-compatible embeddings provider (vLLM, OpenAI, Azure, Ollama) |
| `@utaba/deep-memory-storage-sqlserver` | `packages/storage-sqlserver` | SQL Server storage provider — persistent, multi-tenant graph storage |
| `@utaba/deep-memory-storage-cosmosdb` | `packages/storage-cosmosdb` | CosmosDB Gremlin storage + graph traversal provider |
| `@utaba/deep-memory-indexer` | `packages/indexer` | Document indexing pipeline — LLM extraction, validation, consolidation, import |
| `@utaba/deep-memory-indexer-llm-anthropic` | `packages/indexer-llm-anthropic` | Anthropic LLM provider for indexer — prompt caching + native Messages API |
| `@utaba/deep-memory-indexer-mcp-server` | `packages/indexer-mcp-server` | Indexer MCP server — 9 phase-aware tools for the indexing pipeline |
| `@utaba/deep-memory-local-mcp-server` | `packages/mcp-server` | Local MCP server exposing deep-memory memory tools for AI agents |

## Deep-Memory Library

The core `@utaba/deep-memory` library provides a vocabulary-driven knowledge graph with typed entities, relationships, property validation, and pluggable storage/search/embedding providers. Zero runtime dependencies. The local MCP server (`@utaba/deep-memory-local-mcp-server`) exposes 20+ tools for AI agents to create repositories, manage entities and relationships, traverse graphs, and perform semantic search. It serves both as a reference integration and a production-ready interface for testing and working with knowledge graphs.

See [docs/README.md](docs/README.md) for detailed architecture, provider setup, and API documentation.

## Document Indexing Pipeline

Note: The Indexing Pipeline is optional.  You can use and populate a memory graph using the AI without it.  The indexing pipeline is most useful when you have documents you want to import.

The indexer packages (`@utaba/deep-memory-indexer`, `@utaba/deep-memory-indexer-mcp-server`, `@utaba/deep-memory-indexer-llm-anthropic`) provide an AI-driven pipeline for transforming source documents into structured knowledge graphs. The pipeline handles document analysis, multi-model LLM extraction, quality validation, cross-document entity deduplication, repository import, and embedding generation. The indexer MCP server exposes 9 phase-aware tools that guide an AI agent through the entire process — from scanning source documents to a query-ready knowledge graph.

**Key features:**
- Multi-worker extraction (local + cloud models in parallel)
- Three-tier validation (structural, LLM-verified, human-reviewed)
- Cost tracking and estimation at every phase
- Starter kits for common domains
- Progressive chapter extraction for large documents
- Prompt caching with the Anthropic provider (up to 88% savings on repeated system prompts)

See [docs/README.md](docs/README.md) for the full indexing pipeline documentation, including quickstart, model selection, and troubleshooting.

## Starter Kits

Starter kits are pre-built vocabularies for common domains. Each kit defines entity types, relationship types, property schemas, and an indexing process so the agent can begin populating a knowledge graph immediately.

| Domain | Path | Purpose |
|--------|------|---------|
| Mining Equipment | `index-starterkits/mining/` | Fleet knowledge graphs — equipment specs, components, fluids, maintenance, troubleshooting, truck-shovel matching |
| Council | `index-starterkits/council/` | Local government planning — zones, land use permissibility, development standards, signage, community infrastructure |
| Person | `index-starterkits/person/` | Contact networks, team directories, genealogy, biographical timelines |
| Conversations | `index-starterkits/conversations/` | Long-term AI memory — interests, preferences, goals, decisions, contextual notes |
| Legal | `index-starterkits/legal/` | Contract knowledge — parties, clauses, obligations, rights, definitions |

Each starter kit contains:
- **`README.md`** — Overview (purpose, use cases, governance) + manual indexing process via MCP tools
- **`vocabulary.md`** — Entity types and relationship types with property definitions
- **`domain-guidance.md`** — Domain-specific extraction guidance for AI agents (consumed by the automated pipeline)

To create a repository from a starter kit, tell your AI agent:

> *"Create a new deep memory repository using the Person starter kit."*

Starter kits are extensible. In `open` governance mode, the agent can propose new entity and relationship types at any time.

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) 22 or 24 (the supported LTS pair — CI tests both)
- [pnpm](https://pnpm.io/) 9+
- [Docker](https://www.docker.com/) and Docker Compose

### 1. Start the Infrastructure

The repository includes a `docker-compose.yml` that provisions the required services:

```bash
# Start SQL Server (required for persistent storage)
docker compose up sqlserver -d
```

This starts a SQL Server 2022 Developer Edition container on port **1434**. The database schema is created automatically when the MCP server connects for the first time.

If you have an NVIDIA GPU and want semantic search (concept search, vocabulary deduplication via embeddings), also start the embeddings service:

```bash
# Start both SQL Server and the vLLM embeddings server
docker compose up -d
```

The vLLM service serves the [Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B) model on port **8010**. This is optional — without it, deep-memory falls back to string similarity for vocabulary deduplication, and `memory_search_by_concept` is unavailable.

### 2. Install and Build

```bash
pnpm install
pnpm build
```

### 3. Create the Database

Once SQL Server is healthy, connect with your preferred SQL tool and create a database (e.g. `deep-memory`). The table schema is created automatically by the storage provider on first connection.

### 4. Configure the MCP Server

The MCP server is a local process that exposes deep-memory as [Model Context Protocol](https://modelcontextprotocol.io/) tools over stdio. It is intended to run locally alongside your AI agent (Claude Code, Claude Desktop, etc.) to let the agent create and work with graph memory repositories. It also serves as a reference integration for embedding deep-memory into your own applications.

Add the following to your `.mcp.json` (project root or `~/.mcp.json` for global):

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["<path-to-repo>/packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "sqlserver",
        "DEEP_MEMORY_SQL_HOST": "localhost",
        "DEEP_MEMORY_SQL_PORT": "1434",
        "DEEP_MEMORY_SQL_DATABASE": "deep-memory",
        "DEEP_MEMORY_SQL_USER": "sa",
        "DEEP_MEMORY_SQL_PASSWORD": "DeepMem@Dev1234",
        "DEEP_MEMORY_SQL_SCHEMA": "dbo",
        "DEEP_MEMORY_SQL_TRUST_CERT": "true",
        "DEEP_MEMORY_EMBEDDINGS_BASE_URL": "http://localhost:8010",
        "DEEP_MEMORY_EMBEDDINGS_MODEL": "Qwen/Qwen3-Embedding-8B"
      }
    }
  }
}
```

Security Note: Consider changing the SQL Password in the config and the docker server setttings.  

#### MCP Server Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEP_MEMORY_ACTOR_ID` | `mcp-agent` | Actor ID stamped on provenance metadata |
| `DEEP_MEMORY_ACTOR_TYPE` | `agent` | Actor type: `agent`, `human`, or `system` |
| `DEEP_MEMORY_STORAGE` | `memory` | Storage backend: `memory` (in-memory, data lost on restart) or `sqlserver` |
| `DEEP_MEMORY_SQL_HOST` | — | SQL Server hostname |
| `DEEP_MEMORY_SQL_PORT` | `1433` | SQL Server port |
| `DEEP_MEMORY_SQL_DATABASE` | — | Database name |
| `DEEP_MEMORY_SQL_USER` | — | SQL Server username |
| `DEEP_MEMORY_SQL_PASSWORD` | — | SQL Server password |
| `DEEP_MEMORY_SQL_SCHEMA` | `dbo` | SQL Server schema |
| `DEEP_MEMORY_SQL_TRUST_CERT` | `false` | Trust self-signed certificates (set `true` for local dev) |
| `DEEP_MEMORY_EMBEDDINGS_BASE_URL` | — | Embeddings API URL (enables semantic search) |
| `DEEP_MEMORY_EMBEDDINGS_MODEL` | — | Embeddings model identifier |
| `DEEP_MEMORY_EMBEDDINGS_API_KEY` | — | API key for authenticated embeddings endpoints |
| `DEEP_MEMORY_EXPORT_DIR` | `./exports` | Directory for exported repository archives |

> **Note:** If you omit the `DEEP_MEMORY_EMBEDDINGS_*` variables, the server runs without semantic search. Vocabulary deduplication falls back to Jaro-Winkler string similarity. If you omit the `DEEP_MEMORY_STORAGE` variable (or set it to `memory`), the server uses in-memory storage and all data is lost when the process stops.

### 5. Start Using It

Once the MCP server is configured, your AI agent has access to 20+ tools for creating repositories, managing entities and relationships, traversing the graph, and searching. The fastest way to get started is with a starter kit — tell your agent to create a repository using one of the kits above.

## Architecture

```
┌────────────────────────────────────────────────────────────────┐
│                         DeepMemory                             │
│  (top-level facade: repository lifecycle, export/import)       │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │                    MemoryRepository                      │  │
│  │  (working surface for a single knowledge graph)          │  │
│  │                                                          │  │
│  │  EntityManager ─── RelationshipManager                   │  │
│  │       │                    │                              │  │
│  │       └──── VocabularyEngine ───┘                        │  │
│  │                                                          │  │
│  │  GraphTraversal ─── SearchOrchestrator                   │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  EventBus ── ProvenanceTracker ── Portability (export/import)  │
└───────────────────────────┬────────────────────────────────────┘
                            │
             ┌──────────────┼──────────────┐
             ▼              ▼              ▼
     StorageProvider  SearchProvider  EmbeddingProvider
      (required)       (optional)      (optional)
```

**Provider pattern:** Storage is the only required provider. The SQL Server provider gives you persistent, multi-tenant graph storage. Search and embedding providers are optional — without them, you still get full CRUD, graph traversal, and string-based vocabulary deduplication.

For detailed architecture documentation, see [docs/architecture.md](docs/architecture.md).

## Commands

```bash
pnpm install           # install all dependencies
pnpm build             # build all packages (turbo)
pnpm test              # run all tests
pnpm typecheck         # typecheck all packages
pnpm dev               # watch mode
```

Scope to a single package:

```bash
pnpm --filter @utaba/deep-memory test
pnpm --filter @utaba/deep-memory-local-mcp-server build
```

## Documentation

> **AI Agents:** For detailed guidance on using the deep-memory tools and indexing pipeline effectively, see [docs/README.md](docs/README.md). This includes architecture details, provider setup, indexing pipeline documentation, model selection guides, and troubleshooting.

**Core Library:**
- [Architecture](docs/architecture.md) — Component architecture, dependency graph, data flows
- [AI Requirements](docs/ai-requirements.md) — Design principles from the AI agent perspective
- [SQL Server Storage Provider](packages/storage-sqlserver/README.md) — Persistent storage setup and configuration
- [CosmosDB Storage Provider](packages/storage-cosmosdb/README.md) — Native graph storage backed by Azure CosmosDB (includes emulator + production deployment)
- [Embeddings Provider (OpenAI)](packages/embeddings-openai/README.md) — OpenAI-compatible embeddings setup
- [Local MCP Server](packages/mcp-server/README.md) — MCP server tool reference (28 tools)
- [Import & Export](docs/import-export-guidance.md) — Repository portability workflows

**Indexing Pipeline:**
- [Indexer Quickstart](quickstart-indexer.md) — Step-by-step first pipeline walkthrough
- [Indexer Pipeline](packages/indexer/README.md) — Full pipeline architecture, phases, and workflow
- [Indexer MCP Server](packages/indexer-mcp-server/README.md) — 9 phase-aware tools reference
- [Extraction Guide](docs/indexer-extraction-guide.md) — Model selection, chunk tuning, cost management
- [Validation Guide](docs/indexer-validation.md) — Model comparison, quality scoring, full validation
- [Consolidation Guide](docs/indexer-consolidation-guide.md) — Entity deduplication and merge review
- [Embeddings Guide](docs/indexer-embeddings-guide.md) — Embedding generation and semantic search tuning
- [Starter Kit Guide](docs/indexer-starterkit-guide.md) — Creating custom domain starter kits
- [Troubleshooting](docs/indexer-troubleshooting.md) — Common issues and fixes for every phase
- [Post-Extraction Review](docs/indexer-review-guide.md) — Quality review process
- [LLM Providers](docs/indexer-llm-providers.md) — Pluggable LLM backends
- [Local Model Setup](docs/local-model-setup.md) — llama.cpp and vLLM worker setup
- [Source Content Conversion](docs/source-content-conversion.md) — PDF to Markdown conversion
- [Publishing Guide](docs/publishing-guide.md) — Publishing packages to npm

## About Us

Deep Memory is built and maintained by [Utaba](https://utaba.ai).

A full production implementation of Deep Memory is integrated into the [Universal Context Manager (UCM)](https://ucm.utaba.com.au) — our AI productivity platform for enterprise customers.

If you are interested in working with us, please reach out:

- [Contact Us](https://utaba.ai/contact)
- [Email Us](mailto:hello@utaba.ai)

## License

Apache 2.0. See [LICENSE](LICENSE).
