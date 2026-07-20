# Quickstart — Indexer

How to build your own `.dkg` from source documents. The repo bundles 5 fictitious markdown files in [index-content/person/](index-content/person/) — exactly the kind of input the indexing pipeline is designed for. By the end of this quickstart you'll have re-built the sample `.dkg` that ships in [exports/](exports/) from those source documents, using Claude to drive the pipeline through MCP tools.

**You'll need:** Node.js 22 or 24 (the supported LTS pair), [Claude Code](https://claude.com/claude-code) or another AI, and either:

- An **Anthropic API key** (recommended — happy path with prompt caching; the person sample costs well under $0.10 to index), or
- A **local model** via llama.cpp or vLLM. See [docs/local-model-setup.md](docs/local-model-setup.md) for setup. Free but slower.

---

## 1. Clone and build

```bash
git clone https://github.com/TjWheeler/deep-memory.git
cd deep-memory
pnpm install
pnpm build
```

## 2. Wire both MCP servers into Claude Code

The indexer pipeline lives in a **separate** MCP server from the memory tools. You need both wired up — the indexer runs the pipeline, the memory server queries the resulting graph.

Copy the example file:

```bash
cp .mcp.json.example .mcp.json
```

The default `.mcp.json.example` already wires both servers. Open `.mcp.json` and confirm it looks like this:

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
    },
    "deep-memory-indexer": {
      "command": "node",
      "args": ["packages/indexer-mcp-server/dist/index.js"]
    }
  }
}
```

This uses the in-memory storage for the resulting graph. If you'd rather import the pipeline output into SQL Server or CosmosDB, follow the env-var blocks in [quickstart-sqlserver.md](quickstart-sqlserver.md) or [quickstart-cosmosdb.md](quickstart-cosmosdb.md) — the indexer doesn't care which storage you use; it imports into whichever repository you point it at.

## 3. Restart Claude Code

Restart Claude Code so it loads both servers. Confirm via `/mcp` that **deep-memory** (29 tools) and **deep-memory-indexer** (9 tools) both show connected.

## 4. Kick off the pipeline

Paste this into Claude Code:

> Read the indexer pipeline guidance, then initialise an indexing process at `./index-processes/person-quickstart` that indexes the bundled `index-content/person/` source documents using the `index-starterkits/person/` starter kit. Configure one Anthropic worker using `claude-haiku-4-5-20251001`. My Anthropic API key is `sk-ant-...` — please put it in the right secrets file, not in the prompt history. Once configured, walk me through each phase: tell me what's about to happen, run it, and pause before advancing to the next phase so I can review.

Claude will:

1. Call `indexing_getting_started` to orient itself on the pipeline.
2. Call `indexing_init` to scaffold `./index-processes/person-quickstart/` with `config.json`, `config.secrets.json`, and `process-state.md`.
3. Write your API key into `config.secrets.json` (it's gitignored).
4. Walk you through the phases: **prepare → extract → extraction-review → consolidate → import → embeddings → complete**, pausing at each gate.

> If you'd rather skip cloud models, replace the "Anthropic worker" sentence with: *"Configure one local worker pointing at my llama.cpp server on `http://localhost:8020/v1` running Qwen3.5-35B."* You don't need an API key for that path.

> **Indexing rich documents (PDF/DOCX/HTML/PPTX)?** Those sources are registered as `needs-conversion` during prepare and must be converted to Markdown before extraction. Start the conversion service first — `docker compose -f docker-compose.indexer.yml --profile docling-worker up -d` — then have Claude run `indexing_execute action: convert` and poll `indexing_status` until it finishes. Conversion runs asynchronously by default, so large documents convert reliably without a raised timeout, and `indexing_status` shows the live queue position while it works. Re-running convert skips any source that has not changed, and OCR is decided per document (scanned PDFs get it, born-digital ones stay fast). Plain-text sources (`.md/.txt/.json/.csv`) skip this step entirely.

## 5. Review and advance through phases

Use these follow-up prompts as you progress. Claude will already know to call the right `indexing_*` tools.

**During extraction:**

> Poll status until extraction reaches 100%, then summarise what came out — how many entities and relationships per source document?

**At extraction-review:**

> Run quality diagnostics. Show me any orphan relationships, duplicate entities, or label-quality warnings. If anything's off, walk me through fixes before we consolidate.

**Cost gates:**

The pipeline pauses before extraction and again before embedding to show you a cost estimate. Confirm or amend:

> What's the projected embedding cost? Use OpenAI's `text-embedding-3-large` model (1024 dimensions) so the output is compatible with the bundled sample. Proceed when you have the estimate.

**At completion:**

> Mark the process complete and confirm the repository ID I should use to query the result.

## 6. Query the result

Once the pipeline finishes, the memory server has a fresh repository populated with everything the indexer extracted.

> Open the repository the indexer just produced and show me the stats. Then find all people in the graph and tell me how each one is connected to Robert Chen.

The output should resemble what you'd see from importing [exports/person-sample-v1.0.dkg](exports/person-sample-v1.0.dkg) — same source documents, same starter kit, same shape of graph. Differences will reflect model choice and any vocabulary extensions Claude proposed during extraction.

To save your freshly-built graph as a portable `.dkg`:

> Export the repository to `./exports/my-person-sample.dkg`.

---

## Cost and model strategy

For the person sample (5 short documents, ~5 KB total):

- **Anthropic Haiku 4.5** with prompt caching — under $0.10. First chunk pays the full system-prompt price (~$0.02), subsequent chunks get the 90%-cheaper cache-read rate.
- **Local Qwen3.5-35B** — free, ~3-5× slower. Expect a higher orphan rate; budget time for diagnostics + cleanup.
- **Embeddings (OpenAI `text-embedding-3-large`)** — under $0.01 for the sample.

For real workloads, see [docs/indexer-extraction-guide.md](docs/indexer-extraction-guide.md) for chunk sizing, output token limits, and progressive context tuning. The full per-tool parameter reference lives in [packages/indexer-mcp-server/README.md](packages/indexer-mcp-server/README.md).

---

## Using a different MCP client

The indexer MCP server has the same JSON shape as the memory server — see the [in-memory quickstart's MCP client section](quickstart-inmemory.md#using-a-different-mcp-client). For Claude Desktop, use absolute paths to `packages/indexer-mcp-server/dist/index.js` and `packages/mcp-server/dist/index.js`.

---

## Troubleshooting

- **MCP server didn't pick up the rebuild.** The MCP server runs as a subprocess and doesn't hot-reload. After `pnpm build`, restart Claude Code (or run `/mcp` → disconnect/reconnect on each server).
- **API key not configured.** Anthropic credentials must live in `index-processes/<your-process>/config.secrets.json`, not in env vars. The `indexing_init` tool creates the file; Claude or you fills it in.
- **Source directory empty.** The `sourceDir` in `config.json` must point to a directory containing `.md` or `.txt` files. Default for this quickstart is `./index-content/person/` — verify the files are there.
- **Local model unreachable.** `curl http://localhost:8020/v1/models` should list the loaded model. If it errors, check [docs/local-model-setup.md](docs/local-model-setup.md).
- **Extraction times out on a chunk.** Reduce `maxChunkSize` or `maxOutputTokens` in the worker config inside `config.json`. Smaller chunks fit context windows more reliably.

---

## What's next

- **Persist the output.** Run the same pipeline but with SQL Server or CosmosDB wired for the memory server. See [quickstart-sqlserver.md](quickstart-sqlserver.md) or [quickstart-cosmosdb.md](quickstart-cosmosdb.md).
- **Tune for your domain.** [docs/indexer-validation.md](docs/indexer-validation.md), [docs/indexer-extraction-guide.md](docs/indexer-extraction-guide.md), and [docs/indexer-review-guide.md](docs/indexer-review-guide.md) cover quality scoring, chunk sizing, and post-extraction review.
- **Build a custom starter kit.** [docs/indexer-starterkit-guide.md](docs/indexer-starterkit-guide.md) walks through creating a new vocabulary + domain guidance for a domain not covered by the bundled kits.
- **Full pipeline reference.** [packages/indexer/README.md](packages/indexer/README.md) covers worker configuration, multi-worker routing, AI–human collaboration loops, and the orchestrator/worker types.
- **Tool reference.** [packages/indexer-mcp-server/README.md](packages/indexer-mcp-server/README.md) — every `indexing_*` parameter, every phase.
