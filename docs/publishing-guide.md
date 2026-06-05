# Publishing Guide

This is the canonical reference for releasing `@utaba/deep-memory` packages to npm.

Versioning is driven by [Changesets](https://github.com/changesets/changesets). 

## Packages

### Published to npm

Six packages publish to the `@utaba` scope. They are configured as a **fixed group** in `.changeset/config.json`, so they always bump together to the same version. Users can install any combination at the same version and rely on compatibility.

| Package directory | npm name |
|-------------------|----------|
| `packages/core` | `@utaba/deep-memory` |
| `packages/embeddings-openai` | `@utaba/deep-memory-embeddings-openai` |
| `packages/storage-cosmosdb` | `@utaba/deep-memory-storage-cosmosdb` |
| `packages/storage-sqlserver` | `@utaba/deep-memory-storage-sqlserver` |
| `packages/storage-neo4j` | `@utaba/deep-memory-storage-neo4j` |
| `packages/mcp-server` | `@utaba/deep-memory-local-mcp-server` |

### Private (not published)

Three packages are marked `"private": true` in their `package.json`. They are intended to be run from a repo clone, not installed via npm. They version independently — bumping them does not force a release of the six published packages.

| Package directory | npm name |
|-------------------|----------|
| `packages/indexer` | `@utaba/deep-memory-indexer` |
| `packages/indexer-llm-anthropic` | `@utaba/deep-memory-indexer-llm-anthropic` |
| `packages/indexer-mcp-server` | `@utaba/deep-memory-indexer-mcp-server` |

## What gets published

Each package's `files` field controls what ends up in the published tarball:

- `dist/` — compiled JavaScript (CJS + ESM where applicable) and TypeScript declarations
- `README.md`
- `LICENSE`

Source TypeScript, tests, and dev configuration are excluded.

## Prerequisites

- An npm account with publish rights on the `@utaba` scope
- Authenticated locally:

  ```bash
  npm whoami       # verify you're logged in
  npm login        # if not
  ```

  npm will prompt for MFA at publish time.

## Release Workflow

### 1. Author a changeset on your PR

When you make a change that affects a published package's behaviour, run from the repo root:

```bash
pnpm changeset
```

Interactive prompts will ask:

- Which packages does this change affect? (Spacebar to select.)
- What kind of bump? `patch` / `minor` / `major`
- A short description for the changelog

This writes a markdown file under `.changeset/`. Commit it as part of your PR.

**You don't have to pick every package in the fixed group manually** — selecting any one of the six forces the entire group to bump together. Pick the package whose change is most prominent for the description.

**Picking the bump level:**

- `patch` — internal fixes, perf wins, bug fixes, anything with no public-surface impact.
- `minor` — additive public surface (new methods, options, exports). While versions are pre-1.0, breaking changes also go in `minor`.
- `major` — reserved for the 1.0 cut.

If your PR is docs / tests / CI only and doesn't affect published behaviour, **skip the changeset** — it's fine to merge without one.

### Authoring a changeset by hand (or from an agent)

Instead of running the CLI, create `.changeset/<descriptive-slug>.md` directly with this frontmatter format:

```markdown
---
'@utaba/deep-memory-storage-cosmosdb': minor
---

Short one-line description of the change for the changelog.

Optional further paragraphs for detail.
```

List any one of the five fixed-group packages in the frontmatter — the others bump together. The slug can be anything kebab-case; Changesets uses random names by default, but a descriptive slug is fine.

### 2. Merge to `main`

Land the PR into `main` normally. **There is no release automation** — versioning and publishing both happen locally from `main`.

> **No GitHub Action runs the version step.** A `release.yml` workflow existed previously but was removed because it repeatedly opened Version PRs that jumped the fixed group from `0.x` to `1.0.0`. Root cause: every storage / embeddings / indexer package declared `@utaba/deep-memory` as a `peerDependency` with `workspace:^`. A `minor` bump of core moved the published peer-dep range out of `^0.X.0`, which Changesets [Decision 4](https://github.com/changesets/changesets/blob/main/docs/decisions.md) treats as a breaking change for the package holding the peer dep — escalating it to **major**. Major in any fixed-group member propagates to the whole group → `1.0.0`. **The peer-deps have since been converted to regular `dependencies`**, so the escalation no longer fires. The action could be reintroduced now, but the manual flow is preserved for the per-release review checkpoint. **Never reintroduce a workspace-internal `peerDependencies` entry** — it will silently bring back the 1.0.0 bug.

### 3. Apply pending changesets locally

On a clean checkout of `main`:

```bash
pnpm changeset version
```

This applies every `.changeset/*.md` file: bumps `package.json` versions across the fixed group, writes entries into each affected package's `CHANGELOG.md`, and deletes the consumed `.md` files. Run `pnpm install` afterwards if `pnpm-lock.yaml` did not auto-update.

Review the diff to confirm the version bumps and changelog text look right, then commit:

```bash
git add -A
git commit -m "chore: version packages <new-version>"
git push origin master
```

### 4. Publish

From the repo root, still on `main` at the version-bump commit:

```bash
pnpm release --dry-run    # preview what would be published
pnpm release              # actually publish
```

`scripts/publish.mjs`:

1. Verifies you're logged in to npm
2. Builds everything (`pnpm build`)
3. Runs tests (`pnpm test`)
4. Runs typecheck (`pnpm typecheck`)
5. Publishes the six packages in dependency order
6. Skips any package whose local version already matches the registry

npm prompts for MFA at publish time.

### 5. Verify

Check the registry:

- https://www.npmjs.com/package/@utaba/deep-memory
- https://www.npmjs.com/package/@utaba/deep-memory-embeddings-openai
- https://www.npmjs.com/package/@utaba/deep-memory-storage-cosmosdb
- https://www.npmjs.com/package/@utaba/deep-memory-storage-sqlserver
- https://www.npmjs.com/package/@utaba/deep-memory-storage-neo4j
- https://www.npmjs.com/package/@utaba/deep-memory-local-mcp-server

## Workspace References

Within the monorepo, packages reference each other using the pnpm workspace protocol:

| Field | Workspace value | Published value |
|-------|-----------------|-----------------|
| `dependencies` | `workspace:*` | exact version (e.g. `0.17.0`) |
| `peerDependencies` | `workspace:^` | caret range (e.g. `^0.17.0`) |

pnpm rewrites these to real version numbers at publish time.

## Dependency Order

`scripts/publish.mjs` publishes in this order, so dependants resolve their workspace deps against the just-published core:

```
@utaba/deep-memory                                  (core — no internal deps)
  ↑
  ├── @utaba/deep-memory-embeddings-openai
  ├── @utaba/deep-memory-storage-cosmosdb
  ├── @utaba/deep-memory-storage-sqlserver
  ├── @utaba/deep-memory-storage-neo4j
  └── @utaba/deep-memory-local-mcp-server           (depends on core + embeddings-openai + all three storage providers)
```

## Deprecated: `scripts/version-bump.mjs`

The synchronized version-bump script (`pnpm version:patch/minor/major`) was retired in favour of Changesets. The script remains on disk with a DEPRECATED banner as an emergency fallback if you ever need a hard-synchronized bump outside the Changesets flow. Do not use it in normal development.

## Hotfix Path

For an urgent fix to an already-released version:

1. Branch from the tag of the affected release (not `development`).
2. Apply the fix.
3. Run `pnpm changeset` and pick `patch`.
4. PR back into `main`. After merge, run `pnpm changeset version` locally, commit the bump, then `pnpm release`.

The fixed-group config means all six packages bump to the same patch version even if only one was touched. This is intentional and preserves the "install any combination at the same version" guarantee.
