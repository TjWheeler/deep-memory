---
'@utaba/deep-memory-indexer': minor
'@utaba/deep-memory-indexer-mcp-server': minor
---

Add Docling document conversion (format gateway) to the indexer: PDF/DOCX/HTML/PPTX sources are converted to Markdown before extraction, via a containerised `docling-serve` service and a new `convert` action. The existing plain-text/Markdown pipeline is unchanged.

## `@utaba/deep-memory-indexer`

- New `packages/indexer/src/conversion/` module: `DoclingClient` (a typed HTTP client over `docling-serve` with retry/backoff, content-hash caching, and a timeout), `DocumentConverter` (writes `state/converted/{docSlug}.md` per source), plus its types and typed errors (`DoclingServiceError`/`DoclingTimeoutError`, extending core `ProviderError`).
- `IndexingOrchestrator` now registers `.pdf/.docx/.html/.htm/.pptx` sources as `needs-conversion` at prepare and exposes `convert()`, which converts them and records `derivedTextPath` on each source. Extraction reads the derived Markdown (`derivedTextPath ?? path`) and hard-guards against feeding un-converted binary sources to the LLM.
- `IndexSourceStatus` gains `needs-conversion` and `converting`; `IndexSource` gains `derivedTextPath` and `originalFormat`. `StateManager.getCurrentPhase()` routes such sources to the prepare phase so convert-before-extract is enforced, and `resetConvertingSources()` recovers conversions interrupted by a killed process.
- New optional `services.docling` configuration (`endpoint`, `timeoutMs`, `maxRetries`, `doOcr`, `apiKey`); the endpoint defaults to `http://localhost:5001`.

## `@utaba/deep-memory-indexer-mcp-server`

- `indexing_execute` accepts a new `action: "convert"` in the prepare phase; `StatusTool` reports `needs-conversion`/`converting` counts; `executeExtract` refuses to run while sources still need conversion, with an actionable message.
- `InitTool` scaffolds a commented `services.docling` block in `config.json` and a `docling.apiKey` slot in the secrets template.
