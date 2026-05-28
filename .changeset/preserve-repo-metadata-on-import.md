---
'@utaba/deep-memory': minor
---

Preserved repository `legal`, `owner`, and `metadata` fields through `.dkg` export/import round-trip. Previously these fields were silently dropped when an archive was imported in `create` mode, so embedding model info, ownership, and licence notes set on the source repository did not survive portability.

- `@utaba/deep-memory`: `ExportManifest.repository` gained optional `legal`, `owner`, and `metadata` fields. `RepositoryExporter` populates them from the source `StoredRepository`, and `RepositoryImporter` forwards them to `storage.createRepository` when importing in `create` mode.
- `@utaba/deep-memory-local-mcp-server`: `memory_import_repository` reads the new manifest fields and threads them into the create-mode target config. Backward-compat: if `manifest.repository.metadata` is absent but the legacy `manifest.embedding` block is present, the embedding model identifier and dimensions are hydrated from there so older archives do not lose embedding metadata on round-trip.
- Behaviour is unchanged for `merge` mode, which targets an existing repository and never touches these fields.
