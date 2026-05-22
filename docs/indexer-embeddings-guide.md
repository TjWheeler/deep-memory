# Indexer Embeddings Guide

Practical guide to the embeddings phase (Phase E) of the deep-memory indexing pipeline. Embeddings run after import is complete.

## What Embeddings Do

After import, entities in the knowledge graph are text-only. You can find them by exact label, slug, alias, or graph traversal -- but you cannot search by meaning.

Embeddings generate vector representations of each entity, enabling semantic search. With embeddings in place, queries like these become possible:

- "Find equipment similar to excavators"
- "What components relate to hydraulic systems?"
- "Show me entities related to engine cooling"

Each entity is embedded by combining its label and summary into a text string, then sending that text to an embeddings model. The returned vector is stored alongside the entity for similarity search at query time.

## Configuration

The embeddings section in your `config.json` controls the model endpoint, batch sizing, and cost tracking:

```json
{
  "embeddings": {
    "endpoint": "http://localhost:8010/v1",
    "model": "Qwen/Qwen3-Embedding-8B",
    "batchSize": 50,
    "costPerMillionTokens": 0,
    "averageTokensPerEntity": 25
  }
}
```

### Configuration Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `endpoint` | string | required | OpenAI-compatible `/v1/embeddings` endpoint URL |
| `model` | string | required | Model name at the endpoint |
| `apiKey` | string | -- | API key for authenticated endpoints (cloud models) |
| `dimensions` | number | -- | Output dimensions, if the model supports configurable dimensionality |
| `batchSize` | number | 50 | Entities per API request (max 200) |
| `delayBetweenBatchesMs` | number | 0 | Rate limiting delay between batches in milliseconds |
| `maxRetries` | number | 3 | Retries per batch on API failure, with exponential backoff |
| `errorThresholdToAbort` | number | -- | Abort after this many cumulative failures. Omit for no limit |
| `costPerMillionTokens` | number | 0 | Cost per 1M tokens in USD, for estimation and tracking |
| `averageTokensPerEntity` | number | 25 | Average tokens per entity text, for cost estimation |

### Multi-Worker Configuration

For large repositories or mixed local/cloud setups, configure a worker pool:

```json
{
  "embeddings": {
    "endpoint": "http://localhost:8010/v1",
    "model": "Qwen/Qwen3-Embedding-8B",
    "workers": [
      {
        "name": "local-gpu",
        "endpoint": "http://localhost:8010/v1",
        "model": "Qwen/Qwen3-Embedding-8B",
        "batchSize": 100,
        "concurrency": 2,
        "costPerMillionTokens": 0,
        "weight": 3
      },
      {
        "name": "openai-api",
        "endpoint": "https://api.openai.com/v1",
        "model": "text-embedding-3-small",
        "apiKey": "sk-...",
        "batchSize": 50,
        "concurrency": 1,
        "costPerMillionTokens": 0.02,
        "weight": 1
      }
    ]
  }
}
```

When workers are configured, entities are split across workers by range based on their `weight` values. A worker with weight 3 gets three times as many entities as a worker with weight 1.

## Running Embeddings

The embedding phase is driven through the indexer MCP tools:

```
indexing_update phase: "embeddings"
indexing_execute
```

The first `indexing_execute` call shows a cost estimate based on total entities, average tokens per entity, and cost per million tokens. Review the estimate, then confirm:

```
indexing_execute confirm: true
```

This starts the embedding process. For local models, cost is $0 and confirmation is a formality. For cloud models, review the estimate before confirming.

Embedding runs in the background with progress saved to disk between batches. Monitor progress:

```
indexing_status
```

When complete, transition to the final phase:

```
indexing_update phase: "complete"
```

### Stopping a Running Embedding

If you need to stop embedding mid-run (e.g., to adjust configuration or fix an endpoint issue):

```
indexing_stop
```

The orchestrator checks the stop signal between batches. Already-embedded entities keep their vectors -- only unprocessed entities remain without embeddings. You can resume by running `indexing_execute confirm: true` again after fixing the issue.

## Cost Estimation

The tool calculates estimated cost as:

```
cost = (totalEntities * averageTokensPerEntity * costPerMillionTokens) / 1,000,000
```

For typical values:

| Scenario | Entities | Avg Tokens | Cost/1M Tokens | Estimated Cost |
|----------|----------|------------|----------------|----------------|
| Local model | 2,000 | 25 | $0.00 | $0.00 |
| OpenAI small | 2,000 | 25 | $0.02 | $0.001 |
| OpenAI small | 50,000 | 25 | $0.02 | $0.025 |
| Large cloud run | 500,000 | 30 | $0.02 | $0.30 |

Embedding is one of the cheapest operations in the pipeline. Even large repositories with cloud models rarely exceed a few cents.

## Progress Monitoring

Use `indexing_status` to check embedding progress. The status includes:

- **processed / totalEntities**: How many entities have been embedded
- **completedBatches / totalBatches**: Batch completion count
- **elapsedMs / estimatedRemainingMs**: Timing and ETA
- **dimensions**: Vector dimensionality (detected from first successful batch)
- **status**: `running`, `stopped`, `complete`, or `failed`
- **errors**: Up to 20 recent error entries with entity ID and error message
- **workerStats** (multi-worker only): Per-worker breakdown with processed count, failed count, completed batches, total tokens, estimated cost, and status

### Interpreting Progress

- **Steady progress with no errors**: Normal operation. Wait for completion.
- **Errors accumulating**: Check the error messages. Common causes are endpoint connectivity issues, model loading failures, or out-of-memory on the embedding server.
- **Stopped status**: Either you sent a stop signal or the error threshold was reached. Check `stoppedReason` for details.
- **Failed status**: All batches failed or the error threshold was exceeded. Fix the underlying issue (usually the embedding endpoint) and rerun.

## Semantic Search Threshold Tuning

After embedding, semantic search quality depends on the similarity threshold used at query time. The threshold determines how close a vector match must be to be returned as a result.

### Default Threshold

A similarity threshold of 0.7 works well for general-purpose knowledge graphs. Most relevant results score above this, and most irrelevant results score below.

### Technical Domain Thresholds

Technical domains (engineering, mining, manufacturing) benefit from lower thresholds because technical terminology produces tighter vector clusters. Recommended ranges:

| Query Type | Similarity Range | Notes |
|------------|-----------------|-------|
| Equipment and component queries | 0.70+ | Direct matches between similar equipment types |
| Process and procedure queries | 0.60 - 0.65 | Procedural text varies more in phrasing |
| Troubleshooting queries | 0.55 - 0.59 | Problem descriptions use diverse vocabulary |
| Cross-domain queries | 0.50 - 0.55 | Concepts spanning multiple entity types |

Lower thresholds return more results with higher recall but lower precision. Start with the default 0.7 and lower it if relevant results are being missed.

### Tuning Process

1. Run a set of representative queries against your repository
2. Check whether expected entities appear in the results
3. If relevant entities are missing, lower the threshold by 0.05 increments
4. If irrelevant entities are polluting results, raise the threshold
5. Different query patterns may benefit from different thresholds -- configure per-use-case in your application

## Local vs Cloud Embedding Models

### Local Models

Running embeddings locally (via vLLM, llama.cpp, or Ollama) with a model like Qwen3-Embedding-8B:

- **Cost**: Zero. Embed and re-embed as many times as needed without budgeting concerns.
- **Privacy**: All data stays on your machine. No entity labels or summaries sent to external services.
- **Re-embedding**: Free re-embedding is valuable when iterating on extraction quality -- update entities, re-embed, test search quality, repeat.
- **Performance**: Depends on your GPU. A single consumer GPU (RTX 4090, 24GB VRAM) handles Qwen3-Embedding-8B comfortably. Batch sizes of 50-100 work well.
- **Quality**: Qwen3-Embedding-8B performs well on technical content. For domain-specific vocabularies (equipment names, part numbers, technical processes), local models match or exceed general-purpose cloud models because the embedding space is shaped by the model's training data, and technical terms cluster well regardless of model size.

See `docs/local-model-setup.md` for llama.cpp and vLLM setup instructions.

### Cloud Models

Using a cloud embedding API (OpenAI `text-embedding-3-small`, Azure OpenAI, etc.):

- **Cost**: $0.02 per 1M tokens for OpenAI's small model. Negligible for most repositories.
- **Quality**: Higher quality on general-purpose text (news, conversations, broad topics). The advantage diminishes on technical/specialized content.
- **Convenience**: No local GPU required. Works from any machine with internet access.
- **Latency**: Network round-trip adds latency per batch. Use the `delayBetweenBatchesMs` setting to stay within rate limits.

### Recommendation

For technical domains (engineering, mining, equipment maintenance), local models are the practical choice. Zero cost means unlimited iteration, and embedding quality on technical content is comparable to cloud models.

For general-purpose or mixed-domain repositories where you lack a local GPU, cloud embeddings are a cost-effective alternative -- even 50,000 entities costs under $0.03.

Do not mix embedding models within a single repository. All entities must use the same model so that vector similarity scores are meaningful. If you switch models, re-embed the entire repository.

## Troubleshooting

### Embedding Endpoint Not Responding

**Symptom**: All batches fail with connection errors.

**Fix**: Verify the endpoint is running and accessible. For local models, check that vLLM or llama.cpp is started and the model is loaded. Test with a direct curl:

```bash
curl http://localhost:8010/v1/embeddings \
  -H "Content-Type: application/json" \
  -d '{"input": ["test"], "model": "Qwen/Qwen3-Embedding-8B"}'
```

### Out of Memory on Embedding Server

**Symptom**: Batches fail intermittently or after several successful batches.

**Fix**: Reduce `batchSize`. Large batches consume more memory on the embedding server. Try 25 or 10 instead of 50.

### Slow Embedding Speed

**Symptom**: ETA is very long for the entity count.

**Fix**: Increase `batchSize` (up to 200) to reduce API round-trips. For multi-worker setups, increase `concurrency` per worker. Ensure the embedding server has enough VRAM and is not sharing the GPU with other workloads.

### Dimension Mismatch After Model Change

**Symptom**: Search returns no results or poor results after switching embedding models.

**Fix**: Re-embed the entire repository. Vectors from different models are not comparable. Use `memory_reembed_repository` to clear and regenerate all vectors.
