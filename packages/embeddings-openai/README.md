# @utaba/deep-memory-embeddings-openai

OpenAI-compatible embeddings provider for [@utaba/deep-memory](https://www.npmjs.com/package/@utaba/deep-memory). Works with any server that implements the [OpenAI Embeddings API](https://platform.openai.com/docs/api-reference/embeddings) — including vLLM, OpenAI, Azure OpenAI, Ollama, HuggingFace TEI, and LiteLLM.

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-embeddings-openai
```

## Quick Start

```typescript
import { DeepMemory } from '@utaba/deep-memory';
import { OpenAIEmbeddingProvider } from '@utaba/deep-memory-embeddings-openai';

const embeddings = new OpenAIEmbeddingProvider({
  baseUrl: 'http://localhost:8010',
  model: 'Qwen/Qwen3-Embedding-8B',
});

const dm = new DeepMemory({
  embeddingProvider: embeddings,
});
```

## Configuration

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | *required* | Base URL of the embeddings API (e.g. `http://localhost:8010`) |
| `model` | `string` | *required* | Model identifier sent in API requests |
| `apiKey` | `string` | `undefined` | Bearer token for authenticated endpoints. Not needed for local servers. |
| `headers` | `Record<string, string>` | `undefined` | Extra HTTP headers sent on every request, for endpoints that authenticate on something other than `Authorization: Bearer` (a gateway token, an `x-api-key`, or Cloudflare Access `CF-Access-Client-Id`/`CF-Access-Client-Secret`). The built-in `Content-Type` and (when `apiKey` is set) `Authorization` headers take precedence and cannot be overridden. |
| `dimensions` | `number` | auto-detected | Embedding vector dimensionality. Auto-detected on the first `embed()` call if omitted. |
| `timeoutMs` | `number` | `30000` | Request timeout in milliseconds |
| `maxBatchSize` | `number` | `64` | Maximum number of texts per batch request. Larger batches are automatically chunked. |

## What It Enables

Without an `EmbeddingProvider`, deep-memory falls back to string similarity (Jaro-Winkler) for vocabulary deduplication and does not support semantic search. With this provider configured:

- **`searchByConcept()`** — semantic search across entities using vector similarity
- **Vocabulary deduplication** — detect near-duplicate entity types and labels using embeddings instead of string matching
- **Embedding storage** — vectors are stored alongside entities for fast retrieval

## API

### `embed(text: string): Promise<number[]>`

Generate a single embedding vector.

### `embedBatch(texts: string[]): Promise<number[][]>`

Generate embeddings for multiple texts. Automatically chunks requests that exceed `maxBatchSize`. Results are returned in the same order as the input.

### `dimensions(): number`

Returns the dimensionality of the embedding vectors. Throws if called before the first `embed()` call and `dimensions` was not set in config.

### `modelId(): string`

Returns the model identifier from config. Stored alongside embeddings for compatibility tracking.

### `similarity(a: number[], b: number[]): number`

Computes cosine similarity between two vectors. Returns a value between -1 and 1.

## Backend Examples

### vLLM (local GPU)

```typescript
const embeddings = new OpenAIEmbeddingProvider({
  baseUrl: 'http://localhost:8010',
  model: 'Qwen/Qwen3-Embedding-8B',
});
```

See the repo's `docker-compose.indexer.yml` for a ready-to-use vLLM container serving Qwen3-Embedding-8B on port 8010.

### OpenAI

```typescript
const embeddings = new OpenAIEmbeddingProvider({
  baseUrl: 'https://api.openai.com',
  model: 'text-embedding-3-small',
  apiKey: process.env.OPENAI_API_KEY,
  dimensions: 1536,
});
```

### Ollama

```typescript
const embeddings = new OpenAIEmbeddingProvider({
  baseUrl: 'http://localhost:11434',
  model: 'nomic-embed-text',
});
```

### Azure OpenAI

```typescript
const embeddings = new OpenAIEmbeddingProvider({
  baseUrl: 'https://<resource>.openai.azure.com/openai/deployments/<deployment>',
  model: 'text-embedding-3-small',
  apiKey: process.env.AZURE_OPENAI_KEY,
});
```

## Error Handling

All errors thrown are `ProviderError` instances from `@utaba/deep-memory`, with a `suggestion` property containing actionable guidance:

```typescript
try {
  await embeddings.embed('test');
} catch (error) {
  if (error instanceof ProviderError) {
    console.error(error.message);    // what went wrong
    console.error(error.suggestion); // how to fix it
  }
}
```

Common error scenarios:
- **Connection refused** — server not running at `baseUrl`
- **Timeout** — request exceeded `timeoutMs`; increase timeout or reduce batch size
- **401 Unauthorized** — missing or invalid `apiKey`
- **Empty response** — model loaded but returned no embeddings

## Zero Runtime Dependencies

This package uses the built-in `fetch` API and has no runtime dependencies beyond the peer dependency on `@utaba/deep-memory`. Supported on Node.js 22 and 24.
</content>
</invoke>