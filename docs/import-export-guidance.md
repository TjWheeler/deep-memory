# Import & Export Guidance

How to use the deep-memory export/import system to build, ship, and update knowledge repositories in production environments.

## File Format

Exported archives use the `.dkg` (Deep Knowledge Graph) file extension. The file is a standard ZIP archive internally, containing JSON files organized by section. Legacy `.zip` archives are still accepted on import for backward compatibility.

**Filename pattern:** `{slugified-label}-v{vocabularyVersion}-{datetime}.dkg`

**Example:** `caterpillar-fleet-v1-0-0-20260406-143025.dkg`

## Overview

The portability system supports two primary workflows:

1. **Snapshot deploy** — build a repository locally, export it, upload to production, import as a new repository.
2. **Multi-source merge** — build several smaller repositories locally (by topic or document set), then merge them all into a single production repository.

Both workflows use the same export archive format and import API. The difference is the import mode: `create` for the first import, `merge` for subsequent ones.

## Export

Export produces an `ExportArchive` containing four sections:

| Section | Contents |
|---------|----------|
| **Manifest** | Format version, library version, export timestamp, repository metadata, entity/relationship counts, embedding model info, legal/copyright metadata, pipeline metadata |
| **Vocabulary** | Full vocabulary definition — entity types, relationship types, governance mode |
| **Entities** | All entities with properties, data, embeddings, and provenance |
| **Relationships** | All relationships with properties, bidirectional flag, and provenance |

### Buffered vs streaming

| Method | Use case |
|--------|----------|
| `exportRepository(id)` | Small repos — returns complete `ExportArchive` in memory |
| `exportRepositoryStream(id)` | Large repos — `AsyncGenerator<ExportStreamItem>` yielding manifest, vocabulary, then entity and relationship chunks (batches of 100) |

**Stream order:** `manifest` → `vocabulary` → `entities` (1..n chunks) → `relationships` (1..n chunks). Each chunk includes a `sequence` number and `isLast` flag.

Export is always a **complete snapshot**. There is no delta export — every entity and relationship is included regardless of when it was last modified.

### Embedding metadata

If an `EmbeddingProvider` was active when the export was created, the manifest includes:

- `modelId` — e.g. `Qwen/Qwen3-Embedding-8B`
- `dimensions` — e.g. `4096`
- A note: "Embeddings are model-specific. Re-embed after import if using a different model."

### Legal and copyright metadata

The manifest includes an optional `legal` section for embedding copyright and licensing information. This is critical for commercial distribution — vendors such as equipment manufacturers can stamp their archives with ownership and usage restrictions.

| Field | Required | Example |
|-------|----------|---------|
| `copyright` | Yes | `"© 2026 Caterpillar Inc."` |
| `license` | No | `"LicenseRef-Proprietary"` or `"Apache-2.0"` |
| `licenseUrl` | No | `"https://cat.com/data-license"` |
| `terms` | No | `"For use with authorized Cat dealer systems only"` |
| `publisher` | No | `"Caterpillar Inc."` |
| `contact` | No | `"data-licensing@cat.com"` |

Legal metadata can be set via the `ExportOptions.legal` parameter when calling `exportRepository()` or `exportRepositoryStream()`, or via the `legal` parameter on the `memory_export_repository` MCP tool.

### Pipeline metadata

When an archive is produced by the indexing pipeline, the manifest includes a `pipeline` section describing how the data was extracted:

- `extractionModel` — LLM model used for extraction (e.g. `claude-sonnet-4-20250514`)
- `extractionProvider` — LLM provider name (e.g. `anthropic`, `vllm`)
- `embeddingsModel` — Embeddings model used (e.g. `Qwen/Qwen3-Embedding-8B`)
- `sourceCount` — Number of source documents processed
- `sources` — List of source document names
- `parameters` — Extraction parameters (chunk size, overlap, max output tokens)

This metadata is set automatically by the Consolidator when the `ConsolidationPipelineContext` is provided.

## Import

### Modes

#### Create mode

Creates a new repository from the archive. Use this for the first import or when replacing a repository entirely.

```typescript
{
  target: {
    mode: 'create',
    repositoryId: 'new-uuid',
    config: { /* RepositoryConfig */ }
  },
  reEmbed: true  // optional: regenerate embeddings with the current provider
}
```

- Vocabulary from the archive is saved as-is
- All entities and relationships are imported without conflict checking
- The repository must not already exist

#### Merge mode

Imports into an existing repository. Use this when combining multiple exports into one repository, or updating a repository with new data.

```typescript
{
  target: {
    mode: 'merge',
    repositoryId: 'existing-uuid'
  },
  vocabularyConflict: 'extend',
  entityConflict: 'skip',
  reEmbed: true  // optional
}
```

### Conflict resolution

#### Vocabulary conflicts

When merging, the source and target vocabularies may differ. Three strategies:

| Strategy | Behaviour |
|----------|-----------|
| `reject` (default) | Fail the import if vocabularies differ at all. Safest option. |
| `extend` | Add new types from the source. Keep the target's version of any type that exists in both. Warns about differences. |
| `prompt` | Return failure with a detailed list of differences for the caller to inspect and handle manually. |

On `extend`, the vocabulary version is bumped (e.g. `1.0.0` → `1.1.0`).

#### Entity conflicts

When an imported entity has the same slug as an existing entity (slugs are deterministic: `{type}:{slugified-label}`):

| Strategy | Behaviour |
|----------|-----------|
| `skip` (default) | Keep the existing entity, skip the import. Counted as `entitiesSkipped`. |
| `overwrite` | Replace the existing entity entirely with the imported version — label, summary, properties, data, embeddings, provenance. |
| `rename` | Import with a modified ID: `{originalId}-imported`. Creates a new entity alongside the existing one. |

#### Relationship conflicts

Relationships are always **skip-if-exists**. If the source or target entity is missing, the relationship is skipped as orphaned. There is no overwrite or rename option for relationships.

### Import result

```typescript
{
  success: boolean,
  repositoryId: string,
  statistics: {
    entitiesImported: number,
    entitiesSkipped: number,
    relationshipsImported: number,
    relationshipsSkipped: number,
    vocabularyExtensions: number
  },
  warnings: ImportWarning[]  // codes: entity_skipped, entity_overwritten,
                             //        entity_renamed, relationship_skipped,
                             //        relationship_orphaned, vocabulary_conflict, etc.
}
```

### Buffered vs streaming import

| Method | Use case |
|--------|----------|
| `importRepository(archive, options)` | Small repos — accepts complete `ExportArchive` |
| `importRepositoryStream(header, chunks, options)` | Large repos — accepts `ImportStreamHeader` + `AsyncIterable<ImportChunk>`, processes in chunks to avoid loading the entire repo into memory |

## Workflow: Snapshot deploy (single source)

The simplest production workflow. One local repository, one production repository.

```
Local machine                          Production server
─────────────                          ─────────────────
1. Build repo from documents
2. Export to .dkg
3. Upload .dkg ────────────────────►   4. Create new repo (mode: 'create')
                                       5. Import archive into new repo
                                       6. Update Knowledge Set pointer
                                       7. Delete old repo (optional)
```

**Why delete and recreate rather than merge?** When the local machine is the sole source of truth and production is a read-only copy, delete-and-recreate is simpler and avoids all conflict resolution complexity. The cascade delete in SQL Server removes all entities, relationships, vocabularies, and changelog in one operation.

**Stable identity:** If the consuming application uses a Knowledge Set abstraction that points to a repository by ID, the repo ID changing on recreate is not a problem — update the pointer after import. This cleanly separates the stable domain identity ("legal knowledge") from the versioned data snapshot.

**Rollback:** Keep the old repository alive until the new import is verified. Delete it after confirmation. This gives you a zero-downtime upgrade path.

## Workflow: Multi-source merge

Build topic-specific repositories locally, then merge them into a single production repository. This is useful when:

- Different document sets are indexed separately (e.g. statutes vs guidance vs case law)
- Different teams or processes contribute to the same knowledge domain
- You want to re-index one topic without re-processing everything

```
Local machine                          Production server
─────────────                          ─────────────────
Repo A: legal-statutes
Repo B: legal-guidance
Repo C: legal-case-law

1. Export A ────────────────────────►  2. Create 'legal' repo (mode: 'create')
                                       3. Import A

4. Export B ────────────────────────►  5. Import B (mode: 'merge',
                                             vocabularyConflict: 'extend',
                                             entityConflict: 'skip')

6. Export C ────────────────────────►  7. Import C (mode: 'merge', same options)
```

**First import** uses `create` mode. **Subsequent imports** use `merge` mode with `vocabularyConflict: 'extend'` so that entity and relationship types from all sources are combined.

### Entity ID collisions across sources

Entity slugs are deterministic: `{type}:{slugified-label}`. If two local repos both contain an entity with the same type and label — e.g. `statute:companies-act-2006` — they'll produce the same slug (though their GUID `id` values will differ).

This is usually desirable (deduplication). Choose the entity conflict strategy accordingly:

- `skip` — first import wins, subsequent imports won't overwrite. Use when all sources are equally authoritative.
- `overwrite` — last import wins. Use when one source should take precedence and you control the import order.
- `rename` — both versions are kept with different IDs. Use when you need to preserve both and reconcile later.

### Rebuilding one source

When you add new documents to one topic and re-index:

**Option A — Full rebuild (recommended for v1):**
1. Delete the production repo
2. Re-import all sources in order

**Option B — Selective merge:**
1. Re-export only the changed source (e.g. repo B)
2. Merge into production with `entityConflict: 'overwrite'`
3. New entities are added, existing ones are updated
4. Caveat: entities that were *removed* from the source will remain in production (no tombstone support yet)

Option A is simpler and guarantees consistency. Option B is faster for large repos but may leave stale entities.

## Vocabulary design for multi-source merge

When merging multiple repos, plan the vocabulary up front:

1. **Define a shared vocabulary** that all local repos use. This avoids vocabulary conflicts entirely during merge.
2. **Use `managed` or `locked` governance** on the production repo to prevent accidental type proliferation.
3. **Use `extend` vocabulary conflict** during merge if sources may introduce new types — but review the warnings to ensure type naming is consistent.

Vocabulary types are normalised (relationship types to `SCREAMING_SNAKE_CASE`), which helps with consistency, but entity type names are preserved as-is. Coordinate naming across sources.

## Re-embedding after import

If the production environment uses a different embedding model than the local machine, set `reEmbed: true` in the import options. This regenerates all entity embeddings using the production `EmbeddingProvider` after import.

If both environments use the same model, embeddings transfer directly and `reEmbed` can be omitted.

## Size considerations

- **Streaming APIs** (`exportRepositoryStream`, `importRepositoryStream`) process in chunks of 100 entities/relationships. Use these for repos over a few thousand entities.
- **SQL Server throughput** is the bottleneck for large imports. The provider uses `MERGE` statements for upsert semantics. For gigabyte-scale repos, import time will be dominated by SQL write throughput.
- **Delete is fast** — cascade delete on the repository row removes everything in one SQL operation, regardless of repo size.

## Future: Delta export/import

The current export is always a complete snapshot. A future delta capability could:

1. **Export since timestamp** — filter entities/relationships by `modified_at` to produce a partial archive. The provenance fields already track modification timestamps.
2. **Tombstone tracking** — record deletions so that a delta import can remove stale entities from the target.
3. **Reconciliation manifest** — include a list of all entity IDs in the export so the target can identify and remove entities that are no longer present in the source.

Until delta support is implemented, the recommended approach for large repos is either full rebuild (delete and recreate) or selective merge with `overwrite` (accepting that deleted entities will persist).
