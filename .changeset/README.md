# Changesets

This folder holds version intent for `@utaba/deep-memory` releases. Each `.md` file describes a pending change and the bump level it requires. Running `pnpm changeset version` consumes them all — applying version bumps and writing `CHANGELOG.md` entries — after which the changeset files are deleted.

## Fixed group

The five published packages are configured as a **fixed group** in `config.json`:

- `@utaba/deep-memory`
- `@utaba/deep-memory-embeddings-openai`
- `@utaba/deep-memory-storage-cosmosdb`
- `@utaba/deep-memory-storage-sqlserver`
- `@utaba/deep-memory-local-mcp-server`

Selecting any one of these in `pnpm changeset` will bump all five together. This preserves the "install any combination at the same version" guarantee.

## Private packages

Three packages are `"private": true` and version **independently** of the fixed group:

- `@utaba/deep-memory-indexer`
- `@utaba/deep-memory-indexer-llm-anthropic`
- `@utaba/deep-memory-indexer-mcp-server`

Selecting one of these in `pnpm changeset` will bump only that package (or whichever subset of the three you select). It will not force a release of the published five.

## Full workflow

See [`docs/publishing-guide.md`](../docs/publishing-guide.md) for the end-to-end release process.

## Upstream docs

[Changesets repository](https://github.com/changesets/changesets) · [Common questions](https://github.com/changesets/changesets/blob/main/docs/common-questions.md)
