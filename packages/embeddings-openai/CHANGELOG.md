# @utaba/deep-memory-embeddings-openai

## 0.20.1

### Patch Changes

- 1e77fb9: Fix `OpenAIEmbeddingProvider` automatically sending the OpenAI `dimensions` request parameter after the first embed, which broke embedding servers that reject it (e.g. vLLM serving a model without matryoshka support).

  - The provider previously used a single field for both the requested output size and the native dimension it latched from the first response. That native size was then echoed back as `dimensions` on every subsequent request — a no-op that strict servers return `HTTP 400` for, failing the second embed in a session.
  - Split into two fields: a caller-supplied requested dimension (the only value ever sent, and only when the caller opts into output truncation) and an observed native dimension learned from responses (used for `dimensions()` and length validation, never sent).
  - `_resolveDimensions` now validates that each returned vector length matches the expected size and throws a `ProviderError` on mismatch, instead of silently latching.
  - Default behaviour now sends no `dimensions`, restoring compatibility with OpenAI, Azure OpenAI, vLLM (strict and lax), Ollama, and HF TEI.
  - @utaba/deep-memory@0.20.1

## 0.20.0

### Patch Changes

- Updated dependencies [58be448]
- Updated dependencies [e4d470f]
  - @utaba/deep-memory@0.20.0

## 0.17.0

### Patch Changes

- @utaba/deep-memory@0.17.0
