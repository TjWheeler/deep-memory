# Deep Memory — Graph Viewer

A single static HTML page that lets you pick any deep-memory repository and explore it as an
interactive force-directed graph (Cytoscape.js + fcose, no React, no build step for the page itself).

It runs in **three modes**, auto-detected at page load (a badge by the title shows which is active):

| Mode | Data source | For whom | How |
|------|-------------|----------|-----|
| **Live** | A Node server queries your configured storage provider directly | Teammates with the repo + a database | `pnpm serve:graph-viewer` |
| **Embedded** | The graph is baked into the HTML file itself | People with **no database** / non-technical viewers | open a file from `pnpm export:graph-html` |
| **Static** | Pre-built JSON from `.dkg` export bundles | Sharing a folder snapshot | `pnpm build:graph-viewer` + any HTTP host |

Detection order: if the page was exported with inlined data it runs **embedded** (zero network);
otherwise it probes `GET /api/health` — if the live server answers it runs **live**, else it falls
back to the pre-built `data/` directory (**static**).

**TL;DR:**
- *"I want to explore my own graphs"* → `pnpm serve:graph-viewer` (opens your browser).
- *"I want to send someone a graph to look at"* → `pnpm export:graph-html`, then send them the `.html`.

## Live mode (recommended) — query the database directly

```bash
pnpm build                 # the server imports the built packages
pnpm serve:graph-viewer    # serves on :8137 and opens your browser automatically
```

It prints a clickable link and **opens the viewer in your default browser** (macOS, Windows, Linux,
and WSL — where it reaches the Windows browser via `explorer.exe`). Pass `--no-open` to skip that
(e.g. on a headless box).

The server ([`../scripts/graph-viewer-server.mjs`](../scripts/graph-viewer-server.mjs)) resolves
its provider connection the same way the MCP server does, with one addition:

1. It reads the `deep-memory` server's `env` block out of [`../.mcp.json`](../.mcp.json) — i.e. the
   provider you've **already configured**. No separate config.
2. Any `DEEP_MEMORY_*` variable present in the environment **overrides** that base, so you can point
   it at a different database without editing `.mcp.json`:

   ```bash
   DEEP_MEMORY_STORAGE=sqlserver DEEP_MEMORY_SQL_DATABASE=other pnpm serve:graph-viewer
   ```

Flags: `--port <n>` (default 8137), `--mcp <path>` (default `../.mcp.json`), `--server-key <name>`
(default `deep-memory`), `--no-open` (don't launch a browser).

The viewer loads **on demand** — it never pulls the whole graph. On open it fetches the
degree-ranked **hubs** and ego-expands each with a few of its neighbours, so the seed is a connected
set of clusters rather than disconnected dots; then, as you click a node, search, or drill into a
type, it fetches just that slice. This keeps it responsive on large graphs (and cheap on CosmosDB
RUs). It exposes a small read-only API (served from the same origin, so no CORS):

```
GET /api/health                                       → { ok, storage }
GET /api/repositories                                 → [{ repositoryId, label, entityCount, relationshipCount, entityTypeBreakdown }]
GET /api/repositories/:id/hubs?limit=25               → { entities[], edges[], totalEntityCount, entityTypeCounts }   (seed)
GET /api/repositories/:id/explore/:entityId           → { center, layers, statistics }   (neighbourhood; ?depth ?limitPerType)
GET /api/repositories/:id/entities?search=&type=…     → { items[], total, hasMore }   (search / type paging)
GET /api/repositories/:id/entity/:entityId            → full entity (detail panel)
```

The hub seed ranks by degree using a **provider-native query** (Cypher for Neo4j, Gremlin for
Cosmos — the same approach as the UCM graph viewer; other providers fall back to a full read);
everything else uses the library's provider-agnostic `exploreNeighborhood` / `findEntities` /
`getEntity`. The viewer is read-only, so the server uses **no embeddings provider**.

## Embedded mode — a self-contained file you can send anyone

For people with **no database** (or who shouldn't touch a terminal): bake a repository's graph into
a standalone HTML file they can **double-click to open**. No server, no database, no install.

```bash
pnpm export:graph-html                  # one .html per repository
pnpm export:graph-html --repo <id>      # just one repository
```

Writes to `graph-viewer/dist/<repository-label>.html`. Each file inlines its own graph data, so
opening it makes **zero data requests** — it works straight from `file://`. (It still pulls
Cytoscape.js from a CDN, so the *viewer* needs internet to render, but none of your data leaves the
file.) Like the live server, it reads the provider config from `.mcp.json` (env-overridable), so you
generate the files from your database, then hand them out.

Flags: `--repo <id>|all` (default `all`), `--out <dir>` (default `graph-viewer/dist`), plus the same
`--mcp` / `--server-key` as the server.

## Static mode — pre-built snapshots from `.dkg` exports

Useful for sharing a graph with someone who has no database access. From the repo root:

```bash
pnpm build:graph-viewer
```

This scans `exports/*.dkg`, unzips each in memory (via `fflate` — cross-platform, no `unzip`
CLI), **strips the embedding vectors** (the bulk of the file size), precomputes each entity's
`degree`, and writes:

```
graph-viewer/data/
  repositories.json     ← dropdown index (one entry per export)
  <repositoryId>.json   ← compact per-repo graph (embeddings stripped)
```

Re-run it whenever the contents of `exports/` change. The script wipes and regenerates
`graph-viewer/data/` each time, so removed exports don't leave stale files. Then serve the folder
over HTTP (`fetch()` does not work from `file://`):

```bash
npx serve graph-viewer
# or:  cd graph-viewer && python3 -m http.server 8080
```

> **If you rebuilt while the viewer tab was open**, hard-reload it (Ctrl/Cmd+Shift+R). The
> dropdown is built once at page load, so a stale tab can point at a data file the rebuild
> renamed or removed — selecting it shows "Failed to load repository". The viewer re-checks the
> index on a failed load and tells you to reselect, but a hard reload is the clean fix.

## What you can do

> A full walkthrough of the interactions — reading the clusters, the detail panel, exploring large
> graphs — is in the **[Graph Viewer Usage Guide](../docs/graph-viewer.md)**. This README covers how
> the viewer is built and run.

- **Pick a repository** from the dropdown.
- The graph seeds the most-connected **hubs**, each with a few of its neighbours, as connected
  **clusters** — coloured by entity type, sized by degree.
- **Click a node** to expand its neighbours, highlight its relationships (edge labels show for the
  selected node), and open the detail panel (properties + a relationship breakdown with per-type
  *Expand*).
- The **type bar** shows `shown / total` per type; click a type to surface hidden entities of it.
- **Search** (debounced) finds entities and offers *Focus* (in view) or *Add* (not in view).
- **Reset view** returns to the hub clusters.

In **live** mode each of those actions fetches just the slice it needs from the server, so the
graph grows as you explore. In **embedded** and **static** mode the whole graph is already in
memory, so expansion, search, and the type bar make no further network calls. (Cytoscape.js + the
fcose layout always load from a CDN; vendor them into the page if fully-offline use matters.)
