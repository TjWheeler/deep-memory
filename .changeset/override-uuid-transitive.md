---
'@utaba/deep-memory-storage-cosmosdb': patch
---

Override transitive `uuid` dependency to `>=11.1.1` to resolve GHSA-w5hq-g745-h8pq (moderate, missing buffer bounds check in `uuid.v3/v5/v6` when a `buf` argument is supplied).

- The vulnerable `uuid@9.0.1` was pulled in via `gremlin@3.8.1` in `@utaba/deep-memory-storage-cosmosdb`. `gremlin@3.8.1` is the latest stable and pins `uuid@^9.0.1` directly, so a workspace-level `pnpm.overrides` entry is the only way to lift the transitive without forking gremlin.
- No runtime API change. `gremlin` only calls `uuid.v4()`, which is unchanged across v9 → v11; uuid@11 still publishes a CJS build so `require('uuid')` keeps working.
