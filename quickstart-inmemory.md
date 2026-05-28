# Quickstart — In-Memory

The fastest way to see Deep Memory work: clone the repo, wire the MCP server into Claude Code, then ask Claude to load and explore a sample knowledge graph. No database, no API keys, no Docker. Everything lives in memory and resets when the MCP server restarts.

**You'll need:** Node.js 22 or 24 (the supported LTS pair), [Claude Code](https://claude.com/claude-code) or another AI, and a few minutes.

---

## 1. Clone and build

```bash
git clone https://github.com/TjWheeler/deep-memory.git
cd deep-memory
pnpm install
pnpm build
```

The `pnpm build` step compiles the MCP server (and every other package). It only needs to run once.

## 2. Wire the MCP server into Claude Code

A `.mcp.json.example` ships at the repo root. Copy it to `.mcp.json` (which is gitignored):

```bash
cp .mcp.json.example .mcp.json
```

The relevant entry already uses the in-memory provider — no edits needed:

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent"
      }
    }
  }
}
```

In-memory is the default — you don't need to set `DEEP_MEMORY_STORAGE`. To switch storage providers later, see [`quickstart-sqlserver.md`](quickstart-sqlserver.md) or [`quickstart-cosmosdb.md`](quickstart-cosmosdb.md).

## 3. Restart Claude Code

After editing `.mcp.json`, restart Claude Code so it picks up the new server. Open the MCP panel (or run `/mcp` in chat) and confirm `deep-memory` shows as connected with 29 tools available.

## 4. Load the sample graph

The repo ships with a fictitious "Person" knowledge graph at [`exports/person-sample-v1.0.dkg`](exports/person-sample-v1.0.dkg) — 26 entities (people, organisations, identities, locations) and 35 relationships, built from the source documents in [`index-content/person/`](index-content/person/).

Paste this into Claude Code:

> Import the sample knowledge graph from `exports/person-sample-v1.0.dkg` as a new repository. Use `mode: "create"` and generate a fresh UUID for the repository ID. Once imported, open the repository and show me the stats.

Claude will call `memory_import_repository` with `mode: "create"`, then `memory_open_repository`, then `memory_get_stats`. You should see something like:

```
Imported: 26 entities, 35 relationships
Entity types: Person (6), Organization (10), Identity (6), Location (4)
Relationship types: WORKS_AT (9), IS_IDENTITY_FOR (6), STUDIED_AT (4), LIVES_IN (4),
                    LOCATED_IN (4), INVOLVED_IN (3), IS_MARRIED_TO (2), KNOWS (1),
                    FOUNDED (1), MEMBER_OF (1)
```

## 5. Chat with the graph

The whole point of Deep Memory is that an AI can now reason over this graph. Try prompts like:

> Find all people in the graph and tell me where each one works.

> Who does Alice Johnson know, and how do they know each other?

> Show me everyone connected to Robert Chen within two hops. What's their relationship?

> Is Priya Patel related to anyone in the graph? If so, how?

> Which organisations are based in Berlin?

Claude will mix `memory_find_entities`, `memory_get_relationships`, `memory_explore_neighborhood`, and `memory_find_paths` to answer. You can ask it to explain which tools it used.

## 6. Mutate the graph

Try writing back:

> Add a new person called "Sam Carter" who works at Nexus Technologies as a security engineer. Sam started in March 2024 and lives in Berlin.

Then verify:

> Show me everyone who works at Nexus Technologies.

The in-memory store keeps all of this until the MCP server restarts. To persist data across restarts, see the SQL Server or CosmosDB quickstarts.

---

## Using a different MCP client

The same MCP server works with any MCP-compatible AI client. Snippets below assume you've already done steps 1–2 above.

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["<absolute path to>/deep-memory/packages/mcp-server/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop. Note: Desktop needs an absolute path because it has no notion of a project root.

### Cursor

Edit `~/.cursor/mcp.json` or the project-level `.cursor/mcp.json` with the same shape as Claude Code's `.mcp.json`:

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"]
    }
  }
}
```

### Cline (VS Code extension)

In the Cline panel: settings → MCP Servers → add a server. The config format is the same JSON shape.

### Any client, no clone — npm install path

If you're integrating Deep Memory into your own project rather than evaluating it inside the cloned repo:

```bash
npm install @utaba/deep-memory-local-mcp-server
```

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "npx",
      "args": ["-y", "@utaba/deep-memory-local-mcp-server"]
    }
  }
}
```

You'll need to download or build your own `.dkg` for this path — the sample lives in the cloned repo.

---

## What's next

- **Make it persistent.** [`quickstart-sqlserver.md`](quickstart-sqlserver.md) walks you through wiring SQL Server (Docker or existing instance). [`quickstart-cosmosdb.md`](quickstart-cosmosdb.md) does the same for CosmosDB Gremlin.
- **Enable semantic search.** [`quickstart-embeddings.md`](quickstart-embeddings.md) wires up an embeddings provider (bundled vLLM, OpenAI, Ollama, or Azure) so `memory_search_by_concept` works.
- **Build your own graph.** [`quickstart-indexer.md`](quickstart-indexer.md) runs the indexing pipeline over your source documents to produce a `.dkg` like the sample.
- **Browse the tools.** [`packages/mcp-server/README.md`](packages/mcp-server/README.md) is the full reference for the 29 MCP tools.
- **Browse the API.** [`packages/core/README.md`](packages/core/README.md) covers using Deep Memory as a library directly (no MCP layer).
