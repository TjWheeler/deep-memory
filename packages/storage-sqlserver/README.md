# @utaba/deep-memory-storage-sqlserver

SQL Server storage provider for [`@utaba/deep-memory`](https://www.npmjs.com/package/@utaba/deep-memory). Provides persistent, multi-tenant graph storage backed by SQL Server (2016+).

## Installation

```bash
pnpm add @utaba/deep-memory @utaba/deep-memory-storage-sqlserver
```

**Runtime dependency:** [`mssql`](https://www.npmjs.com/package/mssql) (the Node.js SQL Server driver).

## Quick Start

```typescript
import { DeepMemory } from '@utaba/deep-memory';
import { SqlServerStorageProvider } from '@utaba/deep-memory-storage-sqlserver';

const provider = new SqlServerStorageProvider({
  connection: {
    server: 'localhost',
    port: 1435,
    database: 'deep-memory',
    user: 'sa',
    password: 'YourPassword',
    options: { trustServerCertificate: true },
  },
});

const dm = new DeepMemory({ storage: provider });

// Call once at startup / deployment to create or migrate tables
await dm.ensureSchema();
```

## Configuration

### `SqlServerStorageProviderConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `connection` | `sql.config \| sql.ConnectionPool` | *required* | Either an `mssql` config object, a connection-string config, or an existing `ConnectionPool` instance. |
| `schema` | `string` | `'dbo'` | SQL Server schema name. Must already exist in the database. |
| `vocabularyCacheTtlMs` | `number` | `60000` | Lifetime in milliseconds of an entry in the per-process vocabulary cache. A vocabulary change made by another process reaches this one's reads, and so the validation of its writes, within this window. `0` disables the cache. Must be a non-negative finite number; anything else throws `InvalidInputError` at construction. See [Vocabulary cache](#vocabulary-cache). |

### Connection options

**Config object:**

```typescript
const provider = new SqlServerStorageProvider({
  connection: {
    server: 'localhost',
    port: 1435,
    database: 'deep-memory',
    user: 'sa',
    password: 'YourPassword',
    options: { trustServerCertificate: true },
  },
});
```

**Connection string:**

```typescript
const provider = new SqlServerStorageProvider({
  connection: {
    connectionString:
      'Server=localhost,1435;Database=deep-memory;User Id=sa;Password=YourPassword;TrustServerCertificate=true',
  },
});
```

**Existing connection pool** (shared with your application):

```typescript
import sql from 'mssql';

const pool = new sql.ConnectionPool({ /* your config */ });
await pool.connect();

const provider = new SqlServerStorageProvider({ connection: pool });
```

When you pass an existing pool, the provider will not close it on `dispose()` — your application retains ownership.

## Lifecycle

```typescript
// 1. Create the provider
const provider = new SqlServerStorageProvider({ connection: config });

// 2. Initialise — connects to SQL Server
await provider.initialise();

// 3. Use via DeepMemory
const dm = new DeepMemory({ storage: provider });
const repo = await dm.createRepository({ ... });

// 4. Dispose — closes the connection pool (if provider owns it)
await provider.dispose();
```

## Database Schema

### Table overview

All tables use the `dm_` prefix to avoid collisions when sharing a database with other applications.

| Table | Purpose |
|-------|---------|
| `dm_meta` | Schema version tracking (single row) |
| `dm_repositories` | Repository definitions and governance config |
| `dm_vocabularies` | One vocabulary JSON document per repository |
| `dm_vocabulary_change_log` | Audit trail for vocabulary changes |
| `dm_entities` | Graph nodes with typed properties, optional data/embeddings, and provenance |
| `dm_relationships` | Graph edges with typed properties, directionality, and provenance |

### Entity-relationship diagram

```
dm_repositories
  PK: repository_id
  │
  ├──< dm_vocabularies (1:1)
  │     PK/FK: repository_id
  │
  ├──< dm_vocabulary_change_log (1:N)
  │     PK: (repository_id, change_id)
  │     FK: repository_id → dm_repositories
  │
  ├──< dm_entities (1:N)
  │     PK: (repository_id, entity_id)
  │     FK: repository_id → dm_repositories
  │     IX: (repository_id, entity_type)
  │     IX: (repository_id, label)
  │     IX: (repository_id, modified_at DESC)
  │
  └──< dm_relationships (1:N)
        PK: (repository_id, relationship_id)
        FK: repository_id → dm_repositories (CASCADE DELETE)
        FK: (repository_id, source_entity_id) → dm_entities
        FK: (repository_id, target_entity_id) → dm_entities
        IX: (repository_id, source_entity_id) INCLUDE (relationship_type, target_entity_id, bidirectional)
        IX: (repository_id, target_entity_id) INCLUDE (relationship_type, source_entity_id, bidirectional)
        IX: (repository_id, relationship_type)
```

### Naming conventions

| Element | Convention | Example |
|---------|-----------|---------|
| Tables | `dm_` prefix + plural snake_case | `dm_entities` |
| Columns | snake_case | `entity_type`, `created_at` |
| Primary keys | `pk_{table}` | `pk_dm_entities` |
| Foreign keys | `fk_{table}_{referenced_table}` | `fk_dm_relationships_entities` |
| Indexes | `ix_{table}_{columns}` | `ix_dm_entities_type` |

### Multi-tenancy

All data is scoped by `repository_id`. Each repository is an isolated knowledge graph — entities, relationships, vocabulary, and change log are all partitioned by this key. This supports multi-tenant deployments where each agent or domain has its own repository within a shared database.

### Key size limits

Composite primary keys are sized to stay within SQL Server's 900-byte clustered index limit:

| Column | Max Length | Bytes (NVARCHAR) |
|--------|-----------|-----------------|
| `repository_id` | 128 chars | 256 bytes |
| `entity_id` | 300 chars | 600 bytes |
| `relationship_id` | 300 chars | 600 bytes |
| `change_id` | 128 chars | 256 bytes |

Largest PK: `(repository_id, entity_id)` = 856 bytes (under 900 limit).

### Cascade deletes

Deleting a repository cascades to vocabularies, vocabulary change log, entities, and relationships. Entity deletion explicitly removes related relationships before removing the entity.

`deleteEntitiesByType` and `deleteRelationshipsByType` each run as one batch in one transaction that first locks the repository row, so a missing repository deletes nothing and throws `RepositoryNotFoundError`. The type name matches exactly: the type columns use the database's case-insensitive default collation, so the predicate adds a binary-collation comparison and a byte-length check, and `Project` or `project ` never deletes `project`. The plain comparison stays in front, so the delete still seeks the `(repository_id, type)` index. The whole delete must finish within the connection's `requestTimeout` (`mssql` defaults to 15 seconds); raise it in the `connection` config for very large types. Two by-type deletes running at the same time on the same repository can deadlock; SQL Server rolls the victim back and it surfaces as a `ProviderError`. The delete is all-or-nothing, so retrying it is safe.

### Vocabulary writes

`createRepository` inserts the repository's `dm_vocabularies` row, seeded from `config.vocabulary` or an empty vocabulary. `saveVocabulary(id, vocabulary, expectedVersion, changeRecord?)` is compare-and-set, and runs as one batch in one transaction:

1. It locks the repository row first (`HOLDLOCK`), in the same order as `deleteRepository` and the by-type deletes, so it cannot deadlock with a concurrent repository delete. With no repository row nothing is written.
2. One `UPDATE` writes the vocabulary row, with a `WHERE` clause that compares `JSON_VALUE([vocabulary], '$.version')` with `expectedVersion` using a binary collation, and their byte lengths with `DATALENGTH`: `=` ignores trailing spaces under every collation, so the length check keeps `"1.0.0 "` from matching `"1.0.0"`.
3. When the `UPDATE` matched and a `changeRecord` was given, it inserts the record into `dm_vocabulary_change_log`. `XACT_ABORT` is on, so a failed insert rolls the vocabulary write back too: the change and its record commit together or not at all.
4. When the `UPDATE` matched nothing, the same batch reads the stored version. A stale version throws `VocabularyVersionConflictError`; a missing repository or vocabulary row throws `RepositoryNotFoundError`. Neither writes a change record.

The version is read from the JSON document, so this needs no schema change and no upgrade step.

### Vocabulary cache

The engine validates every write against the vocabulary, so `getVocabulary` reads through a per-process cache rather than paying a round trip each time. An entry lives for `vocabularyCacheTtlMs` (default 60 s; `0` disables the cache) from the read that stored it.

- `getVocabulary(id, { fresh: true })` skips the cache, reads the stored vocabulary, and replaces the entry with what it read. Use it before a vocabulary change, so the `expectedVersion` passed to `saveVocabulary` is the stored one.
- `saveVocabulary` drops the entry whatever the outcome: on success, so this process sees the new vocabulary at once, and on any failure, because a conflict proves the cached copy stale and any other error leaves the stored state unknown.
- `createRepository`, `deleteRepository` and any call that throws `RepositoryNotFoundError` drop the entry too.
- A read that an invalidation overtook is not cached, so a write in this process is never hidden for a TTL by a read that started before it.
- `getRepositoryStats` reads the stored vocabulary, so a missing repository still throws `RepositoryNotFoundError`.

A cache hit is not checked against the database, so within the TTL it can return the vocabulary of a repository another process has deleted, or one another process has since changed. Pass `{ fresh: true }` when the answer must reflect the stored state.

## Schema Management

### Automatic (default)

Call `dm.ensureSchema()` once at startup or deployment. The provider checks for existing tables and creates them if missing. Schema version is tracked in `dm_meta`. This is **not** called automatically — the consuming application decides when to run it.

### Manual

For production environments with managed migrations, export the DDL and run it yourself:

```typescript
import { getSchemaSQL, SCHEMA_VERSION } from '@utaba/deep-memory-storage-sqlserver';

// Get DDL for default schema (dbo)
const ddl = getSchemaSQL();

// Get DDL for a custom schema
const ddl = getSchemaSQL('my_schema');
```

From the command line:

```bash
node -e "import('@utaba/deep-memory-storage-sqlserver').then(m => console.log(m.getSchemaSQL()))" > schema.sql
```

### Static schema file

A pre-generated copy of the full DDL (schema + search procedure) lives at `schemas/deep-memory-schema-v1.0.sql` inside the package. It is generated from runtime code and must never be hand-edited.

### Version checking

On startup, the provider reads `schema_version` from `dm_meta`:

- **Same version** — no action needed
- **Database newer than provider** — throws `ProviderError` (update the package)
- **Database older than provider** — future migrations will run here; currently creates from scratch

## Query Capabilities

### Entity search

`findEntities()` supports:

- **Type filter** — restrict to specific entity types
- **Text search** — case-insensitive `LIKE` on label and summary columns
- **Property filter** — exact match via `JSON_VALUE()` on the JSON properties column
- **Pagination** — `OFFSET` / `FETCH NEXT` with total count

### Relationship queries

`getEntityRelationships()` supports:

- **Direction** — `outbound`, `inbound`, or `both` (default)
- **Relationship type filter** — restrict to specific types
- **Bidirectional handling** — bidirectional relationships appear in both directions
- **Pagination** — same `OFFSET` / `FETCH NEXT` pattern

### Graph traversal

- **`exploreNeighbourhood()`** — multi-hop BFS exploration from a centre entity, with depth, direction, entity type, and relationship type filters. Results are grouped by relationship type per layer.
- **`findPaths()`** — BFS path finding between two entities, with max depth and relationship type filters. Returns all paths up to the configured limit.

### Timeline

`getTimeline()` returns creation and modification events for an entity plus its relationship creation events, with optional time range and event type filters.

## Bulk Operations

### Export

`exportAll()` returns an async iterable of chunks (batches of 100), first entities then relationships. Suitable for streaming large repositories without loading everything into memory.

```typescript
for await (const chunk of provider.exportAll(repositoryId)) {
  // chunk.type: 'entities' | 'relationships'
  // chunk.data: StoredEntity[] | StoredRelationship[]
  // chunk.isLast: boolean
}
```

### Import

`importBulk()` uses SQL Server `MERGE` statements for upsert semantics — existing records are updated, new records are inserted. It returns the counts of imported entities and relationships.

The import is all-or-nothing, unlike the providers that import row by row: it never reports row errors, and `result.errors` is always empty. Any row that fails rolls the whole import back, and the call rejects with an `ImportError` naming the row, whose `cause` is the typed error (for example `DuplicateEntityError`, `SlugConflictError` or `DuplicateRelationshipError`). A row whose property keys break the [property-name rules](#property-names) is refused before any SQL runs, with an `ImportError` whose `cause` is an `InvalidInputError`; a missing repository is reported first, with `RepositoryNotFoundError`.

The import runs in one transaction that first reads the repository row and holds a shared lock on it until the import commits or rolls back. A concurrent `deleteRepository` or `updateRepository` on that repository waits for the import to finish. A missing repository writes nothing and throws `RepositoryNotFoundError`.

A relationship id is never moved onto another edge:

- **Upsert** (the default): a stored id is updated in place only when the row names the same edge, the same relationship type (compared exactly, including case and trailing spaces) and the same endpoints. The update leaves the stored type and endpoints unchanged. A stored id with a different type or endpoints is refused.
- **Insert** (`skipExistenceCheck: true`): each relationship is a plain `INSERT` that does not look for the id first; the primary key refuses an id that is already stored or repeated within the call.

A refused row rolls the whole import back, like any other failing row: the call rejects with an `ImportError` naming the row, whose `cause` is a `DuplicateRelationshipError` (`RELATIONSHIP_ALREADY_EXISTS`). Providers that import row by row report the same refusal as a row in `result.errors` instead.

## Error Handling

All errors are typed using the `@utaba/deep-memory` error hierarchy:

| Error | When |
|-------|------|
| `ProviderError` | Connection failure, schema issues, SQL errors |
| `RepositoryNotFoundError` | Repository ID doesn't exist (see below) |
| `DuplicateRepositoryError` | Repository ID already exists |
| `EntityNotFoundError` | Entity ID doesn't exist in repository, including a relationship's missing source or target |
| `DuplicateEntityError` | Entity ID already exists in repository |
| `SlugConflictError` | Another entity in the repository holds the slug (the unique index `ix_dm_entities_slug`) |
| `RelationshipNotFoundError` | Relationship ID doesn't exist |
| `DuplicateRelationshipError` | Relationship ID already exists |
| `InvalidInputError` | A property key breaks the [property-name rules](#property-names) |
| `ImportError` | An `importBulk` row failed; the whole import rolled back, and `cause` is the row's typed error |

Unique-key violations are mapped by the index that fired (with an error-number fallback for localised messages), and keep the driver error as `cause`. Slug uniqueness is enforced atomically by the unique index; the engine answers `SlugConflictError` by retrying with the next slug suffix.

Every call that takes a repository id checks the repository, in the same batch as its work wherever it can, and throws `RepositoryNotFoundError` when it is missing, ahead of any not-found, empty or per-id answer: reads, writes, type deletes, timeline, change log, traversals, export and import. The one exception is a `getVocabulary` served from the [vocabulary cache](#vocabulary-cache) within its TTL.

### Property names

Entity and relationship property keys must match `^[A-Za-z_][A-Za-z0-9_]*$` and must not be a reserved system-field name (`RESERVED_ENTITY_PROPERTY_KEYS` / `RESERVED_RELATIONSHIP_PROPERTY_KEYS` from `@utaba/deep-memory`). SQL Server could store other names in its JSON column, but the rule is the same on every provider, so a repository can move between providers unchanged. `createEntity`, `updateEntity` and `createRelationship` check the keys before writing; an `updateEntity` checks only the keys it sets (new, or with a changed value), so a key stored before the rules and carried over unchanged is kept and can be removed.

## Testing

The conformance test suite requires a running SQL Server instance. Set the connection string via environment variable:

```bash
MSSQL_CONNECTION_STRING="Server=localhost,1435;Database=deep-memory;User Id=sa;Password=YourPassword;TrustServerCertificate=true" \
  pnpm --filter @utaba/deep-memory-storage-sqlserver test
```

Without `MSSQL_CONNECTION_STRING`, tests are skipped.

## Exports

```typescript
// Provider class
import { SqlServerStorageProvider } from '@utaba/deep-memory-storage-sqlserver';

// Config type
import type { SqlServerStorageProviderConfig } from '@utaba/deep-memory-storage-sqlserver';

// Schema utilities
import { getSchemaSQL, SCHEMA_VERSION } from '@utaba/deep-memory-storage-sqlserver';
```
