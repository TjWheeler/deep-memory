# Quickstart — Embeddings (Semantic Search)

Deep Memory works without an embeddings provider — you just can't search by meaning. With embeddings configured:

- `memory_search_by_concept` works — "find equipment related to engine cooling", "find people who work in compliance".
- Vocabulary deduplication uses vector similarity instead of Jaro-Winkler string matching, so near-synonyms (`"Supplier"` vs `"Vendor"`) collapse correctly.

This quickstart assumes you already have a storage quickstart working ([SQL Server](quickstart-sqlserver.md), [CosmosDB](quickstart-cosmosdb.md), [Claude Desktop](quickstart-claude-desktop.md), or [in-memory](quickstart-inmemory.md)). You'll add a few environment variables to the same `.mcp.json` (or `claude_desktop_config.json`) and restart.

**Time:** 2 minutes for OpenAI or Ollama; ~10 minutes for the bundled vLLM container on first run (model download).

---

## Pick a backend

| Backend | Cost | Privacy | Needs | When to choose |
|---------|------|---------|-------|----------------|
| **vLLM (bundled)** | Free | Fully local | NVIDIA GPU (8 GB+ VRAM), Docker | You have a GPU; large repos; iterative re-embedding |
| **OpenAI** | ~$0.02 / 1M tokens | Data leaves your machine | API key, internet | No local GPU; small repos; quickest setup |
| **Ollama** | Free | Fully local | Ollama installed (CPU is fine) | No GPU; want local privacy; OK with slower throughput |
| **Azure OpenAI** | Per-deployment | Stays in your Azure tenant | Azure resource | Enterprise/compliance contexts |

The deep-memory MCP server speaks the OpenAI Embeddings API, so any compatible server works — vLLM, OpenAI, Ollama, Azure OpenAI, HuggingFace TEI, LiteLLM, etc.

---

## Path A — Bundled vLLM (local GPU)

The repo's `docker-compose.yml` includes a ready-to-use vLLM service serving [Qwen3-Embedding-8B](https://huggingface.co/Qwen/Qwen3-Embedding-8B) on port **8010**. It's gated behind the `embeddings` Compose profile so it doesn't auto-start unless asked.

### 1. Start the embeddings server

```bash
docker compose up vllm-embeddings -d
```

First run downloads ~15 GB of model weights into the `huggingface_cache` volume — expect 5–10 minutes on a typical connection. Subsequent starts are seconds.

Check progress:

```bash
docker compose logs -f vllm-embeddings
```

Wait until you see `Application startup complete` and `Uvicorn running on http://0.0.0.0:8000`.

Smoke-test the endpoint:

```bash
curl http://localhost:8010/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": ["hello"], "model": "Qwen/Qwen3-Embedding-8B"}'
```

You should get a JSON response with a `data[0].embedding` array.

### 2. Add the env block

Add these two lines to the `env` block of your existing `deep-memory` MCP entry:

```json
"DEEP_MEMORY_EMBEDDINGS_BASE_URL": "http://localhost:8010",
"DEEP_MEMORY_EMBEDDINGS_MODEL": "Qwen/Qwen3-Embedding-8B"
```

No API key is needed — the bundled vLLM container has no auth.

### 3. Restart your MCP client

Quit and reopen Claude Code / Claude Desktop / Cursor / etc. so the new env vars are picked up. The tool count stays at 28, but `memory_search_by_concept` now works.

---

## Path B — OpenAI

### 1. Get an API key

From <https://platform.openai.com/api-keys>. The `text-embedding-3-small` model is the cheapest and is more than good enough for most use cases.

### 2. Add the env block

```json
"DEEP_MEMORY_EMBEDDINGS_BASE_URL": "https://api.openai.com",
"DEEP_MEMORY_EMBEDDINGS_MODEL": "text-embedding-3-small",
"DEEP_MEMORY_EMBEDDINGS_DIMENSIONS": "1536",
"DEEP_MEMORY_EMBEDDINGS_API_KEY": "sk-..."
```

> **Don't commit `.mcp.json` with a real API key.** It's gitignored by default at the repo root. For long-lived setups, put the key in `.env.local` (also gitignored) — see [`.env.example`](.env.example) — and leave the non-secret fields in `.mcp.json`.

### 3. Restart your MCP client

Same as Path A.

---

## Path C — Ollama (local, CPU)

### 1. Install Ollama and pull a model

From <https://ollama.com/download>. Then:

```bash
ollama pull nomic-embed-text
```

`nomic-embed-text` is a small, CPU-friendly embedding model. For higher quality on technical content, try `mxbai-embed-large` instead.

Ollama runs as a background service on port **11434** after install.

### 2. Add the env block

```json
"DEEP_MEMORY_EMBEDDINGS_BASE_URL": "http://localhost:11434",
"DEEP_MEMORY_EMBEDDINGS_MODEL": "nomic-embed-text"
```

No API key needed.

### 3. Restart your MCP client

Same as Path A.

---

## Path D — Azure OpenAI

```json
"DEEP_MEMORY_EMBEDDINGS_BASE_URL": "https://<resource>.openai.azure.com/openai/deployments/<deployment>",
"DEEP_MEMORY_EMBEDDINGS_MODEL": "text-embedding-3-small",
"DEEP_MEMORY_EMBEDDINGS_API_KEY": "<azure-key>"
```

The `<resource>` and `<deployment>` segments come from your Azure OpenAI resource and the embeddings deployment you created in it.

---

## Verify it works

In your MCP client, paste:

> Open my repository, create a Person entity called "Test User" with summary "A senior software engineer who works on distributed systems and database performance", then run a concept search for "backend developer" and tell me whether Test User comes back.

The model should call `memory_create_entities` then `memory_search_by_concept`. If the search returns Test User with a non-trivial similarity score, embeddings are wired up correctly.

---

## Switching providers later

Vectors from different embedding models are not comparable. If you change `DEEP_MEMORY_EMBEDDINGS_MODEL` (or the underlying provider), existing entities still carry the old vectors and semantic search degrades.

To migrate:

> Use `memory_reembed_repository` on my current repository to re-embed all entities with the new model.

`memory_reembed_repository` clears the old vectors and regenerates them with whatever embedding provider is currently configured.

---

## Configuration reference

All four embeddings environment variables read by the MCP server:

| Variable | Default | Description |
|----------|---------|-------------|
| `DEEP_MEMORY_EMBEDDINGS_BASE_URL` | — | Base URL of an OpenAI-compatible embeddings API. Omit to disable semantic search. |
| `DEEP_MEMORY_EMBEDDINGS_MODEL` | — | Model identifier sent in API requests |
| `DEEP_MEMORY_EMBEDDINGS_DIMENSIONS` | auto-detected | Embedding vector dimensionality. Required only when the model supports configurable dimensions (e.g. OpenAI `text-embedding-3-*`). |
| `DEEP_MEMORY_EMBEDDINGS_API_KEY` | — | Bearer token. Not needed for local servers (vLLM, Ollama). |

Omitting `DEEP_MEMORY_EMBEDDINGS_BASE_URL` is the supported way to run without embeddings — Deep Memory falls back to Jaro-Winkler string similarity for vocabulary deduplication and `memory_search_by_concept` becomes unavailable.

---

## Troubleshooting

**`memory_search_by_concept` returns "embeddings not configured".**

The MCP server didn't see `DEEP_MEMORY_EMBEDDINGS_BASE_URL` at startup. Fully quit and reopen your MCP client — env changes only apply on process restart. Double-check the env block is inside the `deep-memory` server entry, not at the top level of the JSON file.

**`ECONNREFUSED` on `http://localhost:8010`.**

vLLM isn't running. Check `docker compose ps vllm-embeddings` — the status should be `Up X minutes`. If it exited, `docker compose logs vllm-embeddings` will show why (most common: no NVIDIA runtime, or VRAM too small).

**`401 Unauthorized` from OpenAI / Azure.**

The key is missing or wrong. Confirm it's set in `DEEP_MEMORY_EMBEDDINGS_API_KEY` and that the value isn't wrapped in extra quotes inside the JSON.

**Search returns no results or junk after switching models.**

Vectors from the old model are still in storage. Run `memory_reembed_repository` to regenerate them.

**Search returns results but they all look unrelated.**

The default similarity threshold (0.7) is tuned for general content. Technical domains often need lower thresholds. See the [embeddings tuning notes](docs/indexer-embeddings-guide.md#semantic-search-threshold-tuning).

---

## What's next

- **Index your own documents.** The indexing pipeline can call the same embeddings endpoint at the end of its phases. See [quickstart-indexer.md](quickstart-indexer.md).
- **Provider reference.** [packages/embeddings-openai/README.md](packages/embeddings-openai/README.md) covers the underlying TypeScript provider and additional backends (HuggingFace TEI, LiteLLM, etc.).
- **Tune semantic search.** [docs/indexer-embeddings-guide.md](docs/indexer-embeddings-guide.md#semantic-search-threshold-tuning) covers similarity threshold tuning by domain.
