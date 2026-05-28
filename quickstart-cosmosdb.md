# Quickstart — CosmosDB Gremlin

Same flow as the [in-memory quickstart](quickstart-inmemory.md), but the graph lives in Azure CosmosDB (Gremlin API). The CosmosDB provider implements both `StorageProvider` and `GraphTraversalProvider`, so one instance gives you persistent storage **and** native graph queries.

Two paths:

- **Local CosmosDB emulator** — free, Windows-only, perfect for evaluating the provider.
- **Azure CosmosDB account** — production-ready; you pay for the Request Units you consume.

**You'll need:** Node.js 22 or 24 (the supported LTS pair), [Claude Code](https://claude.com/claude-code) or another AI, and either Windows + the [CosmosDB Emulator](https://learn.microsoft.com/en-us/azure/cosmos-db/local-emulator) or an Azure subscription.  Make sure the gremlin endpoint is enabled in the emulator.

> The Docker CosmosDB emulator does **not** support the Gremlin API. Local evaluation requires the Windows desktop emulator. If you're on macOS/Linux without a Windows machine, use an Azure account (the lowest tier is inexpensive for evaluation).

---

## 1. Clone and build

```bash
git clone https://github.com/TjWheeler/deep-memory.git
cd deep-memory
pnpm install
pnpm build
```

## 2. Start CosmosDB

### Option A — Local emulator (Windows)

From an **admin** PowerShell:

```powershell
& "C:\Program Files\Azure Cosmos DB Emulator\Microsoft.Azure.Cosmos.Emulator.exe" `
  /AllowNetworkAccess `
  /Key=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw== `
  /EnableGremlinEndpoint
  /DisableRateLimiting
```

**Security Note** - this enables cosmosdb on your network.  Make sure you don't run this on an untrusted network.  You can remove '/AllowNetworkAccess' but you may have connectivity problems depending on how you run the local mcp server.

This exposes:
- REST API on `https://localhost:8081` (used by `ensureSchema()` to create the database/container)
- Gremlin endpoint on `ws://localhost:8901`

The key above is the well-known emulator default — same for everyone. Don't reuse it in production.

If you're connecting from WSL2, swap `localhost` for `host.docker.internal` and add firewall rules — see the [CosmosDB provider README](packages/storage-cosmosdb/README.md#starting-with-network-access-required-for-wsl2).

### Option B — Azure account

1. Create a CosmosDB account with the **Apache Gremlin** API in the Azure portal.
2. Note the Gremlin endpoint (e.g. `wss://your-account.gremlin.cosmos.azure.com:443/`).
3. Copy the primary key from the **Keys** blade.

You don't need to pre-create the database or container — `memory_ensure_schema` does that for you.

## 3. Wire the MCP server into Claude Code

Copy the example file and edit the `deep-memory` entry to use CosmosDB:

```bash
cp .mcp.json.example .mcp.json
```

### Emulator config

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "cosmosdb",
        "DEEP_MEMORY_COSMOSDB_ENDPOINT": "ws://localhost:8901/",
        "DEEP_MEMORY_COSMOSDB_REST_ENDPOINT": "https://localhost:8081",
        "DEEP_MEMORY_COSMOSDB_KEY": "C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==",
        "DEEP_MEMORY_COSMOSDB_DATABASE": "deep-memory",
        "DEEP_MEMORY_COSMOSDB_CONTAINER": "graph",
        "DEEP_MEMORY_COSMOSDB_REJECT_UNAUTHORIZED": "false"
      }
    }
  }
}
```

Note: emulator uses `ws://` (plain WebSocket) **not** `wss://`, and `REJECT_UNAUTHORIZED` must be `false` because the emulator uses a self-signed certificate.

### Azure config

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "cosmosdb",
        "DEEP_MEMORY_COSMOSDB_ENDPOINT": "wss://your-account.gremlin.cosmos.azure.com:443/",
        "DEEP_MEMORY_COSMOSDB_KEY": "<your primary key>",
        "DEEP_MEMORY_COSMOSDB_DATABASE": "deep-memory",
        "DEEP_MEMORY_COSMOSDB_CONTAINER": "graph"
      }
    }
  }
}
```

Azure uses `wss://`, the default REST endpoint is derived from the Gremlin hostname so you can omit `DEEP_MEMORY_COSMOSDB_REST_ENDPOINT`, and `REJECT_UNAUTHORIZED` stays at its default (`true`).

> **Don't commit `.mcp.json` with real keys.** It's gitignored. For production, use your AI client's secret-management feature or a secrets manager rather than inlining the key.

## 4. Restart Claude Code

Restart Claude Code so it loads the new server. Confirm via `/mcp` that `deep-memory` shows connected with 29 tools.

## 5. Create the database and container

Paste this:

> Use `memory_ensure_schema` to create the CosmosDB database and container if they don't already exist. Tell me what was created.

This creates the database (`deep-memory`), the container (`graph`) partitioned by `/repositoryId`, and writes the `_meta` schema-version vertex. Idempotent — safe to re-run.

## 6. Load the sample graph

The repo ships a fictitious "Person" sample at [exports/person-sample-v1.0.dkg](exports/person-sample-v1.0.dkg) — 26 entities, 35 relationships.

> Import the sample knowledge graph from `exports/person-sample-v1.0.dkg` as a new repository. Use `mode: "create"` and generate a fresh UUID for the repository ID. Then open the repository and show me the stats.

Import on CosmosDB uses adaptive concurrency — it'll ramp up and back off as RU throttling allows. On the free emulator or a low-RU Azure tier this can take 10–30 seconds for the sample.

## 7. Chat with the graph

> Find all people in the graph and tell me where each one works.

> Show me everyone connected to Robert Chen within two hops, with the relationships labelled.

> Who lives in Berlin?

> Which two people in this graph are married?

CosmosDB executes traversals natively via Gremlin — `memory_explore_neighborhood`, `memory_find_paths`, and `memory_query_graph` push work to the database instead of materialising everything client-side.

## 8. Verify persistence and inspect

Restart the `deep-memory` MCP server (in Claude Code: `/mcp` → disconnect/reconnect, or restart Claude). Then:

> Open the repository I just imported and show me the stats.

Still there. The graph is independent of the MCP server.

To inspect raw vertices via the Data Explorer:
- **Emulator:** open `https://localhost:8081/_explorer/index.html`
- **Azure:** Data Explorer in the portal

Both let you run Gremlin queries directly against the graph.

---

## Using a different MCP client

Same JSON shape, different config file location. See the [in-memory quickstart's MCP client section](quickstart-inmemory.md#using-a-different-mcp-client) for snippets — merge the CosmosDB `env` block into the example shown there.

For Claude Desktop, you'll need the absolute path to `packages/mcp-server/dist/index.js`.

---

## Troubleshooting

- **`ECONNREFUSED` on `ws://localhost:8901`** — the emulator either isn't running or didn't start with `/EnableGremlinEndpoint`. Restart with the full PowerShell command from section 2.
- **TLS errors on Gremlin** — use `ws://` (not `wss://`) for the emulator and keep `DEEP_MEMORY_COSMOSDB_REJECT_UNAUTHORIZED=false`. For Azure, the inverse: `wss://` and `true`.
- **`429 Too Many Requests` during import** — the provider retries automatically. If imports are very slow, raise the RU/s on your Azure container or accept that the emulator throttles harder than production.
- **Emulator crash loop or stuck state** — delete `%LOCALAPPDATA%\CosmosDBEmulator` and restart. The provider README has the full troubleshooting table.

---

## What's next

- **SQL Server instead.** [quickstart-sqlserver.md](quickstart-sqlserver.md) uses SQL Server with the bundled Docker compose — works on macOS/Linux/Windows.
- **Neo4j instead.** [quickstart-neo4j.md](quickstart-neo4j.md) uses Neo4j Community Edition over Bolt — native Cypher graph storage with the bundled Docker compose, or AuraDB / self-hosted.
- **Enable semantic search.** [quickstart-embeddings.md](quickstart-embeddings.md) wires up an embeddings provider (bundled vLLM, OpenAI, Ollama, or Azure) so `memory_search_by_concept` works.
- **Build your own graph.** [quickstart-indexer.md](quickstart-indexer.md) runs the indexing pipeline over your source documents.
- **Provider reference.** [packages/storage-cosmosdb/README.md](packages/storage-cosmosdb/README.md) covers the data model, Gremlin capabilities, RU cost considerations, and the adaptive bulk-import controller.
- **MCP tools.** [packages/mcp-server/README.md](packages/mcp-server/README.md) lists all 29 tools.
