# Indexer MCP Server

Dedicated MCP server for the indexing pipeline. Exposes 9 phase-aware tools (analyze → diagnose → execute, plus `update` for phase transitions) that drive the indexer. Separate from the memory MCP server which handles repository queries.

**Full documentation:** [`packages/indexer-mcp-server/README.md`](../packages/indexer-mcp-server/README.md) — installation, Claude Code wiring, full per-tool parameter reference, agent workflow example, and LLM provider detection.

**Related:** [Indexer Pipeline](../packages/indexer/README.md) — the pipeline this server drives.
