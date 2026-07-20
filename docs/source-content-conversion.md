# Source Content Conversion

The indexing pipeline extracts entities and relationships from Markdown/plain
text. Rich formats (PDF, DOCX, HTML, PPTX) are converted to Markdown first, so
their structural elements (headings, tables, lists) survive into extraction.

The indexer has a built-in **convert** step for this — you do not need to
pre-convert documents by hand. Pre-converting is still an option (see the bottom
of this page) when you want the Markdown checked into your source tree.

## Built-in convert step (recommended)

Rich-format sources are registered with status `needs-conversion` during
prepare. The convert step renders each one to `state/converted/{slug}.md`
(recorded as `derivedTextPath` on the source), writes a structural JSON sidecar
`state/converted/{slug}.docling.json`, and flips the source to `pending`.
Everything downstream reads the derived Markdown; the original file is preserved
for provenance. Extraction refuses to run against an unconverted rich-format
source.

Conversion runs against a containerised
[`docling-serve`](https://github.com/docling-project/docling-serve) service
under a gated docker-compose profile, so a repo with no rich-format sources
never starts the (~4.4 GB) container:

```bash
docker compose -f docker-compose.indexer.yml --profile docling-worker up -d
```

Configure the service in the process `config.json`:

```jsonc
{
  "services": {
    "docling": {
      "endpoint": "http://localhost:5001",  // match the docling-worker host port
      "mode": "async",                        // submit + poll; the default
      "timeoutMs": 600000,                    // per-request ceiling
      "maxRetries": 3
      // "doOcr": false                       // force OCR off (global or per source)
      // "ocrTextYieldThreshold": 100          // chars/page floor for the OCR fallback
    }
  }
}
```

Then, before extraction:

```
indexing_execute processDir: ./index-processes/my-knowledge action: convert
```

Poll `indexing_status` until conversion completes, then continue with
`indexing_analyze` / `indexing_execute` as usual.

### Behaviour worth knowing

- **Idempotent.** Each source's raw bytes are hashed. A re-run skips any source
  whose bytes are unchanged and whose derived files still exist (reported as
  `skipped-unchanged`) — no re-conversion. Editing a source on disk is detected
  at prepare: its stale derived files are deleted and it is reset to
  `needs-conversion` so the next convert reprocesses it.
- **Asynchronous by default.** `mode: "async"` submits each conversion and polls
  for the result, so a large document converts reliably without a raised
  timeout — there is no single-request wall clock over the whole job.
  `indexing_status` shows the live queue position and elapsed time. `mode:
  "sync"` keeps one request open and exists only for an older container without
  the async routes (an async submit that 404s reports the switch).
- **OCR is decided per document.** Non-PDF formats carry text natively and never
  run OCR. For a PDF with no explicit `doOcr`, convert runs a fast no-OCR pass
  and re-runs with OCR only when the text yield per page falls below
  `ocrTextYieldThreshold` (default 100 chars/page). Scanned PDFs therefore get
  OCR while born-digital ones stay fast. A text-light born-digital PDF (a slide
  or diagram deck) can be a false positive — set `doOcr: false` on that source
  to opt out. An explicit `doOcr` skips the heuristic entirely.
- **Diagnostics.** Every run writes `state/conversion-report.json` (per-document
  mode, OCR decision, page/table counts, warnings, timing). `indexing_diagnose`
  in the prepare phase surfaces warnings, table counts, and conversions running
  far slower than their peers.

## Pre-converting outside the pipeline (alternative)

If you would rather convert documents ahead of time and check the Markdown into
your source tree, any tool that produces clean Markdown works — for example
[pymupdf4llm](https://github.com/pymupdf/RAG) for PDFs:

```bash
pip install pymupdf4llm
```

```python
import pymupdf4llm
import pathlib

pdf_dir = pathlib.Path("index-content/your-folder")
for f in sorted(pdf_dir.glob("*.pdf")):
    md = pymupdf4llm.to_markdown(str(f))
    f.with_suffix(".md").write_text(md, encoding="utf-8")
```

Point the process `sourceDir` at the resulting `.md` files and the built-in
convert step is skipped entirely. Tables become proper Markdown table syntax;
decorative elements may appear as small `picture` placeholders and are harmless
for indexing.
