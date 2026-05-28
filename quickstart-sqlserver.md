# Quickstart — SQL Server

Same flow as the [in-memory quickstart](quickstart-inmemory.md), but the graph lives in SQL Server so it survives restarts. The repo ships a `docker-compose.sqlserver.yml` that brings up SQL Server with full-text search enabled — you can be querying a persistent graph in a few minutes.

**You'll need:** Node.js 22 or 24 (the supported LTS pair), [Claude Code](https://claude.com/claude-code) or another AI, Docker Desktop (or an existing SQL Server 2016+ instance).

---

## 1. Clone and build

```bash
git clone https://github.com/TjWheeler/deep-memory.git
cd deep-memory
pnpm install
pnpm build
```

## 2. Start SQL Server

```bash
docker compose -f docker-compose.sqlserver.yml up -d
```

This builds the bundled image (Microsoft's SQL Server 2025 with full-text search) and exposes port **1435** on the host, mapped to 1433 in the container. The `sa` password is `DeepMem@Dev1234`.

> SQL Server's default port is **1433**. The bundled compose uses **1435** on the host to avoid clashing with any pre-existing SQL Server install on this machine. If you're pointing Deep Memory at a different SQL Server instance instead of the bundled one, check what port that server is actually listening on (1433 for a default install) and set `DEEP_MEMORY_SQL_PORT` to match.

Wait for the health check to go green (about a minute on first run):

```bash
docker compose -f docker-compose.sqlserver.yml ps
```

Once `health: starting` becomes `healthy`, create the `deep-memory` database:

```bash
docker exec deep-memory-sqlserver /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'DeepMem@Dev1234' -C \
  -Q "CREATE DATABASE [deep-memory]"
```

If you already have a SQL Server instance, skip the compose step — just create a database and have credentials ready.

## 3. Wire the MCP server into Claude Code

Copy the example file and edit the `deep-memory` server entry to use SQL Server:

```bash
cp .mcp.json.example .mcp.json
```

Edit `.mcp.json` so the `deep-memory` entry looks like this:

```json
{
  "mcpServers": {
    "deep-memory": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "env": {
        "DEEP_MEMORY_ACTOR_ID": "mcp-agent",
        "DEEP_MEMORY_ACTOR_TYPE": "agent",
        "DEEP_MEMORY_STORAGE": "sqlserver",
        "DEEP_MEMORY_SQL_HOST": "localhost",
        "DEEP_MEMORY_SQL_PORT": "1435",
        "DEEP_MEMORY_SQL_DATABASE": "deep-memory",
        "DEEP_MEMORY_SQL_USER": "sa",
        "DEEP_MEMORY_SQL_PASSWORD": "DeepMem@Dev1234",
        "DEEP_MEMORY_SQL_TRUST_CERT": "true"
      }
    }
  }
}
```

For a non-Docker SQL Server, change `DEEP_MEMORY_SQL_HOST` / `DEEP_MEMORY_SQL_PORT` and use your real credentials. Set `DEEP_MEMORY_SQL_TRUST_CERT` to `false` if you have a valid TLS cert. For a custom schema (default `dbo`), set `DEEP_MEMORY_SQL_SCHEMA`.

> **Don't commit `.mcp.json` with real passwords.** It's gitignored by default. Use a vault, your shell environment, or your AI client's secret-management feature instead of inlining production credentials.

## 4. Restart Claude Code

Restart Claude Code so it loads the new server. Confirm via `/mcp` that `deep-memory` shows connected with 29 tools.

## 5. Create the tables

Paste this:

> Use `memory_ensure_schema` to create the Deep Memory tables in the connected SQL Server database. Then show me what was created.

Claude calls `memory_ensure_schema`. The tool creates the `dm_*` tables, indexes, and the search stored procedure idempotently — safe to re-run.

## 6. Load the sample graph

The repo ships a fictitious "Person" sample at [exports/person-sample-v1.0.dkg](exports/person-sample-v1.0.dkg) — 26 entities, 35 relationships.

> Import the sample knowledge graph from `exports/person-sample-v1.0.dkg` as a new repository. Use `mode: "create"` and generate a fresh UUID for the repository ID. Then open the repository and show me the stats.

You should see the same breakdown as the in-memory quickstart (6 Person, 10 Organization, 6 Identity, 4 Location), now persisted in SQL Server.

## 7. Chat with the graph

> Find all people in the graph and tell me where each one works.

> Who does Alice Johnson know, and how do they know each other?

> Show me everyone connected to Robert Chen within two hops.

> Which organisations are based in Berlin?

## 8. Verify persistence

This is the headline difference vs in-memory. In Claude Code, run `/mcp` and disconnect the `deep-memory` server, then reconnect it (or restart Claude Code). Then ask:

> Open the repository I just imported and show me the stats.

The graph is still there. The data lives in SQL Server, independent of the MCP server's lifecycle.

To inspect the raw tables:

```bash
docker exec -it deep-memory-sqlserver /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P 'DeepMem@Dev1234' -C -d deep-memory \
  -Q "SELECT TOP 10 entity_id, entity_type, label FROM dm_entities"
```

---

## Using a different MCP client

Same JSON shape, different config file location. See the [in-memory quickstart's MCP client section](quickstart-inmemory.md#using-a-different-mcp-client) for snippets — just merge the SQL Server `env` block into the example shown there.

For Claude Desktop, you'll need the absolute path to `packages/mcp-server/dist/index.js`.

---

## Troubleshooting

- **`Login failed for user 'sa'`** — the container needs a moment after `docker compose ... up` to finish initialising. Wait for `docker compose -f docker-compose.sqlserver.yml ps` to show `healthy` before retrying.
- **`Cannot open database "deep-memory"`** — you missed the `CREATE DATABASE` step in section 2.
- **TLS errors** — keep `DEEP_MEMORY_SQL_TRUST_CERT=true` for local Docker. Only set it to `false` when you have a real, verifiable certificate.
- **Port 1435 already in use** — change the host-side port in `docker-compose.sqlserver.yml` (left side of `1435:1433`) and update `DEEP_MEMORY_SQL_PORT` to match.

---

## What's next

- **CosmosDB instead.** [quickstart-cosmosdb.md](quickstart-cosmosdb.md) uses the CosmosDB Gremlin API — native graph storage with the local emulator or Azure.
- **Neo4j instead.** [quickstart-neo4j.md](quickstart-neo4j.md) uses Neo4j Community Edition over Bolt — native Cypher graph storage with the bundled Docker compose, or AuraDB / self-hosted.
- **Enable semantic search.** [quickstart-embeddings.md](quickstart-embeddings.md) wires up an embeddings provider (bundled vLLM, OpenAI, Ollama, or Azure) so `memory_search_by_concept` works.
- **Build your own graph.** [quickstart-indexer.md](quickstart-indexer.md) runs the indexing pipeline over your source documents.
- **Provider reference.** [packages/storage-sqlserver/README.md](packages/storage-sqlserver/README.md) covers the full schema, multi-tenancy, ER diagram, and query capabilities.
- **MCP tools.** [packages/mcp-server/README.md](packages/mcp-server/README.md) lists all 29 tools.
