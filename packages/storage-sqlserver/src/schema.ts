// SQL Server schema for @utaba/deep-memory StorageProvider
//
// Naming conventions:
//   Tables:      plural snake_case (entities, relationships)
//   Columns:     snake_case (entity_id, created_at)
//   Indexes:     ix_{table}_{columns}
//   Primary keys: pk_{table}
//   Foreign keys: fk_{table}_{referenced_table}
//
// All tables are prefixed with dm_ (deep memory) to avoid collisions
// when co-located with other schemas in a shared database.

export const SCHEMA_VERSION = 1;

/**
 * Returns the full DDL for creating the deep-memory schema.
 *
 * @param schema - Optional SQL Server schema name (default: 'dbo').
 *                 The schema must already exist in the database.
 */
export function getSchemaSQL(schema = 'dbo'): string {
  const s = schema;

  return `
-- ============================================================
-- @utaba/deep-memory SQL Server schema v${SCHEMA_VERSION}
-- ============================================================

-- Schema version tracking
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dm_meta' AND schema_id = SCHEMA_ID('${s}'))
BEGIN
  CREATE TABLE [${s}].[dm_meta] (
    [key]   NVARCHAR(100)  NOT NULL,
    [value] NVARCHAR(MAX)  NOT NULL,
    CONSTRAINT [pk_dm_meta] PRIMARY KEY ([key])
  );
  INSERT INTO [${s}].[dm_meta] ([key], [value])
  VALUES ('schema_version', '${SCHEMA_VERSION}');
END;

-- Repositories
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dm_repositories' AND schema_id = SCHEMA_ID('${s}'))
CREATE TABLE [${s}].[dm_repositories] (
  [repository_id]     UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
  [type]              NVARCHAR(128)   NULL,
  [label]             NVARCHAR(500)   NOT NULL,
  [description]       NVARCHAR(MAX)   NULL,
  [legal]             NVARCHAR(MAX)   NULL,
  [owner]             NVARCHAR(500)   NULL,
  [governance_config] NVARCHAR(MAX)   NOT NULL,  -- JSON
  [metadata]          NVARCHAR(MAX)   NULL,      -- JSON
  [created_at]        NVARCHAR(50)    NOT NULL,  -- ISO 8601
  [created_by]        NVARCHAR(255)   NOT NULL,
  CONSTRAINT [pk_dm_repositories] PRIMARY KEY ([repository_id])
);

-- Vocabularies (one JSON document per repository)
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dm_vocabularies' AND schema_id = SCHEMA_ID('${s}'))
CREATE TABLE [${s}].[dm_vocabularies] (
  [repository_id]  UNIQUEIDENTIFIER  NOT NULL,
  [vocabulary]     NVARCHAR(MAX)  NOT NULL,  -- JSON (MemoryVocabulary)
  CONSTRAINT [pk_dm_vocabularies] PRIMARY KEY ([repository_id]),
  CONSTRAINT [fk_dm_vocabularies_repositories]
    FOREIGN KEY ([repository_id]) REFERENCES [${s}].[dm_repositories]([repository_id])
    ON DELETE CASCADE
);

-- Vocabulary change log
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dm_vocabulary_change_log' AND schema_id = SCHEMA_ID('${s}'))
CREATE TABLE [${s}].[dm_vocabulary_change_log] (
  [change_id]         NVARCHAR(128)  NOT NULL,
  [repository_id]     UNIQUEIDENTIFIER  NOT NULL,
  [change_type]       NVARCHAR(50)   NOT NULL,
  [type_name]         NVARCHAR(255)  NOT NULL,
  [previous_version]  NVARCHAR(50)   NULL,
  [new_version]       NVARCHAR(50)   NOT NULL,
  [proposed_by]       NVARCHAR(255)  NOT NULL,
  [proposed_at]       NVARCHAR(50)   NOT NULL,  -- ISO 8601
  [approved_by]       NVARCHAR(255)  NULL,
  [approved_at]       NVARCHAR(50)   NULL,      -- ISO 8601
  [reason]            NVARCHAR(MAX)  NOT NULL,
  CONSTRAINT [pk_dm_vocabulary_change_log] PRIMARY KEY ([repository_id], [change_id]),
  CONSTRAINT [fk_dm_vocabulary_change_log_repositories]
    FOREIGN KEY ([repository_id]) REFERENCES [${s}].[dm_repositories]([repository_id])
    ON DELETE CASCADE
);

CREATE NONCLUSTERED INDEX [ix_dm_vocabulary_change_log_proposed_at]
  ON [${s}].[dm_vocabulary_change_log] ([repository_id], [proposed_at] DESC);

-- Entities
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dm_entities' AND schema_id = SCHEMA_ID('${s}'))
CREATE TABLE [${s}].[dm_entities] (
  [ft_key]                   INT             NOT NULL IDENTITY(1,1),  -- surrogate for FT index
  [entity_id]                NVARCHAR(300)   NOT NULL,
  [slug]                     NVARCHAR(300)   NOT NULL,
  [repository_id]            UNIQUEIDENTIFIER NOT NULL,
  [entity_type]              NVARCHAR(255)   NOT NULL,
  [label]                    NVARCHAR(500)   NOT NULL,
  [summary]                  NVARCHAR(MAX)   NULL,
  [properties]               NVARCHAR(MAX)   NOT NULL,  -- JSON
  [data]                     NVARCHAR(MAX)   NULL,
  [data_format]              NVARCHAR(100)   NULL,
  [embedding]                NVARCHAR(MAX)   NULL,       -- JSON array of numbers
  -- Provenance
  [created_by]               NVARCHAR(255)   NOT NULL,
  [created_by_type]          NVARCHAR(10)    NOT NULL,   -- 'user' | 'agent'
  [created_at]               NVARCHAR(50)    NOT NULL,   -- ISO 8601
  [created_in_conversation]  NVARCHAR(255)   NULL,
  [created_from_message]     NVARCHAR(255)   NULL,
  [modified_by]              NVARCHAR(255)   NOT NULL,
  [modified_by_type]         NVARCHAR(10)    NOT NULL,
  [modified_at]              NVARCHAR(50)    NOT NULL,   -- ISO 8601
  [modified_in_conversation] NVARCHAR(255)   NULL,
  [modified_from_message]    NVARCHAR(255)   NULL,
  CONSTRAINT [pk_dm_entities] PRIMARY KEY ([repository_id], [entity_id]),
  CONSTRAINT [uq_dm_entities_ft_key] UNIQUE ([ft_key]),
  CONSTRAINT [fk_dm_entities_repositories]
    FOREIGN KEY ([repository_id]) REFERENCES [${s}].[dm_repositories]([repository_id])
    ON DELETE CASCADE
);

CREATE NONCLUSTERED INDEX [ix_dm_entities_type]
  ON [${s}].[dm_entities] ([repository_id], [entity_type]);
CREATE NONCLUSTERED INDEX [ix_dm_entities_label]
  ON [${s}].[dm_entities] ([repository_id], [label]);

CREATE UNIQUE NONCLUSTERED INDEX [ix_dm_entities_slug]
  ON [${s}].[dm_entities] ([repository_id], [slug]);

-- Provenance indexes for conversation/actor/temporal queries
CREATE NONCLUSTERED INDEX [ix_dm_entities_created_conversation]
  ON [${s}].[dm_entities] ([repository_id], [created_in_conversation])
  INCLUDE ([entity_id], [entity_type], [label], [summary]);

CREATE NONCLUSTERED INDEX [ix_dm_entities_modified_conversation]
  ON [${s}].[dm_entities] ([repository_id], [modified_in_conversation])
  INCLUDE ([entity_id], [entity_type], [label], [summary]);

CREATE NONCLUSTERED INDEX [ix_dm_entities_created_by]
  ON [${s}].[dm_entities] ([repository_id], [created_by])
  INCLUDE ([entity_id], [entity_type], [label], [summary]);

CREATE NONCLUSTERED INDEX [ix_dm_entities_modified_at]
  ON [${s}].[dm_entities] ([repository_id], [modified_at] DESC)
  INCLUDE ([entity_id], [entity_type], [label], [summary]);

-- Full-text catalog and index on entities
IF NOT EXISTS (SELECT 1 FROM sys.fulltext_catalogs WHERE name = 'dm_fulltext_catalog')
  CREATE FULLTEXT CATALOG [dm_fulltext_catalog] AS DEFAULT;

IF NOT EXISTS (
  SELECT 1 FROM sys.fulltext_indexes fi
  JOIN sys.tables t ON fi.object_id = t.object_id
  WHERE t.name = 'dm_entities' AND t.schema_id = SCHEMA_ID('${s}')
)
CREATE FULLTEXT INDEX ON [${s}].[dm_entities] (
  [label]      LANGUAGE 1033,
  [summary]    LANGUAGE 1033,
  [data]       LANGUAGE 1033,
  [properties] LANGUAGE 1033
)
KEY INDEX [uq_dm_entities_ft_key]
ON [dm_fulltext_catalog]
WITH CHANGE_TRACKING AUTO;

-- Relationships
IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'dm_relationships' AND schema_id = SCHEMA_ID('${s}'))
CREATE TABLE [${s}].[dm_relationships] (
  [relationship_id]          NVARCHAR(300)   NOT NULL,
  [repository_id]            UNIQUEIDENTIFIER NOT NULL,
  [relationship_type]        NVARCHAR(255)   NOT NULL,
  [source_entity_id]         NVARCHAR(300)   NOT NULL,
  [target_entity_id]         NVARCHAR(300)   NOT NULL,
  [properties]               NVARCHAR(MAX)   NOT NULL,  -- JSON
  [bidirectional]            BIT             NOT NULL DEFAULT 0,
  -- Provenance
  [created_by]               NVARCHAR(255)   NOT NULL,
  [created_by_type]          NVARCHAR(10)    NOT NULL,
  [created_at]               NVARCHAR(50)    NOT NULL,
  [created_in_conversation]  NVARCHAR(255)   NULL,
  [created_from_message]     NVARCHAR(255)   NULL,
  [modified_by]              NVARCHAR(255)   NOT NULL,
  [modified_by_type]         NVARCHAR(10)    NOT NULL,
  [modified_at]              NVARCHAR(50)    NOT NULL,
  [modified_in_conversation] NVARCHAR(255)   NULL,
  [modified_from_message]    NVARCHAR(255)   NULL,
  CONSTRAINT [pk_dm_relationships] PRIMARY KEY ([repository_id], [relationship_id]),
  CONSTRAINT [fk_dm_relationships_repositories]
    FOREIGN KEY ([repository_id]) REFERENCES [${s}].[dm_repositories]([repository_id])
    ON DELETE CASCADE,
  CONSTRAINT [fk_dm_relationships_source]
    FOREIGN KEY ([repository_id], [source_entity_id]) REFERENCES [${s}].[dm_entities]([repository_id], [entity_id]),
  CONSTRAINT [fk_dm_relationships_target]
    FOREIGN KEY ([repository_id], [target_entity_id]) REFERENCES [${s}].[dm_entities]([repository_id], [entity_id])
);

CREATE NONCLUSTERED INDEX [ix_dm_relationships_source]
  ON [${s}].[dm_relationships] ([repository_id], [source_entity_id], [relationship_type])
  INCLUDE ([target_entity_id], [bidirectional]);
CREATE NONCLUSTERED INDEX [ix_dm_relationships_target]
  ON [${s}].[dm_relationships] ([repository_id], [target_entity_id], [relationship_type])
  INCLUDE ([source_entity_id], [bidirectional]);
CREATE NONCLUSTERED INDEX [ix_dm_relationships_type]
  ON [${s}].[dm_relationships] ([repository_id], [relationship_type]);

-- Relationship provenance indexes
CREATE NONCLUSTERED INDEX [ix_dm_relationships_created_conversation]
  ON [${s}].[dm_relationships] ([repository_id], [created_in_conversation]);

CREATE NONCLUSTERED INDEX [ix_dm_relationships_modified_at]
  ON [${s}].[dm_relationships] ([repository_id], [modified_at] DESC);

-- Table-valued parameter type for batch ID lookups (eliminates plan cache bloat)
IF NOT EXISTS (SELECT 1 FROM sys.types WHERE name = 'dm_id_list' AND is_table_type = 1)
  CREATE TYPE [${s}].[dm_id_list] AS TABLE ([id] NVARCHAR(300) NOT NULL);
`.trim();
}

/**
 * Returns DDL for the dm_search_entities stored procedure.
 *
 * The procedure uses FREETEXTTABLE for natural-language queries and falls back
 * to CONTAINSTABLE when the caller passes @UseContains = 1 (exact phrase / prefix).
 * It returns ranked results with highlight snippets for label, summary, and data.
 *
 * Must be executed as a separate batch (not inside the main schema DDL) because
 * CREATE OR ALTER PROCEDURE must be the first statement in a batch.
 */
export function getSearchProcSQL(schema = 'dbo'): string {
  const s = schema;

  return `
CREATE OR ALTER PROCEDURE [${s}].[dm_search_entities]
  @RepositoryId   UNIQUEIDENTIFIER,
  @Query          NVARCHAR(4000),
  @EntityTypes    NVARCHAR(MAX) = NULL,   -- JSON array of strings, e.g. '["person","project"]'
  @Limit          INT = 20,
  @Offset         INT = 0,
  @UseContains    BIT = 0                 -- 0 = FREETEXTTABLE (natural language), 1 = CONTAINSTABLE (exact/prefix)
AS
BEGIN
  SET NOCOUNT ON;

  -- Parse entity type filter from JSON array into a temp table
  CREATE TABLE #entity_types ([type_name] NVARCHAR(255));
  IF @EntityTypes IS NOT NULL AND @EntityTypes <> '[]'
  BEGIN
    INSERT INTO #entity_types ([type_name])
    SELECT TRIM(value) FROM OPENJSON(@EntityTypes);
  END;

  DECLARE @HasTypeFilter BIT = CASE WHEN EXISTS (SELECT 1 FROM #entity_types) THEN 1 ELSE 0 END;

  -- CTE: ranked full-text matches
  ;WITH ft_results AS (
    SELECT
      e.[entity_id],
      e.[slug],
      e.[entity_type],
      e.[label],
      e.[summary],
      e.[data],
      e.[properties],
      ft.[RANK] AS ft_rank
    FROM (
      SELECT [KEY], [RANK]
      FROM FREETEXTTABLE([${s}].[dm_entities], ([label], [summary], [data], [properties]), @Query)
      WHERE @UseContains = 0
      UNION ALL
      SELECT [KEY], [RANK]
      FROM CONTAINSTABLE([${s}].[dm_entities], ([label], [summary], [data], [properties]), @Query)
      WHERE @UseContains = 1
    ) AS ft
    INNER JOIN [${s}].[dm_entities] e ON e.[ft_key] = ft.[KEY]
    WHERE e.[repository_id] = @RepositoryId
      AND (@HasTypeFilter = 0 OR e.[entity_type] IN (SELECT [type_name] FROM #entity_types))
  ),
  -- Count total matching rows before pagination
  ft_counted AS (
    SELECT *, COUNT(*) OVER () AS total_count FROM ft_results
  )
  SELECT
    [entity_id],
    [slug],
    [entity_type],
    [label],
    [summary],
    [data],
    [properties],
    [ft_rank],
    [total_count],
    -- Highlight snippets: return the first 200 chars of each matched field
    -- (the application layer will do finer-grained highlighting using the query terms)
    CASE WHEN FREETEXT([label], @Query)      THEN LEFT([label], 200)   ELSE NULL END AS [hl_label],
    CASE WHEN FREETEXT([summary], @Query)     THEN LEFT(CAST([summary] AS NVARCHAR(200)), 200) ELSE NULL END AS [hl_summary],
    CASE WHEN FREETEXT([data], @Query)        THEN LEFT(CAST([data] AS NVARCHAR(200)), 200)    ELSE NULL END AS [hl_data],
    CASE WHEN FREETEXT([properties], @Query)  THEN LEFT(CAST([properties] AS NVARCHAR(200)), 200) ELSE NULL END AS [hl_properties]
  FROM ft_counted
  ORDER BY [ft_rank] DESC
  OFFSET @Offset ROWS FETCH NEXT @Limit ROWS ONLY;

  DROP TABLE #entity_types;
END;
  `.trim();
}
