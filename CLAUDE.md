# CLAUDE.md

Guidance for Claude (and other AI coding agents) working in this repository. Keep this file short on purpose — it is loaded into every session's context. When you need detail, follow the links rather than re-reading large docs end-to-end.

## What this project is

`@utaba/deep-memory` is a vocabulary-driven graph memory library for AI agents. It stores knowledge as typed entities and relationships governed by a vocabulary schema, with pluggable storage / search / embedding providers. The core package has zero runtime dependencies. The monorepo is pnpm + Turborepo, TypeScript strict mode.

If you have not yet, skim [README.md](README.md) once for the package map and architecture diagram. Do not re-read it every session — come back here.

## First: identify what the user is asking for

Most requests fall into one of three modes. Decide which, then jump to the matching section. Do not load docs from the other modes.

1. **Use deep-memory as a memory tool** — the user is running the MCP server and wants to create / query a knowledge graph (most common when the user is mid-conversation with you and just wants to remember things).
2. **Develop on deep-memory** — the user is editing this repository's source: packages, providers, MCP tools, indexer phases.
3. **Index documents into a graph** — the user wants to run the indexing pipeline to turn source documents into a populated repository.

If unclear, ask one short question. Do not load all three doc trees defensively.

## Mode 1 — Using deep-memory as a memory tool

The MCP server exposes ~29 tools prefixed `memory_*`. The canonical reference is [packages/mcp-server/README.md](packages/mcp-server/README.md) — read it the first time you need a tool, then rely on the tool descriptions that the MCP server itself sends.

Core workflow:

- `memory_list_repositories` → `memory_open_repository` (always open before entity / relationship work).
- `memory_get_vocabulary` *before* creating entities — it tells you the entity / relationship types and required properties. Skipping this is the most common cause of validation errors.
- For exploration, prefer `memory_explore_neighborhood` and `memory_find_paths` over `memory_get_graph`. The graph can be large; the README and the AI requirements doc explain the progressive-discovery model.

If the user wants to start a fresh repo, use a starter kit (`index-starterkits/{person,conversations,mining,council,legal}/vocabulary.md`). The starter kit's vocabulary doc is the right thing to read when bootstrapping a domain — it shows entity types, relationship types, and the patterns the vocabulary expects you to follow when you extend it.

For the design philosophy behind the tool surface (progressive discovery, relationship-first navigation, supersession chains, etc.) read [docs/ai-requirements.md](docs/ai-requirements.md). Read it once when you are designing a vocabulary or deciding how to model something — not on every memory operation.

## Mode 2 — Developing on deep-memory

Entry points by task:

| Task | Read first |
|------|------------|
| Understand the components and dependency flow | [docs/architecture.md](docs/architecture.md) |
| Add or change an MCP tool | [packages/mcp-server/README.md](packages/mcp-server/README.md) then the tool file under `packages/mcp-server/src/` |
| Touch storage (SQL Server / CosmosDB) | The provider's README under `packages/storage-*/README.md` |
| Touch embeddings | [packages/embeddings-openai/README.md](packages/embeddings-openai/README.md) |
| Touch the indexer pipeline | [packages/indexer/README.md](packages/indexer/README.md) plus the phase-specific guide under `docs/indexer-*.md` |
| Identity / dedup / labels / slugs | [docs/identity-pattern.md](docs/identity-pattern.md) |
| Provider usage telemetry | [docs/usage-tracking.md](docs/usage-tracking.md) |
| Write a changeset | [docs/changeset-guide.md](docs/changeset-guide.md) — **load before writing any `.changeset/*.md` file**; covers format, fixed-group bumps, and replaces git-history mining |

A complete documentation index sits in [docs/README.md](docs/README.md). Treat it as a table of contents — open it when you do not know which doc covers a topic, not as a doc to read in full.

### Coding conventions that catch agents out

These are the rules you are most likely to violate by default. Follow them without prompting.

- **No dynamic imports.** Never `await import(...)` or use dynamic `import()` — anywhere, including tests and node builtins. Always static top-level imports. Optional runtime deps go in `peerDependencies` with `peerDependenciesMeta.optional = true` and are still imported statically. If a dynamic import looks like it solves a circular dep, fix the circularity instead.
- **`packages/core` has zero runtime dependencies.** Do not add any. Utilities go inside the package.
- **No `any` / `unknown` as shortcuts.** Use real types. The codebase enables `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`.
- **No backward-compat shims.** The project is in active development. Change the code directly; do not leave deprecated wrappers, renamed re-exports, or `// removed` comments.
- **Typed errors only.** Throw from the hierarchy in `packages/core/src/core/errors.ts` — not generic `Error`.
- **Tests are co-located.** `*.test.ts` lives next to its source file, not in a `__tests__` folder.
- **Explicit `public` on class methods.** Do not rely on TypeScript's implicit-public default — write `public` alongside `private` / `protected` so intent is visible.

### Build / test commands

From the repo root:

```bash
pnpm install
pnpm build       # turbo — respects dependency order
pnpm test
pnpm typecheck
pnpm dev         # watch mode
```

Scope to one package with `pnpm --filter <package-name> <command>`. Prefer scoping when iterating — a full `pnpm build` is slow.

Node 22 or 24. pnpm 9+. CI tests both Node versions, so do not introduce features that only work on one.

## Mode 3 — Indexing documents

The indexer is its own MCP server (`packages/indexer-mcp-server`) with 9 phase-aware tools. Always start from [quickstart-indexer.md](quickstart-indexer.md) the first time, then use the phase-specific guides in `docs/indexer-*.md` only when the tool surface points you there.

The pipeline is phased — extraction → validation → consolidation → import → embeddings. Each phase has its own doc. Do not pre-load all of them; load the one for the phase you are in.

## Progressive discovery — the operating principle

This repo's documentation is deliberately fragmented because deep-memory itself is built around progressive discovery for AI agents. Apply the same principle to your own reading:

- **Summaries first.** This file, package READMEs, and `docs/README.md` are the index layer. Read them to know where to go.
- **Detail on demand.** Open the specific guide only when the current task needs it.
- **Do not preload.** A 50K-token session spent ingesting docs is a session that cannot reason about code. Aim to keep doc reading under 5K tokens unless the task genuinely requires deep design context.
- **Trust the tool surface.** When using the MCP server, the tool descriptions returned by `tools/list` are the authoritative spec — you do not need to re-read the README to call a tool.

If you find yourself unsure which doc to load, ask the user one short question rather than reading three.

## Things to avoid

- Do not invent new entity or relationship types without first calling `memory_get_vocabulary`. The repository's governance mode decides whether ad-hoc types are auto-approved — check before creating.
- Do not create a Conversation entity type "to track context." Provenance is tracked automatically on every mutation; a Conversation entity would duplicate it. See [docs/ai-requirements.md](docs/ai-requirements.md) section 2.6.
- Do not use `memory_get_graph` on a large repository to "see what's there." Use `memory_explore_neighborhood` from a known entity, or `memory_find_entities` with filters.
- Do not change SQL passwords or other secrets across files based on a single example in the README. The README's password is an example — confirm with the user before touching real config.
- Do not commit `.mcp.json` (it is gitignored). `.mcp.json.example` is the tracked template.

## License

Apache 2.0. See [LICENSE](LICENSE).
