# @utaba/deep-memory-embeddings-openai

## 0.21.0

### Minor Changes

- Add a `headers` option to `OpenAIEmbeddingProvider` so it can reach endpoints that authenticate on something other than `Authorization: Bearer`.

  ## Custom request headers

  Endpoints behind a gateway or Cloudflare Access require extra headers (a gateway token, an `x-api-key`, or `CF-Access-Client-Id`/`CF-Access-Client-Secret`) that the provider previously had no way to send — it only ever emitted `Content-Type` plus an optional Bearer. Such endpoints returned HTTP 403, so a graph using them could not be embedded or written to at all.

  - `OpenAIEmbeddingProviderConfig` gains `headers?: Record<string, string>`, sent on every embeddings request.
  - Custom headers layer alongside the built-ins: `Content-Type` and (when `apiKey` is set) `Authorization: Bearer` always take precedence, so custom headers add authentication rather than being able to break the JSON contract or clobber the token.

### Patch Changes

- @utaba/deep-memory@0.21.0

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
