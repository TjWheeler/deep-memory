// Query types — parameters for search and traversal operations

import type { RelationshipDirection } from './relationships.js';
import type { DetailLevel } from './entities.js';

/** Pagination options used across all paginated queries */
export interface PaginationOptions {
  /** Maximum number of results (default 10, max 50) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
}

/** Query for finding entities by label, type, and property filters */
export interface FindEntitiesQuery extends PaginationOptions {
  /** Search term to match against entity labels */
  searchTerm?: string;
  /** Filter by entity type(s) */
  entityTypes?: string[];
  /** Filter by property values */
  properties?: Record<string, unknown>;
  /** Detail level for returned entities (default: summary) */
  detailLevel?: DetailLevel;
  /** Filter by provenance metadata */
  provenance?: ProvenanceFilter;
}

/** Options for neighborhood exploration */
export interface ExploreOptions {
  /** Exploration depth: 1, 2, or 3 (default 1) */
  depth?: 1 | 2 | 3;
  /** Filter by relationship type(s) */
  relationshipTypes?: string[];
  /** Filter result entity types */
  entityTypes?: string[];
  /** Direction filter */
  direction?: RelationshipDirection;
  /** Max results per relationship type (default 10) */
  limitPerType?: number;
  /** Pagination offset per relationship type */
  offsetPerType?: number;
  /** Detail level for returned entities (default: summary) */
  detailLevel?: DetailLevel;
  /** Filter relationships by property values (all filters are AND'd) */
  relationshipPropertyFilters?: PropertyFilter[];
}

/** Options for path finding between two entities */
export interface PathOptions {
  /** Maximum path depth (default 3, max 5) */
  maxDepth?: number;
  /** Filter allowed relationship types */
  relationshipTypes?: string[];
  /** Filter entities in paths by type(s) — only paths through matching entity types are returned */
  entityTypes?: string[];
  /** Maximum number of paths to return (default 5) */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Detail level for returned entities (default: brief) */
  detailLevel?: DetailLevel;
  /** Filter relationships in paths by property values (all filters are AND'd) */
  relationshipPropertyFilters?: PropertyFilter[];
}

/** Options for semantic/vector similarity search */
export interface ConceptSearchOptions extends PaginationOptions {
  /** Minimum similarity threshold (0.0–1.0, default 0.7) */
  similarityThreshold?: number;
  /** Filter by entity type(s) */
  entityTypes?: string[];
  /** Detail level for returned entities (default: summary) */
  detailLevel?: DetailLevel;
}

/** Options for timeline queries */
export interface TimelineOptions extends PaginationOptions {
  /** Date range filter */
  timeRange?: {
    from: string; // ISO 8601
    to: string;   // ISO 8601
  };
  /** Filter by event types */
  eventTypes?: string[];
  /** Filter by provenance metadata */
  provenance?: ProvenanceFilter;
}

/** Filter by provenance metadata (conversation, actor, date range) */
export interface ProvenanceFilter {
  /** Filter to entities created/modified in these conversations */
  conversationIds?: string[];
  /** Filter to entities created/modified by these actors */
  actors?: string[];
  /** Filter to entities created/modified within this date range */
  dateRange?: { from: string; to: string };
}

/** Filter on a relationship property value */
export interface PropertyFilter {
  /** Property name on the relationship */
  key: string;
  /** Filter operator */
  operator: 'eq' | 'neq' | 'isNull' | 'isNotNull' | 'gt' | 'lt' | 'gte' | 'lte' | 'contains';
  /** Value to compare (not needed for isNull/isNotNull) */
  value?: unknown;
}

// ─── Storage-level query types (passed to StorageProvider) ────────

/** Storage-level find query */
export interface StorageFindQuery {
  searchTerm?: string;
  entityTypes?: string[];
  properties?: Record<string, unknown>;
  provenance?: ProvenanceFilter;
  limit: number;
  offset: number;
}

/** Storage-level explore options */
export interface StorageExploreOptions {
  depth: number;
  relationshipTypes?: string[];
  entityTypes?: string[];
  direction: RelationshipDirection;
  limitPerType: number;
  offsetPerType: number;
  relationshipPropertyFilters?: PropertyFilter[];
}

/** Storage-level path finding options */
export interface StoragePathOptions {
  maxDepth: number;
  relationshipTypes?: string[];
  entityTypes?: string[];
  limit: number;
  offset: number;
  relationshipPropertyFilters?: PropertyFilter[];
}

/** Storage-level timeline options */
export interface StorageTimelineOptions {
  timeRange?: {
    from: string;
    to: string;
  };
  eventTypes?: string[];
  provenance?: ProvenanceFilter;
  limit: number;
  offset: number;
}

/** Options for full-text search (SearchProvider) */
export interface SearchOptions extends PaginationOptions {
  /** Filter by entity type(s) */
  entityTypes?: string[];
}
