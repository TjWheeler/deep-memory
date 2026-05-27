# Changeset Guide (for AI agents)

**Read this once before writing a changeset, then write the file. Do not mine git history or read past changeset diffs for stylistic mimicry — everything you need is here.**

## When to write one

Write a changeset when the user asks for one (typically at plan completion), and the change touches any package in the `fixed` group below. Skip for docs-only or test-only edits.

## The two-step workflow

1. Propose bump level + a 1–2 line summary to the user; get confirmation. *(Required by user preference — never write a changeset unprompted.)*
2. `Write` the file at `.changeset/<kebab-case-slug>.md`.

That's it. Two tool calls maximum (one `AskUserQuestion`, one `Write`). No `git log`, no `git status`, no `ls .changeset/`, no reading other changeset files.

## Fixed group (lockstep versioning)

These five packages bump together. Declaring **any one** of them in the frontmatter bumps all five to the same new version. Pick the package with the broadest changes in this changeset:

- `@utaba/deep-memory`
- `@utaba/deep-memory-embeddings-openai`
- `@utaba/deep-memory-storage-cosmosdb`
- `@utaba/deep-memory-storage-sqlserver`
- `@utaba/deep-memory-local-mcp-server`

Indexer packages (`@utaba/deep-memory-indexer`, `@utaba/deep-memory-indexer-llm-anthropic`, `@utaba/deep-memory-indexer-mcp-server`) are **not** in the fixed group — they version independently. Declare them separately if changed.

## Bump levels (pre-1.0 convention)

- **patch** — bug fixes, internal refactors, no public-API change.
- **minor** — new features, breaking changes to public types or behaviour, renamed enums/keys, schema changes on MCP tools. Pre-1.0, breaks ride in minor bumps, not major.
- **major** — reserved for the 1.0 cut. Don't use until then.

If the changeset bundles multiple concerns, the bump is the highest among them.

## Template

```markdown
---
'@utaba/deep-memory': minor
---

One-line summary of what changed and why it matters.

## Optional section heading for a discrete sub-change

Detail bullets describing the change, breaking surface, and any migration notes.
Mention each affected package by name in the body so the per-package CHANGELOG
entry remains meaningful (the fixed group propagates this same text to all five
package CHANGELOG.md files at version time).

- API change: `OldName` → `NewName` (which interfaces it lives on, what consumers must update).
- Behavioural change: what was wrong, what's now correct, any observable effect.

## Optional second sub-change

Same shape if the changeset bundles a second concern.
```

## Style rules

- Past-tense or imperative — `"Renamed X to Y"` or `"Rename X to Y"`, not "Will rename".
- Lead with the one-line summary. Section headers (`##`) only if there's more than one discrete change.
- Name affected packages explicitly in bullets — readers of `packages/X/CHANGELOG.md` should know if the entry is about X or about an upstream change that happened to bump X via the fixed group.
- No "Co-Authored-By" footers, no emoji, no marketing language.
- Don't restate the implementation diff — describe the contract change and the user-visible effect.

## Anti-patterns (things that wasted time before)

- Reading `.changeset/config.json` to "learn the convention" — that's why this guide exists.
- `git log --diff-filter=A -- .changeset/*.md` to find past changesets — they've been deleted by `Version Packages` commits anyway, and the style above is canonical.
- `git show <hash> -- <deleted-changeset>` to copy tone — write the obvious thing.
- `git status` after `Write` to "verify it landed" — the Write tool reports success.
- Re-auditing the working tree for unrelated edits — the changeset is for this task only.
