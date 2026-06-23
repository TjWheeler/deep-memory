# Code Graph — using Deep Memory to help AI work on this codebase

> **This is optional.** You do **not** need it to install, build, use, or contribute to deep-memory.
> It's a worked example — and a developer convenience — that shows how an AI assistant can use
> Deep Memory itself to understand a codebase. Skip it entirely and everything else still works.

## What it is, in plain language

The **code graph** is a small map of this repository: its packages, the pluggable providers, the
MCP tools, and the docs and tests — and how they all connect. A script reads the source code and
writes that map into a local graph database (Neo4j). Nothing is sent to the cloud, no AI model is
called, and it **costs nothing to build**.

Why bother? Because some questions are slow to answer by searching through files one by one, but
instant for a graph:

- *"If I change the `StorageProvider` interface, which implementations and tests will break?"*
- *"Does the `core` package secretly depend on anything at runtime?"* (it must not)
- *"Which MCP tools change data versus only read it?"*
- *"Which documentation mentions this thing I'm about to edit?"*

An AI assistant working on the repo can ask the graph these questions in **one step** instead of
running many searches — so it spends less effort finding things and more effort getting the change
right.

## Why it's an example of Deep Memory

This repository **is** the Deep Memory library. The code graph uses that very library to store a
knowledge graph *about the library's own source code*. So it doubles as a real, self-contained
demonstration: the same technique works for **any** codebase, not just this one. (The approach was
first proven on a large production application, then brought back here — see *How it works*.)

## Why it is NOT part of the build

Building the graph needs a local Neo4j database running, which most people won't have set up — and
which has nothing to do with shipping the library. So the code graph is **deliberately kept
separate from `pnpm build`**. The normal build never depends on it and can never be broken by it.
You build the graph only when you choose to, by running one command.

---

## Try it (about 5 minutes)

### 1. Prerequisites

```bash
pnpm install
pnpm build      # the rebuild script imports the built packages
```

Start a local Neo4j (the repo ships a Docker Compose file — see [quickstart-neo4j.md](../quickstart-neo4j.md)):

```bash
docker compose -f docker-compose.neo4j.yml up -d
docker compose -f docker-compose.neo4j.yml ps   # wait for STATUS: healthy
```

That gives you Neo4j on `bolt://localhost:7687`, a browser at <http://localhost:7474>, and the
development credentials `neo4j` / `DeepMem-Dev-1234`.

### 2. Build the graph

```bash
pnpm code-graph:rebuild
```

It reads the repo and writes the graph into Neo4j in a second or two. It is **safe to run as often
as you like** — it only writes what actually changed (re-running with no changes writes nothing),
and it never calls an embedding model, so it is free. The output prints the graph's size plus a few
sample insights, e.g.:

```
[code-graph] extracted 9 packages, 6 contracts, 10 impls, 38 tools, 55 docs, 56 tests, 186 modules, 24 error types
[code-graph] entities  +0 ~0 -0 (=392 unchanged)
[code-graph] core zero-runtime-dependency invariant: HOLDS (0 external runtime/peer deps)
[code-graph] provider contracts and their implementations:
  4   StorageProvider
  ...
  0   LockProvider  (no implementation)
[code-graph] source files by import fan-in (most depended-on — biggest blast radius):
  31  packages/mcp-server/src/tools/base/BaseToolController.ts
  ...
[code-graph] MCP tools with a covering test: 6/38
[code-graph] source modules with no covering test: 108/186
[code-graph] DEFINES edges: 80 (80 constructs bridged to their defining file)
[code-graph] import cycles: none (the Module→Module import graph is acyclic)
[code-graph] provenance: d63d5f7 (main) built 2026-06-23T…
```

> If a cycle exists, that line instead reads `N import cycle(s) detected (M modules in a cycle)`
> followed by each cycle's file chain — a real defect to fix, since the project forbids circular deps.

### 3. Use it

> For a terse, copy-paste query reference (recipes, slugs, caveats) — the doc to load when you
> just need to *query* — see **[code-graph-usage.md](code-graph-usage.md)**.

The easiest way is through the **deep-memory MCP server** (already configured in this repo's
`.mcp.json`), so your AI assistant can query it directly. Point it at the code-graph repository
first:

- **Repository id:** `d33c0de0-9a1b-4c2d-8e3f-1a2b3c4d5e6f`
- **Repository label:** `Deep Memory Codebase Architecture`

Open it with `memory_open_repository`, then ask questions like *"what implements `StorageProvider`?"*
or *"which tools mutate state?"*. The assistant uses tools such as `memory_explore_neighborhood`
(blast radius), `memory_find_entities`, and `memory_query_graph` to answer.

> **No semantic search here.** This graph is built without embeddings, so `memory_search_by_concept`
> won't find anything for it. Navigate by entity type, by exact name (slug), or by following
> relationships — not by fuzzy text search.

You can also explore visually in the Neo4j browser at <http://localhost:7474>, or run raw Cypher.

---

## What's in the graph (the model)

Everything below is derived **deterministically from the source** — no AI, no guessing.

### Entities (nodes)

| Type | What it represents | Mined from |
|------|--------------------|-----------|
| `Package` | A workspace package (the 9 here) or an external npm package one of them depends on at runtime. | every `package.json` |
| `ProviderContract` | A pluggable provider **interface** — the seam an implementation plugs into (`StorageProvider`, `SearchProvider`, `EmbeddingProvider`, `GraphTraversalProvider`, `LockProvider`, `LLMProvider`). | `export interface *Provider` declarations |
| `ProviderImpl` | A concrete provider **implementation** (e.g. `SqlServerStorageProvider`, `CosmosDbProvider`, `Neo4jStorageProvider`). | `implements <*Provider>` clauses, plus structural conformance (a `*Provider`-named class that declares a contract's full required surface but omits the clause) |
| `McpServer` | An MCP server (the local memory server and the indexer server). | the two server packages |
| `McpTool` | A tool an AI can call (e.g. `memory_create_entities`, `indexing_execute`); flagged `mutates` if it writes. | each tool's `get name()` |
| `Doc` | A markdown doc (under `docs/`, the root quickstarts/README, and each package README). | the markdown files |
| `Test` | A co-located test file. | `*.test.ts` / `*.spec.ts` |
| `Module` | A non-test source file — the file-level layer beneath the package graph. Carries a `package` property, a `throwsRawError` flag, and an `inImportCycle` flag (set when the file is part of a circular import). | every non-test `packages/*/src/**/*.ts` |
| `ErrorType` | An exported error class in the typed-error hierarchy (e.g. `RepositoryNotFoundError`). | exported `class … extends *Error` |

### Relationships (edges)

| Edge | Meaning |
|------|---------|
| `Package ─DEPENDS_ON_PACKAGE→ Package` | declared dependency (the `depType` says runtime / peer / dev) |
| `ProviderImpl ─IMPLEMENTS→ ProviderContract` | the class implements the interface; `detection` says whether it was found via a nominal `implements` clause or inferred structurally |
| `Package ─CONTAINS→ ProviderContract \| ProviderImpl \| McpServer \| ErrorType` | which package owns the construct (Modules are excluded — see caveats) |
| `McpServer ─ADVERTISES→ McpTool` | the server exposes the tool |
| `Module ─DEFINES→ ProviderContract \| ProviderImpl \| McpServer \| McpTool \| ErrorType` | the file that declares the construct — the bridge from the file tier to the architectural tier (a construct ←DEFINES— Module —IMPORTS→ its importers) |
| `Doc ─DOCUMENTS→ ProviderContract \| ProviderImpl \| McpServer \| McpTool \| Module` | a markdown link to a source file (precise); a link to a provider/server/tool file resolves to that construct, any other `.ts` to its Module |
| `Doc ─MENTIONS→ ProviderContract \| ProviderImpl \| ErrorType` | a symbol/error-class name in prose (broader) |
| `Doc ─DESCRIBES→ Package` | a package README documents its own package (the reliable doc↔package link) |
| `Test ─COVERS→ ProviderImpl \| ProviderContract \| McpTool \| Module` | the test imports the symbol (provider/tool) or resolves a relative import to a source file (Module); `role` separates the `subject` (matches the test filename) from a `fixture` — so "which tools/files have no test" is a query |
| `Module ─IMPORTS→ Module \| Package` | a file imports another file (intra-repo, resolved) or a package (bare import) — file-level blast radius |
| `Module ─THROWS→ ErrorType` | a file constructs/throws that error (`throw new XError()`) |
| `ErrorType ─EXTENDS→ ErrorType` | subclass → superclass — the catchability chain |

The most useful headline query is the **`core` zero-runtime-dependency invariant**: `core` should
have *no* outgoing runtime/peer `DEPENDS_ON_PACKAGE` edge. The graph turns that rule into a check
you can run, rather than a convention you hope holds.

A second invariant rides on the file tier: **no import cycles**. The rebuild runs Tarjan's
strongly-connected-components over the `Module ─IMPORTS→ Module` graph and flags every file in a
cycle with `inImportCycle: true` (and logs the cycle). The project forbids circular deps, so any
hit is a real defect — `memory_query_graph` on `Module` filtered by `inImportCycle` surfaces them.

---

## How it works (for maintainers and AI agents)

- **Deterministic extraction, no LLM.** Each layer is mined straight from the source: `package.json`
  for the dependency graph, `implements` clauses *and* structural member-conformance (via `ts-morph`)
  for the provider seam, each tool's `get name()` literal for the tool surface, markdown links/symbols
  for docs, import declarations for tests (resolved against providers, tool classes, *and* the source
  files they import — Test→Module COVERS), per-file import/export specifiers for the module graph,
  `throw new` sites for THROWS, and `extends *Error` for the typed-error hierarchy. Each construct's
  defining file becomes a `DEFINES` edge, and Tarjan's SCC over the module-import graph flags import
  cycles (`inImportCycle`) — both pure graph analysis over the already-extracted data, still no model.
- **Build provenance.** Each run stamps the repository metadata with the git commit, branch, and
  dirty flag the graph reflects, plus a `builtAt` timestamp — so a consumer can tell how stale the
  graph is and against which commit (written only when something actually changed).
- **Delta reconciliation.** Every node gets a deterministic id (so the same logical thing always maps
  to the same graph node) and a content fingerprint. A run re-extracts the whole desired graph, diffs
  it against what's in Neo4j, and writes only the difference. That makes it **idempotent**
  (re-running with no source change writes nothing), **self-healing** (any drift is corrected), and
  always reflecting your **working tree** (uncommitted edits included).
- **No embeddings, by design.** The rebuild script wires no embedding provider, so writing entities
  computes no vectors and costs nothing. The trade-off is that semantic search is disabled for this
  repo (see above) — which is fine, because a code graph is navigated by structure, not by fuzzy text.
- **The vocabulary evolves in place.** Adding or changing an entity/relationship type updates the
  stored schema on the next run without rebuilding the data.

### Files

| File | Role |
|------|------|
| [scripts/code-graph/vocabulary.ts](../scripts/code-graph/vocabulary.ts) | The repo id/label/constants and the graph schema (entity + relationship types). |
| [scripts/code-graph/extract-packages.ts](../scripts/code-graph/extract-packages.ts) | Reads every `package.json` → packages + their dependency edges. |
| [scripts/code-graph/extract-providers.ts](../scripts/code-graph/extract-providers.ts) | ts-morph: provider interfaces and the classes that implement them. |
| [scripts/code-graph/extract-tools.ts](../scripts/code-graph/extract-tools.ts) | ts-morph: each MCP tool's wire name, server, and whether it mutates. |
| [scripts/code-graph/extract-docs.ts](../scripts/code-graph/extract-docs.ts) | Markdown: titles, source links (DOCUMENTS), and symbol mentions (MENTIONS). |
| [scripts/code-graph/extract-tests.ts](../scripts/code-graph/extract-tests.ts) | ts-morph: the symbols each co-located test imports and the source files its relative imports resolve to (COVERS → ProviderImpl/Contract/McpTool/Module). |
| [scripts/code-graph/extract-modules.ts](../scripts/code-graph/extract-modules.ts) | ts-morph: per-file imports/re-exports (IMPORTS) and `throw new` sites (THROWS / `throwsRawError`). |
| [scripts/code-graph/extract-errors.ts](../scripts/code-graph/extract-errors.ts) | ts-morph: exported error classes and what they extend (ErrorType / EXTENDS). |
| [scripts/code-graph/scc.ts](../scripts/code-graph/scc.ts) | Pure, deterministic Tarjan SCC over the module-import graph — finds import cycles (`Module.inImportCycle`). |
| [scripts/code-graph/rebuild.ts](../scripts/code-graph/rebuild.ts) | The orchestrator — extract → connect Neo4j → reconcile (delta) → verify. Entry point of `pnpm code-graph:rebuild`. Emits DEFINES and runs cycle detection. |

### Extending it

1. Add the new entity/relationship type to `vocabulary.ts`.
2. Add a small extractor (mirror one of the existing ones) or extend one.
3. Wire the new nodes/edges into `rebuild.ts`.
4. Re-run `pnpm code-graph:rebuild` — the schema updates in place; all existing data is kept.

> **Building this for a *different* codebase?** This doc describes *this* repo's graph; the
> generalised method — how to design a focused, bespoke vocabulary and extract it deterministically
> for any codebase — is in **[code-graph-guide.md](code-graph-guide.md)**.

Keep everything deterministic. A future, separate step could add a *semantic* layer (the "why",
design invariants, cross-runtime contracts) using the deep-memory **indexer** with an LLM — but the
structural graph described here intentionally uses no model.

---

## Honest caveats

- **Static facts, not runtime proof.** An edge means "this relationship exists in the source", not
  that a code path actually runs. Use the graph to *find* the right code fast; then read the code.
- **Some `IMPLEMENTS` edges are inferred, not declared.** Most come from a nominal `implements`
  clause, but a `*Provider`-named class that declares a contract's full required surface without the
  clause (e.g. `Neo4jStorageProvider`, which defers its declaration until the surface is complete) is
  matched structurally. Those edges carry `detection: structural` — high-confidence, but inferred. A
  nominal-only scan would silently drop the storage/traversal backend that powers this graph.
- **`DOCUMENTS` is still link-bound.** A markdown link to *any* modelled `.ts` source file now
  resolves — to its specific construct (provider/server/tool) or otherwise to its `Module` node — so
  DOCUMENTS reaches the whole file tier, not just the handful of provider/tool files. But docs still
  have to actually *link* the file; prose that only names a symbol lands in the broader `MENTIONS`
  edges (now including error classes), and `DESCRIBES` remains the reliable package↔README link.
- **An import cycle isn't always a runtime crash.** `inImportCycle` is computed over the full
  `IMPORTS` graph, which includes type-only imports and barrel re-exports. A cycle routed only through
  type-only edges erases at compile time and won't crash; a value-import cycle is the real hazard. The
  flag is a high-signal lead for the "fix the circularity" convention — read the cycle the rebuild
  logs, then confirm whether the back-edge carries runtime values.
- **`Module` is a file, not a symbol.** `IMPORTS` answers "which *files* import this file/package",
  not "which files use this specific function". That's the 80/20 for refactors; symbol-level
  precision is a deliberate non-goal of this layer. Modules are also intentionally **not**
  `CONTAINS`-anchored to their package (186 of them would swamp a package's neighborhood) — filter on
  the `Module.package` property instead.
- **`throwsRawError` is a lead, not a verdict.** It flags a file that throws an error not in the
  modelled typed hierarchy (the builtin `Error`, or a module-private error) — a starting point for the
  "typed errors only" convention, not proof of a violation.
- **It can go stale.** The graph reflects the repo only as of the last `pnpm code-graph:rebuild`.
  This is intentional — refreshing is a one-command, opt-in step, never wired into the build. Check
  the repository metadata's `gitCommit` / `builtAt` to see how current it is.
