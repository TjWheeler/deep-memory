# Source Content Conversion

Source documents must be converted to Markdown before indexing with deep-memory. Markdown preserves structural elements (headings, tables, lists) that the indexing pipeline relies on for accurate entity and relationship extraction.

## PDF to Markdown

Use [pymupdf4llm](https://github.com/pymupdf/RAG) for PDF conversion. It provides high-quality table preservation and clean Markdown output.

### Install

```bash
pip install pymupdf4llm
```

### Convert a single file

```python
import pymupdf4llm
import pathlib

pdf_path = pathlib.Path("path/to/document.pdf")
md = pymupdf4llm.to_markdown(str(pdf_path))
pdf_path.with_suffix(".md").write_text(md, encoding="utf-8")
```

### Batch convert a directory

```python
import pymupdf4llm
import pathlib

pdf_dir = pathlib.Path("index-content/your-folder")
for f in sorted(pdf_dir.glob("*.pdf")):
    md = pymupdf4llm.to_markdown(str(f))
    f.with_suffix(".md").write_text(md, encoding="utf-8")
    print(f"{f.name} -> {f.with_suffix('.md').name}")
```

### Notes

- Tables are converted to proper Markdown table syntax with headers and separators.
- Decorative PDF elements (logos, separator lines) may appear as small `picture` placeholders in the output. These are harmless for indexing and can be stripped if needed.
- For Python version management, `pymupdf4llm` requires Python 3.8+.
