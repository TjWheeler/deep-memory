---
'@utaba/deep-memory-indexer': minor
'@utaba/deep-memory-indexer-mcp-server': minor
---

Add Docling document conversion to the indexer: PDF/DOCX/HTML/PPTX sources are converted to Markdown before extraction, via a containerised `docling-serve` service and a new `convert` action. The existing plain-text/Markdown pipeline is unchanged. Conversion is resilient at scale — large documents convert asynchronously, unchanged sources are skipped, born-digital PDFs skip the OCR tax, and every conversion leaves a diagnostic trail.

## `@utaba/deep-memory-indexer`

- New `packages/indexer/src/conversion/` module: `DoclingClient` (a typed HTTP client over `docling-serve` with retry/backoff, content-hash caching, and a timeout), `DocumentConverter` (writes `state/converted/{docSlug}.md` per source), plus its types and typed errors (`DoclingServiceError`/`DoclingTimeoutError`, extending core `ProviderError`).
- `IndexingOrchestrator` now registers `.pdf/.docx/.html/.htm/.pptx` sources as `needs-conversion` at prepare and exposes `convert()`, which converts them and records `derivedTextPath` on each source. Extraction reads the derived Markdown (`derivedTextPath ?? path`) and hard-guards against feeding un-converted binary sources to the LLM.
- `IndexSourceStatus` gains `needs-conversion` and `converting`; `IndexSource` gains `derivedTextPath` and `originalFormat`. `StateManager.getCurrentPhase()` routes such sources to the prepare phase so convert-before-extract is enforced, and `resetConvertingSources()` recovers conversions interrupted by a killed process.
- **Asynchronous conversion** (`DoclingClient.convertViaAsync` — submit/poll/fetch against the `docling-serve` async API) so large documents that exceed the synchronous server-side wait ceiling convert reliably. Selected per run via `services.docling.mode` (`'sync' | 'async'`, default `'async'`); a `404` on the async submit carries an actionable `suggestion` naming the sync escape hatch.
- **Content-hash idempotency:** a `sourceHash` (sha256 of the raw bytes) is stored on each source. A re-run skips unchanged sources (`skipped-unchanged`, no docling round trip); `prepare` detects a source edited on disk, resets it to `needs-conversion`, and deletes its stale derived files so no out-of-date Markdown feeds extraction.
- **Per-document OCR heuristic:** non-PDF formats and explicit `doOcr` overrides bypass it; PDFs left to the heuristic convert first without OCR and reconvert once with OCR only when the text yield per page is implausibly low. No page count means no fallback (a warning is recorded instead of guessing).
- **Conversion diagnostics:** every real conversion also persists a `{docSlug}.docling.json` sidecar and contributes to a `conversion-report.json` (per-doc timing, page/table counts, warnings, OCR-fallback flag), summarized for the tools. `IndexSource` gains `sourceHash`, `derivedDoclingJsonPath`, `doOcr`, and a compact `conversion` status mirror.
- New `services.docling` configuration: `endpoint` (defaults to `http://localhost:5001`), `timeoutMs`, `maxRetries`, `doOcr`, `apiKey`, plus `mode`, `pollIntervalMs`, `maxPollIntervalMs`, `maxTotalWaitMs`, and `ocrTextYieldThreshold`.

## `@utaba/deep-memory-indexer-mcp-server`

- `indexing_execute` accepts a new `action: "convert"` in the prepare phase; `StatusTool` reports `needs-conversion`/`converting` counts; `executeExtract` refuses to run while sources still need conversion, with an actionable message.
- The convert-start response reports the conversion `mode`; when async, it notes that progress is pollable via `indexing_status`, which now surfaces the live current document, task position, elapsed time, and whether OCR is running from the active conversion-progress file.
- `convert` now honours the `sourceFilter` tool param (it previously ignored it while `extract` honoured it) and reports the filtered count/list, so the started-count matches what will actually convert; the shared filter predicate is used by convert, extract, and the converter.
- `indexing_diagnose` gains conversion checks sourced from `conversion-report.json`: per-doc table counts, conversion warnings, and a slow-conversion flag.
- `InitTool` scaffolds a commented `services.docling` block in `config.json` (including `mode` and OCR notes) and a `docling.apiKey` slot in the secrets template.
