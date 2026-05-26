# @utaba/deep-memory-indexer-llm-anthropic

Anthropic LLM provider for [@utaba/deep-memory-indexer](https://www.npmjs.com/package/@utaba/deep-memory-indexer). Uses the native Anthropic Messages API with **prompt caching** — reduces system prompt costs by ~90% when extracting from multiple documents.

## Installation

```bash
pnpm add @utaba/deep-memory-indexer @utaba/deep-memory-indexer-llm-anthropic
```

## Why Use It

The extraction pipeline sends the same system prompt (vocabulary + extraction rules + output format — typically ~19K tokens) with every chunk. For a 148-chunk document, that's ~2.8M tokens just repeating the system prompt. With Anthropic prompt caching, the cache stays warm and subsequent chunks pay only the cache-read price.

| Scenario | System Prompt Cost (2.8M tokens) | Savings |
|----------|----------------------------------|---------|
| OpenAI-compat (no caching) | $2.24 (@ $0.80/M) | — |
| Anthropic with prompt caching | $0.22 (@ $0.08/M cached) | **90%** |

Caching is automatic — the first chunk pays the full price, subsequent chunks get cache hits (5-minute TTL that resets on each hit). With chunks processing in 30-120 seconds, the cache stays warm throughout a document.

## Programmatic Usage

```typescript
import { IndexingOrchestrator } from '@utaba/deep-memory-indexer';
import { AnthropicLLMProvider } from '@utaba/deep-memory-indexer-llm-anthropic';

const orchestrator = new IndexingOrchestrator(config);

orchestrator.registerLLMProvider('anthropic', new AnthropicLLMProvider({
  apiKey: process.env.ANTHROPIC_API_KEY!,
  enablePromptCaching: true,   // default
}));

const outputs = await orchestrator.extract();
```

## MCP Server Usage

Add `"llmProvider": "anthropic"` to any worker that should use the native Anthropic API:

```json
{
  "extraction": {
    "workers": [
      {
        "name": "cloud-haiku-cached",
        "llmProvider": "anthropic",
        "endpoint": "https://api.anthropic.com/v1",
        "model": "claude-haiku-4-5-20251001",
        "contextWindow": 200000,
        "maxChunkSize": 15000,
        "maxOutputTokens": 64000,
        "costPerMillionInputTokens": 0.80,
        "costPerMillionOutputTokens": 4.00,
        "concurrency": 3,
        "capabilities": ["structured-extraction", "prose-extraction", "large-context"]
      }
    ]
  }
}
```

Workers **without** `llmProvider` use the built-in OpenAI-compat provider automatically.

The API key goes in `config.secrets.json`:

```json
{
  "extraction": {
    "workers": {
      "cloud-haiku-cached": {
        "apiKey": "sk-ant-..."
      }
    }
  }
}
```

The MCP server automatically detects this package when installed — no extra server configuration needed.

## Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | (required) | Anthropic API key |
| `enablePromptCaching` | `true` | Add `cache_control: { type: "ephemeral" }` to system prompt blocks |
| `baseURL` | `https://api.anthropic.com` | Override for proxies or testing |

## Cache Token Reporting

When prompt caching is active, the extraction logs include cache token fields:

```json
{
  "usage": {
    "prompt_tokens": 19500,
    "completion_tokens": 8200,
    "cache_read_tokens": 19000,
    "cache_creation_tokens": 500
  }
}
```

- `cache_read_tokens` — tokens served from cache (cheap: $0.08/M for Haiku)
- `cache_creation_tokens` — tokens written to cache on first call ($1.00/M for Haiku)

After the first chunk, subsequent chunks should show high `cache_read_tokens` and zero `cache_creation_tokens`. If they don't, the system prompt is changing between chunks (which defeats caching).

## Tool-Use Capability

This provider implements `chatCompletionWithTools` for full extraction validation — multi-turn tool-use conversations where the LLM calls source navigation tools (read, search, headings) between turns. Uses native Anthropic tool_use content blocks with prompt caching.

## Documentation

- [LLM Providers Guide](https://github.com/TjWheeler/deep-memory/blob/main/docs/indexer-llm-providers.md) — full provider architecture, custom provider guide, tool-use details
