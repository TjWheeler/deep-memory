# Quickstart — Neo4j

Neo4j is a graph database — a great fit for Deep Memory because storing and querying connections between things is what it does best. The repo ships a `docker-compose.neo4j.yml` that brings up Neo4j for you; you'll be querying a persistent graph in a few minutes.

Two paths:

- **Bundled Docker compose** — free, cross-platform, perfect for trying it out.
- **AuraDB or your own Neo4j server** — production-ready cloud or self-hosted.

**You'll need:** Node.js 22 or 24 (the supported LTS pair), [Claude Code](https://claude.com/claude-code) or another AI, Docker Desktop (or an existing Neo4j 5+ instance).

---

## 1. Clone and build

```bash
git clone https://github.com/TjWheeler/deep-memory.git
cd deep-memory
pnpm install
pnpm build
```

## 2. Start Neo4j

### Option A — Bundled Docker compose

```bash
docker compose -f docker-compose.neo4j.yml up -d
```

This runs `neo4j:5.26-community` and exposes:

- Port `7687` — what the MCP server connects to
- A **Browser UI** at `http://localhost:7474` for poking around the graph
- Credentials: `neo4j` / `DeepMem-Dev-1234`

Wait for the health check to go green (about 30 seconds on first run):

```bash
docker compose -f docker-compose.neo4j.yml ps
```

Once the `STATUS` column shows `healthy`, you're ready. The `neo4j` database exists by default — no creation step needed.

> **Default password.** `DeepMem-Dev-1234` is the publicly known development default in the bundled compose — it's only a fallback. Set `NEO4J_PASSWORD` in a gitignored `.env` file at the repo root (see `.env.example`) to override it without ever committing a real password, and update the matching `DEEP_MEMORY_NEO4J_PASSWORD` in the MCP config below. If the container's data volume already exists, also rotate the live credential with `ALTER CURRENT USER SET PASSWORD FROM '<old>' TO '<new>';` via `cypher-shell` — the env var only seeds a brand-new empty volume.

### Option B — AuraDB or your own Neo4j server

1. Sign up for [Neo4j AuraDB](https://neo4j.com/cloud/aura/) (free tier available), or stand up your own Neo4j 5+ server.
2. Note the connection URL from your provider — AuraDB gives you one like `neo4j+s://<dbid>.databases.neo4j.io`.
3. Note the username (usually `neo4j`), the password, and the database name (usually `neo4j`).

## 3. Wire the MCP server into Claude Code

Copy the example file and edit the `deep-memory` entry to use Neo4j:

```bash
cp .mcp.json.example .mcp.json
```

### Bundled-compose config

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "neo4j",
        "DEEP_MEMORY_NEO4J_URI": "bolt://localhost:7687",
        "DEEP_MEMORY_NEO4J_USERNAME": "neo4j",
        "DEEP_MEMORY_NEO4J_PASSWORD": "DeepMem-Dev-1234",
        "DEEP_MEMORY_NEO4J_DATABASE": "neo4j"
      }
    }
  }
}
```

### AuraDB config

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "neo4j",
        "DEEP_MEMORY_NEO4J_URI": "neo4j+s://<dbid>.databases.neo4j.io",
        "DEEP_MEMORY_NEO4J_USERNAME": "neo4j",
        "DEEP_MEMORY_NEO4J_PASSWORD": "<your aura password>",
        "DEEP_MEMORY_NEO4J_DATABASE": "neo4j"
      }
    }
  }
}
```

Use the URL your Neo4j provider gave you. Aura uses `neo4j+s://`. Local Docker uses `bolt://`.

> **Don't commit `.mcp.json` with real passwords.** It's gitignored by default. Use your AI client's secret-management feature or a secrets manager rather than inlining production credentials.

## 4. Restart Claude Code

Restart Claude Code so it loads the new server. Confirm via `/mcp` that `deep-memory` shows connected with 29 tools.

## 5. Set up the database

Paste this:

> Use `memory_ensure_schema` to set up the Deep Memory database. Then show me what was done.

This sets up everything Deep Memory needs inside the `neo4j` database. Safe to re-run — it skips anything that's already there.

## 6. Load the sample graph

The repo ships a fictitious "Person" sample at [exports/person-sample-v1.0.dkg](exports/person-sample-v1.0.dkg) — 26 entities, 35 relationships.

> Import the sample knowledge graph from `exports/person-sample-v1.0.dkg` as a new repository. Use `mode: "create"` and generate a fresh UUID for the repository ID. Then open the repository and show me the stats.

The sample loads in a few seconds against the bundled Docker compose. You should see 6 Person, 10 Organization, 6 Identity, and 4 Location entities — now persisted in Neo4j.

## 7. Chat with the graph

> Find all people in the graph and tell me where each one works.

> Who does Alice Johnson know, and how do they know each other?

> Show me everyone connected to Robert Chen within two hops, with the relationships labelled.

> Which organisations are based in Berlin?

Because Neo4j is a graph database, traversals like `memory_explore_neighborhood`, `memory_find_paths`, and `memory_query_graph` stay fast even as the graph grows.

## 8. Verify persistence and inspect

Restart the `deep-memory` MCP server (in Claude Code: `/mcp` → disconnect/reconnect, or restart Claude). Then:

> Open the repository I just imported and show me the stats.

Still there. Your data survives MCP server restarts.

To see the graph visually, open the Neo4j Browser at [http://localhost:7474](http://localhost:7474) (or the Aura console for cloud), log in, and click any of the labels in the left sidebar to draw the nodes Deep Memory created.

---

## Using a different MCP client

Same JSON shape, different config file location — check your MCP client's documentation for where it looks. The `env` block above goes in verbatim.

For Claude Desktop, you'll need the absolute path to `packages/mcp-server/dist/index.js`.

---

## Troubleshooting

- **"Can't connect" / "service unavailable" on first start** — the container takes around 30 seconds to come up. Wait for `docker compose -f docker-compose.neo4j.yml ps` to show `healthy` before retrying.
- **"Authentication rate limit" / locked out** — too many bad-password attempts. Restart the container: `docker compose -f docker-compose.neo4j.yml restart neo4j`.
- **"Database does not exist"** — point `DEEP_MEMORY_NEO4J_DATABASE` at a database that exists (the bundled Docker compose has `neo4j` ready; on AuraDB it's also `neo4j` by default).
- **Connection URL errors against a single Neo4j server** — try `bolt://...` instead of `neo4j://...`. Use whichever URL your Neo4j provider tells you to use.
- **Port 7687 already in use** — change the left side of `7687:7687` in `docker-compose.neo4j.yml` and update `DEEP_MEMORY_NEO4J_URI` to match.

---

## What's next

- **SQL Server instead.** [quickstart-sqlserver.md](quickstart-sqlserver.md) uses SQL Server with the bundled Docker compose.
- **CosmosDB instead.** [quickstart-cosmosdb.md](quickstart-cosmosdb.md) uses the CosmosDB Gremlin API — local emulator on Windows, or an Azure account.
- **Enable semantic search.** [quickstart-embeddings.md](quickstart-embeddings.md) wires up an embeddings provider (bundled vLLM, OpenAI, Ollama, or Azure) so `memory_search_by_concept` works.
- **Build your own graph.** [quickstart-indexer.md](quickstart-indexer.md) runs the indexing pipeline over your source documents.
- **Provider reference.** [packages/storage-neo4j/README.md](packages/storage-neo4j/README.md) — the full Neo4j provider docs (configuration, behaviour, licensing).
- **MCP tools.** [packages/mcp-server/README.md](packages/mcp-server/README.md) lists all 29 tools.
