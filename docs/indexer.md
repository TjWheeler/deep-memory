# Indexer Pipeline

The indexer turns unstructured documents (spec sheets, manuals, handbooks) into a structured knowledge graph through a phased, resumable pipeline. Designed for AI–human collaboration: AI handles extraction and consolidation at scale; humans define vocabularies, tune strategies, and review validation results.

**Full documentation:** [`packages/indexer/README.md`](../packages/indexer/README.md) — pipeline phases, MCP-driven quick start, programmatic usage, multi-worker routing (assignment algorithm + intelligent retry), full configuration reference (`OrchestratorConfig` / `WorkerConfig` types), validation overview, LLM providers, cancellation, and the AI/human collaboration loop.

## Topical deep-dives

- [Indexer Quickstart](../quickstart-indexer.md) — step-by-step first run
- [Indexer LLM Providers](indexer-llm-providers.md) — pluggable backends, Anthropic prompt caching, custom provider guide
- [Indexer Validation](indexer-validation.md) — three-tier validation, model selection, accuracy scoring
- [Indexer Extraction Guide](indexer-extraction-guide.md) — model selection, chunk sizing, cost management, strategy tuning
- [Post-Extraction Review Guide](indexer-review-guide.md) — spot-checking and correcting extraction outputs
- [Indexer Consolidation Guide](indexer-consolidation-guide.md) — dedup algorithm, merge confidence, troubleshooting
- [Indexer Embeddings Guide](indexer-embeddings-guide.md) — config, cost estimation, similarity tuning
- [Indexer Troubleshooting](indexer-troubleshooting.md) — common issues and fixes per phase
- [Starter Kit Creation Guide](indexer-starterkit-guide.md) — building custom domain vocabularies
- [Local Model Setup](local-model-setup.md) — llama.cpp / vLLM worker setup, GPU sizing
- [Indexer MCP Server](../packages/indexer-mcp-server/README.md) — 9 phase-aware MCP tools
