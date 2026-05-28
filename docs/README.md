# @utaba/deep-memory — Project Overview

A vocabulary-driven graph memory library for AI agents. Zero runtime dependencies in the core. TypeScript strict mode. pnpm monorepo with Turborepo.

## Monorepo Structure

| Package | Path | Description |
|---------|------|-------------|
| `@utaba/deep-memory` | `packages/core` | Core library — knowledge graph with vocabulary governance, pluggable providers, typed events. Dual CJS/ESM build via tsup. |
| `@utaba/deep-memory-embeddings-openai` | `packages/embeddings-openai` | OpenAI-compatible embeddings provider — works with vLLM, OpenAI, Azure, Ollama, etc. |
| `@utaba/deep-memory-storage-sqlserver` | `packages/storage-sqlserver` | SQL Server storage provider — persistent, multi-tenant graph storage. |
| `@utaba/deep-memory-storage-cosmosdb` | `packages/storage-cosmosdb` | CosmosDB Gremlin storage provider — native graph database with dual StorageProvider + GraphTraversalProvider. |
| `@utaba/deep-memory-storage-neo4j` | `packages/storage-neo4j` | Neo4j storage provider — native Cypher graph database with dual StorageProvider + GraphTraversalProvider, against Neo4j Community Edition over Bolt. |
| `@utaba/deep-memory-indexer` | `packages/indexer` | Document indexing pipeline — LLM extraction, validation, consolidation, and import. |
| `@utaba/deep-memory-indexer-llm-anthropic` | `packages/indexer-llm-anthropic` | Anthropic LLM provider for the indexer — native Messages API with prompt caching. |
| `@utaba/deep-memory-local-mcp-server` | `packages/mcp-server` | Local MCP server exposing deep-memory memory tools for AI agents. |
| `@utaba/deep-memory-indexer-mcp-server` | `packages/indexer-mcp-server` | Indexer MCP server — 9 phase-aware tools for driving the indexing pipeline. |

## Commands (from repo root)

```bash
pnpm install           # install all dependencies
pnpm build             # turbo — build all packages (respects dependency order)
pnpm test              # turbo — run all tests
pnpm typecheck         # turbo — typecheck all packages
pnpm dev               # turbo — watch mode for all packages
```

Or scope to a single package:

```bash
pnpm --filter @utaba/deep-memory test
pnpm --filter @utaba/deep-memory-local-mcp-server build
```

## Documentation

### Architecture & cross-cutting

- [Architecture](architecture.md) — Component architecture, dependency graph, data flows, and directory structure.
- [Entity Identity Pattern](identity-pattern.md) — How label, slug, type, and GUID work together to identify entities, and how to keep deduplication correct when labels collide.
- [Usage Tracking](usage-tracking.md) — Provider-agnostic cost/consumption telemetry. How to hook a sink on each provider for billing, rate limiting, or observability.
- [AI Requirements](ai-requirements.md) — Design principles and requirements from the AI agent perspective.

### Storage & embeddings providers

Each provider's canonical documentation lives in its package README. The `docs/` files below are short summaries that link to the same place.

- [SQL Server Storage Provider](../packages/storage-sqlserver/README.md) — Persistent multi-tenant graph storage backed by SQL Server.
- [CosmosDB Gremlin Storage Provider](../packages/storage-cosmosdb/README.md) — Native graph storage backed by Azure CosmosDB Gremlin API. Includes local emulator setup (Windows + WSL2) and Azure production deployment.
- [CosmosDB Gremlin Compatibility & Performance Notes](cosmosdb-gremlin-compatibility.md) — What we've verified works (and doesn't) in CosmosDB's Gremlin subset, plus the performance-critical operator differences. **Required reading before changing emitted Gremlin** in the compiler or any storage-cosmosdb query module.
- [CosmosDB Adaptive Import](storage-cosmosdb-adaptive-import.md) — How `importBulk` adapts concurrency to RU-constrained CosmosDB tiers: control loop, throttle detection via the connection's retry counter, circuit breaker, and operator visibility.
- [Neo4j Storage Provider](../packages/storage-neo4j/README.md) — Native graph storage backed by Neo4j Community Edition over Bolt. Implements both StorageProvider and GraphTraversalProvider; ships with Docker Compose for local dev and AuraDB-compatible URIs for production.
- [Embeddings Provider (OpenAI)](../packages/embeddings-openai/README.md) — Setup and usage for the OpenAI-compatible embeddings provider.
- [Embeddings Quickstart](../quickstart-embeddings.md) — Wiring an embeddings provider into the MCP server (bundled vLLM, OpenAI, Ollama, Azure OpenAI) to enable semantic search.

### MCP servers

- [Local MCP Server](../packages/mcp-server/README.md) — MCP server exposing deep-memory memory tools for AI agents (Claude Code, Claude Desktop, etc.).
- [Indexer MCP Server](../packages/indexer-mcp-server/README.md) — Separate MCP server with 9 phase-aware tools for driving the indexing pipeline.

### Indexer pipeline

- [Indexer Pipeline](../packages/indexer/README.md) — Document indexing pipeline: phases, MCP-driven quick start, programmatic usage, multi-worker routing, configuration reference, AI–human collaboration.
- [Indexer Quickstart](../quickstart-indexer.md) — Step-by-step guide to running your first indexing pipeline.
- [Indexer LLM Providers](indexer-llm-providers.md) — Pluggable LLM backends, Anthropic prompt caching provider, custom provider guide.
- [Indexer Validation](indexer-validation.md) — Model validation, output quality scoring, domain complexity guide, and model comparison workflow.
- [Indexer Extraction Guide](indexer-extraction-guide.md) — Practical guidance for model selection, chunk sizing, output token limits, progressive context tuning, cost management, and troubleshooting large document extraction.
- [Post-Extraction Review Guide](indexer-review-guide.md) — Repeatable process for spot-checking and correcting extraction outputs before consolidation. Quality thresholds, common patterns by domain, worked examples.
- [Indexer Consolidation Guide](indexer-consolidation-guide.md) — Consolidation phase: entity deduplication algorithm, Jaro-Winkler matching, merge confidence review, diagnostics, and troubleshooting common issues.
- [Indexer Embeddings Guide](indexer-embeddings-guide.md) — Embeddings phase: configuration, cost estimation, progress monitoring, similarity threshold tuning, local vs cloud model comparison.
- [Indexer Troubleshooting](indexer-troubleshooting.md) — Common issues and fixes for every pipeline phase.
- [Starter Kit Creation Guide](indexer-starterkit-guide.md) — How to create custom starter kits for new domains.
- [Source Content Conversion](source-content-conversion.md) — Converting source documents (PDF, etc.) to Markdown for indexing.

### Local LLM models

- [Local Model Setup](local-model-setup.md) — llama.cpp (recommended, Windows native) and vLLM (Docker) worker setup. Covers model download, launch commands, VRAM budgets, KV cache quantisation, and troubleshooting.
- [Local Model Performance Research (Apr 2026)](index-model-performance-apr-2026.md) — Benchmark notes on local models for structured JSON extraction on RTX 5090, targeting Claude Haiku 4.5 quality.

### Operations

- [Import & Export Guidance](import-export-guidance.md) — Workflows for building, shipping, and updating knowledge repositories in production.
- [Troubleshooting](troubleshooting.md) — Cross-cutting issues across extraction, embeddings, and import. Symptoms, diagnoses, fixes.
- [Publishing Guide](publishing-guide.md) — How to publish packages to npm under the `@utaba` organisation.
- [Changeset Guide](changeset-guide.md) — **AI agents: load this before writing a changeset.** Self-contained reference for the changeset format, fixed-group versioning, bump-level rules, and anti-patterns. Replaces ad-hoc git-history mining.

## Coding Conventions

- **No dynamic imports.** Never use `await import(...)` / dynamic `import()` — always static top-level imports, in source and tests. Dynamic imports hide real dependencies from the module graph and lead to packaging bugs (e.g. a package shipping without declaring a runtime dep, breaking consumers at load time). If a dep is truly optional, declare it in `peerDependencies` with `peerDependenciesMeta.optional = true` and still import it statically; let the module loader fail loudly if it's missing. Node builtins (`node:fs/promises`, etc.) must also be static imports. If a dynamic import looks necessary to break a circular dep, fix the circularity instead.
- **Zero runtime dependencies in `packages/core`.** All utilities are self-contained.
- **No `any` / `unknown` as shortcuts.** Use real types.
- **No backward-compat shims.** Project is in active development — change the code directly.
- **Typed errors only.** Use the hierarchy in `packages/core/src/core/errors.ts`.
- **Tests co-located.** `*.test.ts` next to the source.
- **TypeScript strict mode** — `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` all enabled.
- **Explicit `public` keyword on class methods.** Public methods must be declared with the `public` keyword — no relying on TypeScript's implicit-public default. Makes intent visible alongside `private` / `protected` members and surfaces accidental public exposure during review.

## Starter Kits

Starter kits are pre-built vocabularies and indexing processes for common domains. Each kit includes:

- **README** — Overview (purpose, use cases, governance) + manual indexing process via MCP tools
- **Vocabulary** — Entity types and relationship types with property definitions
- **Domain Guidance** — Extraction prompt guidance for AI agents (consumed by the automated pipeline)

Located in `index-starterkits/` at the repository root:

| Domain | Path | Purpose |
|--------|------|---------|
| Mining Equipment | `index-starterkits/mining/` | Fleet knowledge graphs — equipment specs, components, fluids, maintenance, troubleshooting, truck-shovel matching |
| Person | `index-starterkits/person/` | Contact networks, team directories, genealogy, biographical timelines |
| Conversations | `index-starterkits/conversations/` | Long-term AI memory — interests, preferences, goals, decisions, contextual notes from conversations |
| Council | `index-starterkits/council/` | Local government planning — zones, land use permissibility, development standards, signage, waterway structures, community infrastructure |

Use a starter kit when your knowledge graph focuses on that domain. Kits are extensible—agents can propose new entity and relationship types at indexing time in `open` governance mode.
