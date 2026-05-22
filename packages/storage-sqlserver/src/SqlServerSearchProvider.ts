// SqlServerSearchProvider — SQL Server full-text search implementation of SearchProvider

import sql from 'mssql';
import type { SearchProvider, SearchableEntity } from '@utaba/deep-memory/providers';
import type { SearchOptions } from '@utaba/deep-memory/types';
import type { PaginatedResult, SearchHit } from '@utaba/deep-memory/types';
import { ProviderError } from '@utaba/deep-memory';
import { getSearchProcSQL } from './schema.js';

/** Configuration for SqlServerSearchProvider */
export interface SqlServerSearchProviderConfig {
  /** mssql connection pool (should be the same pool used by the StorageProvider) */
  pool: sql.ConnectionPool;
  /** SQL Server schema name (default: 'dbo') */
  schema?: string;
}

/**
 * Normalize a raw FT rank (typically 0–1000 from FREETEXTTABLE) into a 0–1 score.
 * Clamps to [0, 1] to handle edge cases.
 */
function normalizeRank(rank: number): number {
  return Math.min(1, Math.max(0, rank / 1000));
}

/**
 * Build highlight snippets from the stored-procedure output.
 * For each field that matched, extract a window around the first occurrence
 * of any query term and return it.
 */
function buildHighlights(
  query: string,
  row: Record<string, unknown>,
): Record<string, string[]> | undefined {
  const highlights: Record<string, string[]> = {};
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  const fields: Array<{ key: string; hlCol: string }> = [
    { key: 'label', hlCol: 'hl_label' },
    { key: 'summary', hlCol: 'hl_summary' },
    { key: 'data', hlCol: 'hl_data' },
    { key: 'properties', hlCol: 'hl_properties' },
  ];

  for (const { key, hlCol } of fields) {
    const snippet = row[hlCol] as string | null;
    if (!snippet) continue;

    // Find the best window around a matched term
    const lowerSnippet = snippet.toLowerCase();
    for (const term of terms) {
      const idx = lowerSnippet.indexOf(term);
      if (idx !== -1) {
        const windowStart = Math.max(0, idx - 40);
        const windowEnd = Math.min(snippet.length, idx + term.length + 40);
        const prefix = windowStart > 0 ? '...' : '';
        const suffix = windowEnd < snippet.length ? '...' : '';
        const window = prefix + snippet.slice(windowStart, windowEnd) + suffix;
        if (!highlights[key]) highlights[key] = [];
        highlights[key].push(window);
        break; // one snippet per field
      }
    }
  }

  return Object.keys(highlights).length > 0 ? highlights : undefined;
}

export class SqlServerSearchProvider implements SearchProvider {
  private readonly pool: sql.ConnectionPool;
  private readonly schema: string;
  private procedureCreated = false;

  constructor(config: SqlServerSearchProviderConfig) {
    this.pool = config.pool;
    this.schema = config.schema ?? 'dbo';
  }

  /**
   * Ensure the stored procedure exists. Called lazily on first search.
   * Idempotent — uses CREATE OR ALTER.
   */
  async ensureProcedure(): Promise<void> {
    if (this.procedureCreated) return;
    try {
      const ddl = getSearchProcSQL(this.schema);
      await this.pool.request().query(ddl);
      this.procedureCreated = true;
    } catch (err) {
      throw new ProviderError(
        `Failed to create search stored procedure: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Index an entity for full-text search.
   *
   * No-op: the FT index on dm_entities uses CHANGE_TRACKING AUTO,
   * so SQL Server automatically indexes rows on insert/update.
   */
  async indexEntity(
    _repositoryId: string,
    _entity: SearchableEntity,
  ): Promise<void> {
    // Auto-maintained by SQL Server FT change tracking
  }

  /**
   * Remove an entity from the search index.
   *
   * No-op: the FT index auto-removes when the row is deleted from dm_entities.
   */
  async removeEntity(
    _repositoryId: string,
    _entityId: string,
  ): Promise<void> {
    // Auto-maintained by SQL Server FT change tracking
  }

  /**
   * Full-text search across entity labels, summaries, properties, and data.
   * Calls the dm_search_entities stored procedure using FREETEXTTABLE
   * for natural-language queries.
   */
  async search(
    repositoryId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<PaginatedResult<SearchHit>> {
    await this.ensureProcedure();

    const limit = options?.limit ?? 20;
    const offset = options?.offset ?? 0;
    const entityTypes = options?.entityTypes;

    try {
      const request = this.pool.request();
      request.input('RepositoryId', sql.UniqueIdentifier, repositoryId);
      request.input('Query', sql.NVarChar(4000), query);
      request.input(
        'EntityTypes',
        sql.NVarChar(sql.MAX),
        entityTypes && entityTypes.length > 0
          ? JSON.stringify(entityTypes)
          : null,
      );
      request.input('Limit', sql.Int, limit);
      request.input('Offset', sql.Int, offset);
      request.input('UseContains', sql.Bit, 0); // FREETEXTTABLE for natural language

      const result = await request.execute(
        `[${this.schema}].[dm_search_entities]`,
      );

      const rows = result.recordset as Array<Record<string, unknown>>;

      const total =
        rows.length > 0 ? (rows[0]!['total_count'] as number) : 0;

      const items: SearchHit[] = rows.map((row) => ({
        id: row['entity_id'] as string,
        score: normalizeRank(row['ft_rank'] as number),
        highlights: buildHighlights(query, row),
      }));

      return {
        items,
        total,
        hasMore: offset + items.length < total,
        limit,
        offset,
      };
    } catch (err) {
      throw new ProviderError(
        `Full-text search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Re-index an entire repository.
   *
   * Since the FT index is auto-maintained, this triggers a manual
   * population of the full-text catalog to pick up any pending changes.
   */
  async reindexRepository(
    _repositoryId: string,
    _entities: AsyncIterable<SearchableEntity>,
  ): Promise<void> {
    try {
      await this.pool
        .request()
        .query(
          `ALTER FULLTEXT CATALOG [dm_fulltext_catalog] REORGANIZE`,
        );
    } catch (err) {
      throw new ProviderError(
        `Full-text reindex failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}
