# Graph Viewer — Usage Guide

The Graph Viewer is an interactive, force-directed picture of any deep-memory repository. Pick a
repository and explore it visually: the most-connected entities appear first as clusters, and you
pull in the rest by clicking, searching, and filtering. It is the fastest way to *see* the shape of
a knowledge graph — what the hubs are, how entities relate, and where the structure is dense or
sparse.

This guide is about **using** the viewer. For how it is built, the data modes, the HTTP API, and CLI
flags, see [graph-viewer/README.md](../graph-viewer/README.md).

> **For AI agents:** if a user asks to "see", "look at", "visualise", or "explore" a memory graph,
> launch the viewer for them with `pnpm serve:graph-viewer` (it opens their browser automatically)
> and tell them the link it prints (`http://localhost:8137/index.html`). Then walk them through the
> interactions below — start with "pick your repository from the dropdown, then click the biggest
> node." You do not need to read the build doc to do this.

## Launch it

The viewer runs in three modes. Most of the time you want **live** mode — it reads straight from the
storage provider you already configured in `.mcp.json`, so there is no export or build step.

| You want to… | Command | Result |
|--------------|---------|--------|
| **Explore your own graphs** (recommended) | `pnpm serve:graph-viewer` | Serves on `:8137`, opens your browser, queries your database live. |
| **Send someone a graph** with no database | `pnpm export:graph-html` | One self-contained `.html` per repository — they double-click to open it. |
| **Share a folder snapshot** over HTTP | `pnpm build:graph-viewer` | Pre-built JSON from `.dkg` exports, served by any static host. |

A badge next to the title shows which mode is active (**live** / **file** / **static**). Setup
details, flags (`--port`, `--no-open`, pointing at a different database, etc.), and the read-only API
are all in [graph-viewer/README.md](../graph-viewer/README.md).

## Reading the graph

When you select a repository, the viewer **does not draw the whole graph** — a large graph would be
an unreadable hairball. Instead it seeds a connected starting view and lets you grow it:

- **The seed is the hubs, in context.** It shows the most-connected entities, each surrounded by a
  few of its neighbours, so they render as legible **star-clusters** with real relationships — not a
  grid of disconnected dots. In a tightly-linked domain graph the clusters overlap into a web; in a
  tree-like graph (e.g. a codebase) they stay as distinct stars. Both are honest pictures of the
  structure.
- **Node colour = entity type.** The **type bar** across the top is the legend; each chip is a type,
  its colour, and a `shown / total` count.
- **Node size = degree** (how many relationships touch it). Big nodes are hubs; small nodes are
  leaves. The label font scales with degree too, so hub names read first.
- **Edges = relationships.** An arrowhead shows direction; a relationship with no arrow is
  bidirectional. Edge *labels* (the relationship type) are hidden by default to keep the canvas
  clean — they appear for the node you select (see below).
- **Counter** (top-right) shows `Showing N of M entities` — how much of the graph is currently on
  the canvas versus the repository total.

## Exploring

Everything is driven from the canvas, the type bar, the search box, and the detail panel on the
right.

### Click a node

Clicking a node does three things:

1. **Expands it** — pulls its neighbours onto the canvas (in live mode this fetches just that slice
   from the database; the graph grows as you explore).
2. **Selects it** — dims everything except the node and its immediate neighbourhood, and lights up
   its own edges in ember **with their relationship-type labels** so you can read how it connects.
3. **Opens the detail panel** with:
   - the **summary**, the entity **type** and **degree**;
   - a **Properties** table;
   - **Relationships** grouped by type and direction (`→` outgoing, `←` incoming, `↔`
     bidirectional) with a count and an **Expand** button per group — expand just the relationships
     you care about instead of the whole neighbourhood;
   - **provenance** (who created/modified it and when).

Click empty canvas to clear the selection.

### The type bar

Each chip shows how many entities of that type are currently shown out of the total. Click a chip to
open a list of that type's entities that aren't on the canvas yet, and **Add** them individually or
all at once. This is how you bring in a whole category (e.g. "show me every Service") rather than
walking the graph one click at a time.

### Search

Type in the search box (debounced). Matches are split into **In view → Focus** (centre on a node
already on the canvas) and **Not in view → Add** (bring a new node in and select it). Search is the
quickest way to jump to a named entity in a large graph.

### Reset, pan, zoom

- **Reset view** re-seeds the hub clusters — your way back to the overview after exploring deep.
- **Drag the background** to pan; **scroll** to zoom; **drag a node** to reposition it.
- Labels thin out as you zoom away (smaller/satellite labels hide first) and return as you zoom in,
  so a dense graph stays readable at every zoom level.

## Working with large graphs

The viewer is built around **progressive discovery** — the same principle as the deep-memory tools
themselves. You are never meant to load everything at once:

- Start from the seed (the hubs are usually where you want to begin anyway).
- Follow relationships by clicking, or jump with search, or pull in a category from the type bar.
- Use a relationship group's **Expand** button to grow along one relationship type only.
- Hit **Reset view** to collapse back to the overview when the canvas gets busy.

In live mode each action fetches only the slice it needs, so the viewer stays responsive on graphs
with thousands of entities (and cheap on CosmosDB RUs). In embedded/static mode the whole graph is
already in memory, so exploration makes no further requests.

## Troubleshooting

| Symptom | Likely cause / fix |
|---------|--------------------|
| "Select a repository" but the dropdown is empty | Live: the storage provider has no repositories yet. Static: run `pnpm build:graph-viewer`. Embedded: the file has no graph baked in. |
| "Could not load repository index" | Live server can't reach the database — check the provider config in `.mcp.json` and that the database is up. |
| The page won't load / connection refused | The live server isn't running. Start it with `pnpm serve:graph-viewer`. |
| "Failed to load repository" in **static** mode | The data is out of sync with the dropdown — re-run `pnpm build:graph-viewer`, then hard-reload (Ctrl/Cmd+Shift+R). |

For the full mode/setup reference, the API, and CLI flags, see
[graph-viewer/README.md](../graph-viewer/README.md).

## See also

- [graph-viewer/README.md](../graph-viewer/README.md) — modes, setup, HTTP API, CLI flags (the build/run reference).
- [AI Requirements](ai-requirements.md) — the progressive-discovery model the viewer mirrors.
- [Code Graph](code-graph.md) — point the viewer at a graph of *your own codebase* and explore its architecture.
