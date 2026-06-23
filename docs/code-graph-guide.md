# Building a Code Graph for Your Codebase — A How-To Guide

> A **code graph** is a small, deterministic map of your codebase's *architecture*, stored in a graph
> database, that an AI agent (or a developer) can query to answer cross-cutting questions in one
> step — *"what breaks if I change this?"*, *"which tests cover this?"*, *"does this layer secretly
> depend on that one?"*, *"which of these can no test reach?"*.
>
> This guide explains **how to design and build one for any codebase**. It is framework-agnostic in
> method; the examples use [Deep Memory](../README.md) as the substrate because it gives you a
> governed vocabulary, idempotent writes, and a ready-made query surface for AI agents — but the
> design principles apply to raw Neo4j, or any graph store. This repository's own code graph
> ([code-graph.md](code-graph.md), built by [scripts/code-graph/](../scripts/code-graph/)) is the
> worked reference implementation; the method below is what produced it, generalized.

---

## The one idea that matters: a focused vocabulary, not a code dump

The single most important decision is **what you leave out**.

A **code dump** — every symbol, every file, every reference, the full AST or call graph — is the
obvious thing to build and almost always the wrong one. It is:

- **Huge and noisy.** Tens of thousands of nodes; the signal you actually care about is buried.
- **Redundant.** Your compiler, language server (LSP), and `grep` already answer *"find references to
  this function"* instantly and exactly. A graph that merely re-encodes that adds nothing.
- **Useless to an AI.** Drowning an agent in a 50k-node blob makes it slower, not smarter — the whole
  point is to *reduce* what it has to read.

A **focused vocabulary** is the opposite: a deliberately small set of node and edge types, chosen to
match *your* architecture and to answer the handful of questions that are genuinely slow today. This
repo's code graph models ~9 node types — packages, the provider seam, the MCP tool surface, docs,
tests, source files, the error hierarchy — and **nothing else**. It does not model every function,
every variable, every call. It models the **seams**: the cross-cutting relationships that span files,
packages, and layers, exactly where grep and LSP are weakest.

Two consequences fall out of this, and they are the heart of the method:

1. **Every codebase needs a different vocabulary.** A web app's seams are routes, components, hooks,
   stores, and API calls. A microservice mesh's seams are services, queues, topics, and schemas. A
   data pipeline's are sources, transforms, and sinks. The *method* in this guide is universal; the
   *model* you produce is bespoke. Copying this repo's `Provider` / `McpTool` vocabulary into a React
   app would be worthless — you must design your own from your own architecture.
2. **The value is often in the absence and the invariant, not the presence.** *"Core has **no**
   runtime dependency"* (a missing edge), *"this interface has **no** implementation"* (a missing
   in-edge), *"this tool has **no** test"* (another) are the high-value queries. You can only ask them
   because the model is curated enough that an absence is *meaningful*. In a code dump, absence means
   nothing — you just didn't extract it.

Keep this front of mind the whole way through: **you are modelling an architecture, not indexing a
codebase.**

---

## Is it worth building? (a quick gate)

A code graph earns its keep when:

- The codebase is **large enough** that an AI agent (or a new engineer) can't hold its structure in
  their head, and answering "what connects to what" means many searches.
- The valuable questions are **cross-cutting** — they span files, modules, packages, services, or
  layers — which is precisely where LSP "find references" (scoped, single-language, within-project)
  and `grep` (textual, no structure) fall down.
- You have **architectural rules you want to keep honest** — a layering constraint, a dependency
  direction, a "this must never import that" — that today live only in people's heads or a CONTRIBUTING
  doc.

It is **not** worth it when: the project is small; the questions are local ("find references in this
file") where the LSP already wins; or what you want is runtime behaviour (use tracing/profiling, not a
static graph). Don't build a graph to relitigate what your tools already do well.

---

## The method, step by step

### Step 1 — Start from the questions, not the schema

Write down the 5–15 questions you (or an AI working on this repo) keep needing to answer and that are
*slow today*. Be concrete. Examples that drove this repo's graph:

- "If I change the `StorageProvider` interface, which implementations and tests break?"
- "Does the `core` package have any runtime dependency?" (it must not)
- "Which MCP tools mutate state vs only read?"
- "Which source files import this one — what's the blast radius of editing it?"
- "Which tools / files have no test?"
- "What errors can this code throw, and what catches them?"

Your list will look nothing like this. That's the point. **The vocabulary is reverse-engineered from
the questions** — if a node or edge type doesn't help answer a question on your list, it doesn't
belong in the graph.

### Step 2 — Name the entities (the nouns)

Each question contains nouns. Promote the recurring, *navigable* ones to entity types. Rules of thumb:

- **Keep the set small.** Single digits is healthy. If you're past ~12 types, you're probably dumping.
- **Each type must be deterministically extractable** from a concrete source signal — a naming
  convention, an AST shape, a file location, a manifest entry (see [Step 5](#step-5--make-extraction-deterministic)).
  If you can't point at the signal, it's not an entity type yet.
- **Pick names that read well as a sentence** with your edges: *"`ProviderImpl` IMPLEMENTS
  `ProviderContract`"*. (If your store enforces a name-similarity guard — Deep Memory rejects pairs
  scoring ≥ 0.85 Jaro-Winkler — keep sibling names distinct: `ProviderContract` vs `ProviderImpl`
  passes; `Service` vs `Services` would not.)

### Step 3 — Name the relationships (the verbs)

Edges are where the value concentrates. For each one decide: source type → target type, direction, and
what it *means*. Prioritise two kinds:

- **Invariant edges** — ones whose presence or absence encodes a rule. The whole reason `core` is a
  node is so its *missing* outgoing runtime-dependency edge can be checked.
- **Blast-radius edges** — ones you traverse to answer "what depends on / breaks with X":
  `IMPLEMENTS`, `IMPORTS`, `COVERS`, `THROWS`, `DEPENDS_ON`.

Put attributes that vary per-edge on the edge as properties (e.g. `depType: runtime|peer|dev`,
`detection: nominal|structural`, `role: subject|fixture`) rather than inventing a new edge type for
each variant.

### Step 4 — Decide granularity and tiers

Not everything deserves the same weight. Split your model into tiers:

- **Architectural constructs** (few, important): interfaces, services, endpoints, error types. Give
  these rich edges and anchor them to their owner (a `CONTAINS`/`OWNS` edge).
- **Bulk** (many, uniform): every source file, every component. Model these *only if* a question needs
  them, and keep them light. This repo has 186 `Module` nodes for the file-level import graph, but it
  deliberately does **not** give each a `CONTAINS` edge to its package — 186 edges would swamp a
  package's neighbourhood and make exploration useless. Instead each `Module` carries a `package`
  *property*. **Granularity is a design lever: coarse where you can, fine only where a question forces
  it.**

### Step 5 — Make extraction deterministic

The graph must be reproducible from source with **no LLM and no guessing**. Every node and edge comes
from a concrete, mechanical signal:

| Signal | Examples |
|--------|----------|
| **Naming convention** | a class/interface ending in `Provider`, `Service`, `Controller`, `Error` |
| **AST shape** | `implements X` / `extends Y` clauses; a `get name()` string literal; decorators (`@Component`, `@Injectable`); `throw new XError()`; export declarations |
| **File layout** | `packages/<x>/src/...`; `app/**/page.tsx`; `**/*.test.ts` |
| **Manifests** | `package.json` deps; `openapi.yaml` endpoints; a router config; `docker-compose.yml` services |
| **Markdown / docs** | links to source files; symbol names in prose |

Use a real parser for the AST signals (e.g. `ts-morph` / the TypeScript compiler API for TS,
`tree-sitter` for polyglot, or your language's AST library) — not regex over source, which breaks on
the first edge case.

Two extraction lessons worth internalising:

- **Nominal vs structural.** Prefer the explicit signal (a `implements` clause). But the explicit
  signal sometimes isn't there: this repo's `Neo4jStorageProvider` *deliberately omits* its `implements
  StorageProvider` clause, so a nominal-only scan silently dropped the storage backend that powers the
  graph itself. The fix was **structural detection** — a class that declares every required member of
  the interface is treated as implementing it — and then **flagging the inferred edge** (`detection:
  structural`) so a consumer knows it was inferred, not declared. Infer when you must; never hide that
  you inferred.
- **Resolve, don't fabricate.** When a reference can't be resolved to a modelled node (an import of an
  untracked package, a doc link to a non-source file), **drop it** — don't invent a placeholder node.
  A clean "this edge is absent" is more useful than a fictional one.

### Step 6 — Build idempotently (delta reconciliation)

A rebuild you can run on every commit beats a one-off snapshot that rots. The pattern this repo uses,
and the one to copy:

1. **Deterministic ids.** Derive each node's id from its natural key (e.g. `uuidv5("module:" +
   path)`), so the same logical thing always maps to the same graph node across runs.
2. **Fingerprints.** Hash each node's salient content. On rebuild, re-extract the *whole* desired
   graph, read the current graph, and diff: create the new, update the changed (fingerprint differs),
   delete the gone. For edges, key on `type|source|target` plus a discriminator for multi-edges.
3. **Apply only the difference.** The result is **idempotent** (a no-op run writes nothing),
   **self-healing** (drift is corrected), and always reflects your **working tree**. Verify this: a
   second consecutive build must report zero changes.

### Step 7 — Model the honesty (caveats + provenance)

A graph that overstates its certainty is dangerous. Bake the limits in:

- **Static facts, not runtime proof.** An edge means "this relationship exists in the source", not
  "this path runs". Say so.
- **Flag inferred edges** (the `detection` property above).
- **Record provenance.** Stamp the build with the git commit, branch, dirty flag, and timestamp, so a
  consumer can tell *how stale* the graph is and *against which commit* — and refresh on demand.

### Step 8 — Verify against ground truth

Don't trust the graph because it built. Spot-check it:

- Cross-check counts against source (`grep -c`, file counts) — *"the graph says 24 error types; does
  the source have 24 exported `extends *Error` classes?"*
- Traverse a few known relationships end-to-end and confirm they match reality.
- Look hard at **surprising absences** — a missing edge is either a real finding (a genuine gap, like
  an untested tool) or an extraction bug. Both are worth knowing.

### Step 9 — Iterate; let the vocabulary evolve

Ship the highest-value seam first (often the dependency graph or the core interface→implementation
relationship), prove it answers real questions, then add a layer at a time. A good substrate lets the
**vocabulary evolve in place** — Deep Memory reconciles entity/relationship type changes on the next
run without rebuilding the data — so growing the model is cheap. This repo grew from "packages +
providers + tools + docs + tests" to add a file-level import graph and an error hierarchy as later,
separate iterations.

---

## Worked vocabularies for different domains

To drive home that the model is bespoke, here are starting-point vocabularies for four very different
systems. These are sketches to adapt, not prescriptions.

### A) This repo — a TypeScript library / monorepo

| Entities | Edges | Headline query |
|----------|-------|----------------|
| `Package`, `ProviderContract`, `ProviderImpl`, `McpServer`, `McpTool`, `Doc`, `Test`, `Module`, `ErrorType` | `DEPENDS_ON_PACKAGE`, `IMPLEMENTS`, `CONTAINS`, `ADVERTISES`, `IMPORTS`, `COVERS`, `THROWS`, `EXTENDS`, `DOCUMENTS` | "Change this contract → which impls + tests break?"; "Does core have a runtime dep?" |

Extraction: `package.json` for deps; `implements`/`extends` clauses and `get name()` literals via
ts-morph; markdown links; `*.test.ts` imports. *(See [code-graph.md](code-graph.md) for the full
model.)*

### B) A web frontend (React / Next.js)

| Entities | Edges | Headline query |
|----------|-------|----------------|
| `Route`, `Component`, `Hook`, `Store`/`Context`, `ApiClient`, `EnvVar` | `Route ─RENDERS→ Component`, `Component ─USES→ Hook`, `Component ─READS→ Store`, `Component ─CALLS→ ApiClient`, `Hook ─READS→ EnvVar` | "Which routes render a component that calls this (changing) API?"; "Which components read this store?" |

Extraction: file-based routing layout (`app/**/page.tsx`); `import` graph; `useX()` call sites;
`process.env.X` reads; the API client's method surface.

### C) A backend / microservice mesh

| Entities | Edges | Headline query |
|----------|-------|----------------|
| `Service`, `Endpoint`, `Queue`/`Topic`, `Schema`/`Message`, `Datastore`, `Job` | `Service ─EXPOSES→ Endpoint`, `Service ─PUBLISHES/CONSUMES→ Topic`, `Endpoint ─VALIDATES→ Schema`, `Service ─READS/WRITES→ Datastore`, `Service ─CALLS→ Endpoint` | "If I change this message schema, which consumers break?"; "Who writes to this datastore?" |

Extraction: OpenAPI/proto/AsyncAPI specs; queue client publish/subscribe call sites; service manifests
(`docker-compose`, k8s, Terraform); DB client usage.

### D) A data pipeline / ETL

| Entities | Edges | Headline query |
|----------|-------|----------------|
| `Source`, `Dataset`/`Table`, `Transform`/`Job`, `Sink`, `Schedule` | `Job ─READS→ Dataset`, `Job ─WRITES→ Dataset`, `Schedule ─TRIGGERS→ Job`, `Sink ─EXPOSES→ Dataset` | "Upstream/downstream lineage of this table — what breaks if its schema changes?" |

Extraction: job definitions (SQL `FROM`/`INTO`, DAG configs); scheduler config; table/dataset
references in queries.

Notice none of these reuse another's node types. **The architecture dictates the vocabulary.**

---

## Anti-patterns to avoid

- **Dumping the whole AST / call graph.** If your node count rivals your line count, you've built an
  index, not a model. Cut back to the seams.
- **Re-encoding what the LSP already does.** "Find references" within a project is solved. Model the
  relationships that *cross* the boundaries the LSP can't see.
- **Modelling runtime-tracked data.** Don't add a "Conversation" or "Request" node to a *static* graph;
  that's runtime state, tracked elsewhere. (In Deep Memory specifically, provenance is recorded on
  every mutation — don't duplicate it as entities.)
- **Fabricating unresolved edges.** Drop what you can't resolve; never invent placeholder targets.
- **Letting bulk nodes swamp navigation.** Anchor important constructs richly; keep high-count node
  types light (properties over edges).
- **Hiding inference.** If you matched something heuristically, mark it.
- **A one-off snapshot.** Without deterministic ids + fingerprints + a re-runnable build, the graph
  rots within a week and people stop trusting it.
- **Embeddings you don't need.** A structural graph is navigated by type, name, and traversal — not
  fuzzy text. Skip embeddings unless you have a genuine "find the concept I can't name" use case; they
  cost money and add nothing to "what implements X".

## A vocabulary-design checklist

Before you build, your draft model should pass all of these:

- [ ] Every entity type answers at least one question on your list.
- [ ] Every entity type has a concrete, deterministic extraction signal.
- [ ] Every relationship type is directional and reads as a sentence.
- [ ] At least one query relies on an **absence** (a missing edge / unimplemented / untested).
- [ ] High-count node types are kept light (properties, not a web of edges).
- [ ] Inferred edges are distinguishable from declared ones.
- [ ] The build is idempotent and stamps provenance.
- [ ] You can state, in one sentence each, the caveats (what the graph does *not* prove).

---

## Using Deep Memory as the substrate

You can build a code graph on raw Neo4j or any graph DB. Deep Memory adds three things that make it a
good fit, especially for AI consumers:

- **A governed vocabulary.** You declare entity/relationship types with descriptions and required
  properties; the schema is enforced and **evolves in place** as your model grows.
- **Idempotent, identity-stable writes** and a delta-friendly model — the reconciliation pattern in
  [Step 6](#step-6--build-idempotently-delta-reconciliation) maps directly onto its API.
- **An MCP tool surface for agents.** Once built, an AI assistant queries the graph through the
  `deep-memory` MCP server — `memory_explore_neighborhood` (blast radius), `memory_find_entities`,
  `memory_query_graph` (traversals, projections) — the same tools documented in
  [packages/mcp-server/README.md](../packages/mcp-server/README.md).

The fastest way to start is to **copy this repo's reference implementation** and swap the vocabulary:

| File | What to adapt |
|------|---------------|
| [scripts/code-graph/vocabulary.ts](../scripts/code-graph/vocabulary.ts) | Replace the entity/relationship types with *your* model (Steps 2–4). |
| [scripts/code-graph/extract-*.ts](../scripts/code-graph/) | One extractor per layer — mirror these for your signals (Step 5). |
| [scripts/code-graph/rebuild.ts](../scripts/code-graph/rebuild.ts) | The orchestrator: extract → connect → reconcile (delta) → verify. The id/fingerprint/edge-diff machinery is reusable as-is (Step 6). |

Then build it (a local Neo4j via the bundled `docker-compose.neo4j.yml`, then `pnpm code-graph:rebuild`)
and query it through the MCP server. No embeddings are wired, so it costs nothing to build and rebuild.

> **AI agents building this for a user:** treat Steps 1–4 as a short conversation — surface the
> candidate questions and the draft vocabulary, get the user to confirm the seams that matter *to
> them*, then implement. Do **not** start by dumping every symbol; start by asking what's slow to find.

---

## Further reading

- [code-graph.md](code-graph.md) — this repo's code graph: what it models, why it's optional, how to
  build it. The worked example this guide generalises.
- [code-graph-usage.md](code-graph-usage.md) — the terse query reference (slugs, recipes, Cypher).
- [ai-requirements.md](ai-requirements.md) — the progressive-discovery design philosophy behind Deep
  Memory's tool surface, which is why a *focused* graph serves an AI better than a dump.
