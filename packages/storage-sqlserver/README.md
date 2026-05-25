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

`importBulk()` uses SQL Server `MERGE` statements for upsert semantics — existing records are updated, new records are inserted. Returns a count of imported entities/relationships and any errors.

## Error Handling

All errors are typed using the `@utaba/deep-memory` error hierarchy:

| Error | When |
|-------|------|
| `ProviderError` | Connection failure, schema issues, SQL errors |
| `RepositoryNotFoundError` | Repository ID doesn't exist |
| `DuplicateRepositoryError` | Repository ID already exists |
| `EntityNotFoundError` | Entity ID doesn't exist in repository |
| `DuplicateEntityError` | Entity ID already exists in repository |
| `RelationshipNotFoundError` | Relationship ID doesn't exist |
| `DuplicateRelationshipError` | Relationship ID already exists |

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
