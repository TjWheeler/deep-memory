# Publishing Guide

This is the canonical reference for releasing `@utaba/deep-memory` packages to npm.

Versioning is driven by [Changesets](https://github.com/changesets/changesets).

## Branch model

- **`main`** — the default branch. All releases publish from here. Every change lands via PR.
- **`development`** — the integration branch where feature work accumulates between releases. Open `development → main` PRs to land batches of work.
- **`master`** — abandoned. Contains only the repository's initial commit. Ignore it; do not target PRs at it. (`origin/HEAD` may still point at it in some clones — `git remote set-head origin --auto` corrects this locally.)
- For one-off work, branch directly off `main` with a `fix/*` or `chore/*` prefix and PR back into `main`. The version-bump step itself uses a dedicated `chore/version-packages-X.Y.Z` branch.

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

## Hard rules

These constraints exist because Changesets will silently produce wrong version bumps when they're violated. The current code respects them — if you break one, the next release cycle will go sideways.

### No workspace-internal `peerDependencies`

Reference other in-repo packages from `dependencies`, never from `peerDependencies`. Use `workspace:^` as the value:

```json
"dependencies": {
  "@utaba/deep-memory": "workspace:^"
}
```

**Why:** Changesets' [Decision 4](https://github.com/changesets/changesets/blob/main/docs/decisions.md) escalates any package holding a peer dep to a **major** bump whenever that peer's range moves outside the existing range. Pre-1.0 caret semver only matches the same minor (`^0.19.0` accepts only `0.19.x`), so every minor bump of core triggers escalation. Combined with the fixed group, one escalation propagates to all six packages → `1.0.0` jump. This is the bug that originally forced removal of the `release.yml` GitHub Action.

External peers (e.g. a library declaring `react` as a peer) are unaffected — this rule is specifically about workspace-internal references.

### Every new published package must be added to the fixed group

When you add a new package that publishes to the `@utaba` scope, add its npm name to `.changeset/config.json` under `fixed`. Forgetting this means the package versions independently — consumers can install incompatible combinations (e.g. `core@0.20.0` + `storage-newprovider@0.19.1`). This drift bit us once when `storage-neo4j` was missing from the group; the config has been corrected, but the same pattern can recur silently if a new provider is added without updating the config.

### Changeset bodies become the public CHANGELOG

What you write in `.changeset/*.md` lands verbatim in `packages/<name>/CHANGELOG.md` for every package the changeset bumps and is what readers see on npmjs.com. Write release-note text, not PR-description text:

- Past tense or imperative. Lead with the user-visible change, then the why.
- No PR numbers, commit hashes, or "this PR".
- If a dependency version is mentioned in the body, keep it accurate when Dependabot moves the version higher later — see the pre-flight audit below.

## Prerequisites

- An npm account with publish rights on the `@utaba` scope
- Authenticated locally:

  ```bash
  npm whoami       # verify you're logged in
  npm login        # if not
  ```

  npm will prompt for MFA at publish time.

- `gh` CLI authenticated for `github.com`. Verify with `gh auth status`. If `$GH_TOKEN` is set in your environment, `gh` will prefer it over the keyring — if it holds a stale or invalid PAT, either remove it (`[Environment]::SetEnvironmentVariable('GH_TOKEN', $null, 'User')` and restart the shell) or `Remove-Item Env:GH_TOKEN` per session.

## Release Workflow

### Pre-flight checklist

Run these before authoring a changeset or starting a release. Skipping any of them is what historically caused broken releases.

1. **`npm whoami`** — confirm you're logged in as a publisher of `@utaba/*`. If MFA expired, run `npm login` again.
2. **`gh pr list --state open`** — check for open Dependabot PRs that target `main`.
   - If one exists and its CI is green, **merge it first**. Otherwise its `package.json` and `pnpm-lock.yaml` changes will conflict with the version-bump commit, and you'll have to either rebase Dependabot's branch or skip the bumps for this cycle.
   - After merging, `git checkout main && git pull` so your local copy includes the new dep versions.
3. **Audit pending changeset bodies for staleness.** If a changeset mentions a specific dep version (e.g. "Updated `@anthropic-ai/sdk` from `^0.98.0` to `^0.99.0`") and Dependabot has since moved that dep higher, edit the changeset body so the CHANGELOG entry reflects what's actually shipping (e.g. to `^0.100.1`). Leave the filename slug alone — slugs are cosmetic and get deleted on `pnpm changeset version`.
4. **`pnpm install`** — make sure the lockfile is current.
5. **`pnpm typecheck` and `pnpm test`** — should be green locally. CI on PRs is a backup, not the gate.

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

You don't have to pick every package in the fixed group manually — selecting any one of the six forces the entire group to bump together. Pick the package whose change is most prominent for the description.

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

List any one of the six fixed-group packages in the frontmatter — the others bump together. The slug can be anything kebab-case; Changesets uses random names by default, but a descriptive slug is fine.

### 2. Land feature work into `main`

Open a PR from your feature branch (or batched `development`) to `main`. Auto-merge once CI is green:

```bash
gh pr create --base main --head <branch> --title "..." --body "..."
gh pr merge <number> --auto --merge
```

There is no release automation that fires after merge — the version-bump step is run by hand on `main`.

> **Why no GitHub Action?** A `release.yml` workflow was removed because Changesets' peer-dep escalation rule produced `1.0.0` Version PRs on every release cycle. The root cause (workspace-internal peer deps) has since been fixed in code, but the manual flow is kept because it gives a review checkpoint on the version-bump diff. The Hard rules section above codifies the constraints that prevent the bug from returning.

### 3. Preview the version plan

On a clean checkout of `main`:

```bash
git checkout main && git pull
pnpm changeset status --verbose
```

This prints the planned bumps **without applying them**. Read every line.

**What good output looks like:**
- Every fixed-group package at the same new version (e.g. all six at `0.20.0` for a minor release).
- Independent packages at their own bumped version.
- The closing line: `Running release would release NO packages as a major`.

**Stop immediately if:**
- Any package shows a major bump that isn't part of an intentional 1.0 cut.
- A fixed-group package is missing from the list — it's probably not in the `fixed` array in `.changeset/config.json`.
- The plan references versions you don't recognise.

See the Troubleshooting section if the plan is wrong.

### 4. Apply the bump on a branch

Once `changeset status` looks right:

```bash
git checkout -b chore/version-packages-X.Y.Z
pnpm changeset version
pnpm install   # refresh pnpm-lock.yaml
```

Review the diff carefully:

- Every `packages/*/package.json` version matches the plan from step 3.
- Every `packages/*/CHANGELOG.md` entry reads like a release note. The fixed-group bodies propagate to all six packages — read each as a downstream consumer would.
- `.changeset/` now contains only `README.md` and `config.json` (all the consumed `*.md` files are gone).

**To abort and revert** if the result is wrong:

```bash
git checkout -- packages/ .changeset/
```

This restores the deleted `.changeset/*.md` files and rolls back all `package.json` / `CHANGELOG.md` changes. Nothing is committed at this point, so there's nothing to undo on the remote.

When the diff is right, commit and PR:

```bash
git add -A
git commit -m "chore: version packages X.Y.Z"
gh pr create --base main --head chore/version-packages-X.Y.Z --title "chore: version packages X.Y.Z" --body "..."
gh pr merge --auto --merge
```

**Do not push the version bump directly to `main`** — even though it's mechanical, the PR is the review checkpoint for the public CHANGELOG content.

### 5. Publish

After the version-bump PR merges:

```bash
git checkout main && git pull
npm whoami                  # final sanity check
pnpm release --dry-run      # preview tarballs, no upload
pnpm release                # actual publish
```

`scripts/publish.mjs`:

1. Verifies you're logged in to npm
2. Builds everything (`pnpm build`)
3. Runs tests (`pnpm test`)
4. Runs typecheck (`pnpm typecheck`)
5. Publishes the six fixed-group packages in dependency order
6. Skips any package whose local version already matches the registry

**MFA pattern:** npm will prompt for an OTP **once per published package** — be ready to enter six codes from your authenticator in succession, in this dependency order:

```
@utaba/deep-memory
@utaba/deep-memory-embeddings-openai
@utaba/deep-memory-storage-cosmosdb
@utaba/deep-memory-storage-sqlserver
@utaba/deep-memory-storage-neo4j
@utaba/deep-memory-local-mcp-server
```

Private packages (`indexer*`) do not publish — their version bumps are repo-internal record-keeping only.

### 6. Verify

Check the registry:

- https://www.npmjs.com/package/@utaba/deep-memory
- https://www.npmjs.com/package/@utaba/deep-memory-embeddings-openai
- https://www.npmjs.com/package/@utaba/deep-memory-storage-cosmosdb
- https://www.npmjs.com/package/@utaba/deep-memory-storage-sqlserver
- https://www.npmjs.com/package/@utaba/deep-memory-storage-neo4j
- https://www.npmjs.com/package/@utaba/deep-memory-local-mcp-server

Each should be at the new version with the latest CHANGELOG entry visible on the package page.

## Workspace References

Within the monorepo, packages reference each other using the pnpm workspace protocol:

| Field | Workspace value | Published value |
|-------|-----------------|-----------------|
| `dependencies` | `workspace:^` | caret range (e.g. `^0.20.0`) |
| `devDependencies` (rare) | `workspace:*` | exact version |

`peerDependencies` is **not used** for workspace-internal references — see the Hard rules section. External peer deps (third-party libraries) follow normal npm conventions.

pnpm rewrites the `workspace:*` and `workspace:^` protocol entries to real version numbers at publish time.

## Dependency Order

`scripts/publish.mjs` publishes in this order, so dependants resolve their workspace deps against the just-published core:

```
@utaba/deep-memory                                  (core — no internal deps)
  ↑
  ├── @utaba/deep-memory-embeddings-openai
  ├── @utaba/deep-memory-storage-cosmosdb
  ├── @utaba/deep-memory-storage-sqlserver
  ├── @utaba/deep-memory-storage-neo4j
  └── @utaba/deep-memory-local-mcp-server           (depends on core + embeddings-openai + all storage providers)
```

## Troubleshooting

### `pnpm changeset version` jumps from `0.x` to `1.0.0` (or any unexpected major bump)

**Most likely cause:** a workspace-internal `peerDependencies` entry has been reintroduced somewhere. See the Hard rules section. Run:

```bash
grep -r '"peerDependencies"' packages/*/package.json
```

Any block that references `@utaba/deep-memory*` is the culprit. Move it into `dependencies` as `workspace:^` and remove the peer entry.

**Less likely causes:**

- A `.changeset/*.md` file with `major` in its frontmatter. Run `grep -i "major" .changeset/*.md`.
- A stale `.changeset/pre.json` file forcing prerelease mode. If it exists and you're not running a prerelease cycle, delete it.

### A package is missing from the version plan

If `pnpm changeset status --verbose` shows the fixed group bumping but one of the six published packages is missing, the package isn't in the `fixed` array in `.changeset/config.json`. Add it. (This is what happened with `storage-neo4j` historically — the publishing guide listed six packages, the config only had five.)

### A changeset body mentions a version that's already been moved past

If Dependabot bumped a dependency higher than the version mentioned in a pending changeset body, the published CHANGELOG entry will be misleading. Edit the changeset body (the `.md` file under `.changeset/`) before running `pnpm changeset version` — Changesets reads the file at version time, so working-tree edits are absorbed without a separate commit. The filename slug is cosmetic and doesn't need updating.

### Lockfile conflict between version bump and Dependabot

If `pnpm changeset version` runs after a Dependabot PR opens but before it's merged, the resulting `pnpm-lock.yaml` and `package.json` changes will conflict with Dependabot's branch. Fix: merge Dependabot first (or close its PR if you're deferring), then run version. See the pre-flight checklist.

### Need to roll back uncommitted version changes

```bash
git checkout -- packages/ .changeset/
```

Restores the deleted `.changeset/*.md` files and reverts `package.json` / `CHANGELOG.md` changes. If `pnpm changeset version` created a brand-new `CHANGELOG.md` for a package that didn't have one before (e.g. a newly added fixed-group member), also `rm` that file.

## Hotfix Path

For an urgent fix to an already-released version:

1. Branch from the latest `main` (the most recent published commit) — not `development`, which may contain unreleased work.
2. Apply the fix.
3. Run `pnpm changeset` and pick `patch`.
4. PR back into `main`. After merge, run the Preview → Apply → Publish flow from steps 3–5 above.

The fixed-group config means all six packages bump to the same patch version even if only one was touched. This is intentional and preserves the "install any combination at the same version" guarantee.

## Deprecated: `scripts/version-bump.mjs`

The synchronized version-bump script (`pnpm version:patch/minor/major`) was retired in favour of Changesets. The script remains on disk with a DEPRECATED banner as an emergency fallback if you ever need a hard-synchronized bump outside the Changesets flow. Do not use it in normal development.
