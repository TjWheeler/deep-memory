// SearchProvider — optional full-text search interface

import type { SearchOptions } from '../types/queries.js';
import type { PaginatedResult, SearchHit } from '../types/results.js';

/** Entity data indexed for full-text search */
export interface SearchableEntity {
  entityId: string;  // GUID used as index key
  entityType: string;
  label: string;
  summary?: string;
  properties?: Record<string, unknown>;
  data?: string;
}

/**
 * SearchProvider — enhances entity finding with full-text search.
 *
 * Optional. When not provided, `findEntities` falls back to the
 * StorageProvider's basic label/property matching.
 */
export interface SearchProvider {
  /** Index an entity for full-text search */
  indexEntity(
    repositoryId: string,
    entity: SearchableEntity,
  ): Promise<void>;

  /** Remove an entity from the search index */
  removeEntity(repositoryId: string, entityId: string): Promise<void>;

  /** Full-text search across entity labels, summaries, properties, and data */
  search(
    repositoryId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<PaginatedResult<SearchHit>>;

  /** Re-index an entire repository (for rebuild/migration) */
  reindexRepository?(
    repositoryId: string,
    entities: AsyncIterable<SearchableEntity>,
  ): Promise<void>;
}
