# Troubleshooting

## Extraction

### LLM output truncated (finish_reason: length)

**Symptom:** Extraction fails with an error like:

```
LLM output truncated (finish_reason: length). Response length: 14076 chars. Usage: 4096 output tokens.
The chunk likely produces more entities than maxOutputTokens allows.
```

**Cause:** The model ran out of output tokens before it finished generating the JSON extraction result. This happens when a source document is entity-dense — legal contracts, technical specifications, and other structured documents can produce many entities and relationships from a single chunk.

**What affects this:**

| Factor | Impact |
|--------|--------|
| **Document density** | A legal contract with clauses, obligations, rights, definitions, and parties generates far more output tokens than a simple narrative document of the same size |
| **Model capability** | Smaller models may produce more verbose output or repeat content, consuming tokens faster |
| **Hardware (GPU VRAM)** | Determines the maximum model context window you can serve, which limits how high you can set `maxOutputTokens` |
| **Chunk size** | Larger chunks contain more content for the model to extract from, producing larger outputs |

**Fix:** Increase `maxTokens` (top-level extraction config) and `maxOutputTokens` (worker config) in your process `config.json`:

```json
{
  "extraction": {
    "maxTokens": 16384,
    "workers": [
      {
        "maxOutputTokens": 16384
      }
    ]
  }
}
```

Start at 8192 and double if truncation continues. The upper bound depends on your model's context window minus input tokens. For a 32K context model with ~12K input tokens, 16384 output tokens is a safe ceiling.

If increasing output tokens is not possible (hardware constrained), reduce `maxChunkSize` on the worker to split documents into smaller pieces. This produces more chunks but each chunk generates fewer entities.

### Model outputs reasoning instead of JSON

**Symptom:** Extraction fails with:

```
Failed to parse LLM response as JSON: Unexpected token 'T', "The user w"... is not valid JSON
```

The model outputs its chain-of-thought reasoning (e.g. "The user wants me to extract entities...") instead of the expected JSON.

**Cause:** Some models (notably Qwen3/Qwen3.5) have a "thinking mode" enabled by default. The model produces internal reasoning before the actual response, and the extraction pipeline receives the thinking text instead of JSON.

**Fix:** Disable thinking mode via `extraBodyParams` in the top-level extraction config. Workers inherit this setting automatically.

For Qwen3/Qwen3.5 on vLLM:

```json
{
  "extraction": {
    "extraBodyParams": {
      "chat_template_kwargs": {
        "enable_thinking": false
      }
    }
  }
}
```

Other models may require different parameters — check your model's documentation and your inference server's API reference.
