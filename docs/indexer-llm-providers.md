# Indexer — LLM Provider Abstraction

The extraction pipeline supports pluggable LLM backends via the `LLMProvider` interface. This allows vendor-specific optimizations (Anthropic prompt caching, future Files API support) without locking the core indexer to any single API format.

---

## Overview

```
@utaba/deep-memory-indexer (core)
├── LLMProvider interface          — pluggable backend contract
├── OpenAIChatProvider (built-in)  — standard chat completions, zero extra deps
└── ExtractionWorker               — delegates transport to the provider

@utaba/deep-memory-indexer-llm-anthropic (optional package)
├── AnthropicLLMProvider           — native Anthropic Messages API
├── Prompt caching                 — cache_control on system prompt (~90% cached token savings)
└── Cache token reporting          — tracks cache hits for cost analysis
```

**Default behavior:** When no `LLMProvider` is configured, the pipeline uses `OpenAIChatProvider` — the same OpenAI-compatible chat completions endpoint it has always used. No config changes needed for existing setups.

---

## Built-in Provider: OpenAIChatProvider

Works with any OpenAI-compatible endpoint (vLLM, OpenAI, Azure, Ollama, Anthropic's OpenAI-compat shim).

```typescript
import { OpenAIChatProvider } from '@utaba/deep-memory-indexer/providers';

const provider = new OpenAIChatProvider({
  endpoint: 'http://localhost:8020/v1',
  apiKey: 'optional-api-key',
});
```

This is what the pipeline creates internally when no custom provider is supplied.

---

## Anthropic Provider: @utaba/deep-memory-indexer-llm-anthropic

Uses the native Anthropic Messages API, enabling prompt caching that reduces system prompt costs by ~90%.

### Installation

```bash
pnpm add @utaba/deep-memory-indexer-llm-anthropic
```

### Why Use It?

The extraction pipeline sends the same system prompt (vocabulary + extraction rules + output format, ~19K tokens) with every chunk. For a 148-chunk document, that's ~2.8M tokens just repeating the system prompt.

| Scenario | System Prompt Cost (2.8M tokens) | Savings |
|----------|----------------------------------|---------|
| OpenAI-compat (no caching) | $2.24 (@ $0.80/M) | — |
| Anthropic with prompt caching | $0.22 (@ $0.08/M cached) | **90%** |

Prompt caching is automatic — the first chunk pays the full price, subsequent chunks get cache hits (5-minute TTL that resets on each hit). With chunks processing in 30-120 seconds each, the cache stays warm throughout a document.

### Programmatic Usage

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

### MCP Server Usage (config.json)

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
      },
      {
        "name": "local-qwen",
        "endpoint": "http://localhost:8020/v1",
        "model": "Qwen/Qwen3-4B",
        "contextWindow": 32768,
        "maxChunkSize": 8000,
        "maxOutputTokens": 8192,
        "costPerMillionInputTokens": 0,
        "costPerMillionOutputTokens": 0,
        "concurrency": 1,
        "capabilities": ["structured-extraction"]
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

The MCP server automatically detects the `@utaba/deep-memory-indexer-llm-anthropic` package when installed. No additional server configuration needed.

### Configuration

| Option | Default | Description |
|--------|---------|-------------|
| `apiKey` | (required) | Anthropic API key |
| `enablePromptCaching` | `true` | Add `cache_control: { type: "ephemeral" }` to system prompt blocks |
| `baseURL` | `https://api.anthropic.com` | Override for proxies or testing |

### Cache Token Reporting

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

- `cache_read_tokens`: tokens served from cache (cheap: $0.08/M for Haiku)
- `cache_creation_tokens`: tokens written to cache on first call (charged at $1.00/M for Haiku)

After the first chunk, subsequent chunks should show high `cache_read_tokens` and zero `cache_creation_tokens`.

---

## Tool-Use Capability (Phase B.7)

Phase B.7 full validation uses multi-turn tool-use conversations where the LLM agent calls source navigation tools between turns. This requires the optional `chatCompletionWithTools` method on the provider.

Both built-in providers implement it:

| Provider | `chatCompletionWithTools` | Notes |
|----------|--------------------------|-------|
| `OpenAIChatProvider` (default) | Supported | Uses OpenAI function-calling format — works with vLLM, Ollama, OpenAI, Azure, and any OpenAI-compatible endpoint |
| `AnthropicLLMProvider` | Supported | Uses native Anthropic tool_use content blocks + prompt caching |

This means a local vLLM model (e.g., Qwen 35B) can run Phase B.7 validation with no extra configuration — the default provider handles it.

**Local model example:**

```json
{
  "validation": {
    "workers": [
      {
        "name": "local-qwen-35b",
        "endpoint": "http://localhost:8020/v1",
        "model": "Qwen/Qwen3-32B",
        "maxOutputTokens": 8192,
        "costPerMillionInputTokens": 0,
        "costPerMillionOutputTokens": 0,
        "concurrency": 1
      }
    ]
  }
}
```

**Cloud model example (with prompt caching):**

```json
{
  "validation": {
    "workers": [
      {
        "name": "cloud-sonnet",
        "llmProvider": "anthropic",
        "model": "claude-sonnet-4-6",
        "maxOutputTokens": 8192,
        "costPerMillionInputTokens": 3.00,
        "costPerMillionOutputTokens": 15.00,
        "concurrency": 3
      }
    ]
  }
}
```

If a custom provider is configured for Phase B.7 workers but does not implement `chatCompletionWithTools`, validation will throw immediately with a clear error.

---

## Custom Providers

Implement the `LLMProvider` interface for any LLM backend:

```typescript
import type {
  LLMProvider, LLMCompletionResult, LLMRequestOptions, LLMRunContext,
  LLMToolDefinition, LLMToolUseMessage, LLMToolUseTurnResult,
} from '@utaba/deep-memory-indexer/providers';

class MyProvider implements LLMProvider {
  readonly name = 'my-provider';

  async chatCompletion(
    systemPrompt: string,
    userPrompt: string,
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMCompletionResult> {
    // Send request to your LLM backend
    // Return { content, usage, finish_reason }
  }

  // Optional — implement for Phase B.7 full validation support
  async chatCompletionWithTools?(
    systemPrompt: string,
    messages: LLMToolUseMessage[],
    tools: LLMToolDefinition[],
    options: LLMRequestOptions,
    signal?: AbortSignal,
  ): Promise<LLMToolUseTurnResult> {
    // Send one turn in a multi-turn tool-use conversation.
    // Return { type: 'tool_use', toolCalls: [...] } when the model requests tools.
    // Return { type: 'text', content: '...' } when the model is done.
  }

  // Optional lifecycle hooks
  async beforeRun?(context: LLMRunContext): Promise<void> { /* session setup */ }
  async afterRun?(): Promise<void> { /* cleanup */ }
  async dispose?(): Promise<void> { /* teardown */ }
}
```

**Key contract:**
- `finish_reason` must be normalized to `'stop'` (complete) or `'length'` (truncated). The extraction worker uses this to trigger truncation recovery.
- `usage` fields are optional but enable cost tracking and token analysis.
- `beforeRun`/`afterRun` are called once per extraction run by the orchestrator, not per chunk.
- `chatCompletionWithTools` is optional — only required for Phase B.7 validation workers. The caller drives the conversation loop; the provider handles a single turn at a time.

---

## Provider Architecture

```
IndexingOrchestrator
├── registerLLMProvider("anthropic", provider)
├── extract()
│   ├── provider.beforeRun(vocabulary, rules, model)
│   ├── for each document:
│   │   └── ExtractionWorker (with provider)
│   │       ├── callLLM → provider.chatCompletion(system, user, options)
│   │       ├── truncation detection (finish_reason === 'length')
│   │       ├── JSON parsing
│   │       └── logging (includes cache tokens if present)
│   └── provider.afterRun()
```

Each worker gets the provider instance matching its `llmProvider` config name. Workers without `llmProvider` get a fresh `OpenAIChatProvider` created from their endpoint/apiKey config. Provider instances are shared across workers with the same provider name.
