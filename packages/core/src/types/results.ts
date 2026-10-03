// Result types — structured responses from queries and traversal

import type { Entity, EntityBrief, EntitySummary, StoredEntity } from './entities.js';
import type { EnrichedRelationship, StoredRelationship } from './relationships.js';
import type { ResolvedVocabulary } from './vocabulary.js';
import type { RepositoryStats } from './repositories.js';
import type { ValidationError } from '../vocabulary/VocabularyValidator.js';
import type { DeepMemoryErrorCode } from '../core/errors.js';

/**
 * Paginated result wrapper.
 *
 * `total` is the exact count of items matching the query when the storage
 * provider can compute it cheaply (typically via a parallel `COUNT(1)` or
 * equivalent on an indexed predicate). It is `undefined` when computing an
 * exact total would be more expensive than the query itself — e.g. the Cosmos
 * `findEntities` path with `properties` filters, where the server-side
 * approximate prefilter would inflate a count by false positives that are
 * only resolved client-side. Callers that need a "more pages?" signal should
 * use `hasMore`, which providers derive from `total` when present and from
 * `items.length === limit` otherwise.
 */
export interface PaginatedResult<T> {
  items: T[];
  total: number | undefined;
  hasMore: boolean;
  limit: number;
  offset: number;
}

/** Center entity in a neighborhood exploration */
export interface NeighborhoodCenter {
  id: string;
  slug: string;
  entityType: string;
  label: string;
}

/** A group of entities connected by a specific relationship type */
export interface NeighborhoodGroup {
  total: number;
  returned: number;
  entities: Array<Entity | EntitySummary | EntityBrief>;
}

/** A layer of connected entities at a specific depth */
export interface NeighborhoodLayer {
  /** Keyed by relationship type */
  [relationshipType: string]: NeighborhoodGroup;
}

/** Result of neighborhood exploration */
export interface Neighborhood {
  center: NeighborhoodCenter;
  layers: NeighborhoodLayer[];
  statistics: {
    totalEntities: number;
    returnedEntities: number;
    truncatedTypes: string[];
  };
}

/** A single path between two entities */
export interface Path {
  length: number;
  entities: Array<Entity | EntitySummary | EntityBrief>;
  relationships: Array<{
    id: string;
    type: string;
    direction: string;
    properties: Record<string, unknown>;
  }>;
}

/** Result of path finding */
export interface PathResult {
  totalPaths: number;
  returned: number;
  paths: Path[];
}

/** Entity with a relevance/similarity score */
export interface ScoredEntity {
  id: string;
  slug: string;
  entityType: string;
  label: string;
  summary?: string;
  score: number;
}

/** A related entity reference with human-readable info */
export interface TimelineEntityRef {
  id: string;
  slug: string;
  label: string;
}

/** Relationship detail included in relationship timeline events */
export interface TimelineRelationshipDetail {
  id: string;
  relationshipType: string;
  sourceEntity: TimelineEntityRef;
  targetEntity: TimelineEntityRef;
}

/** A single timeline event */
export interface TimelineEvent {
  timestamp: string;
  eventType: string;
  description: string;
  relatedEntities: TimelineEntityRef[];
  relationship?: TimelineRelationshipDetail;
}

/** Result of a timeline query */
export interface TimelineResult {
  id: string;
  slug: string;
  totalEvents: number;
  returned: number;
  events: TimelineEvent[];
}

/** Result of a getGraph query — paginated entities with enriched relationships */
export interface GraphResult {
  vocabulary: ResolvedVocabulary;
  stats: RepositoryStats;
  entities: Array<Entity | EntitySummary | EntityBrief>;
  relationships: EnrichedRelationship[];
  /** Total relationship count for this page (before truncation) */
  totalRelationships: number;
  /** Whether the relationships were truncated due to the max limit */
  relationshipsTruncated: boolean;
  hasMore: boolean;
  cursor?: string;
}

/** Map of entity ID → Entity (for batch retrieval) */
export type EntityMap = Map<string, EntitySummary>;

// ─── Storage-level result types ──────────────────────────────────

/** Storage-level neighborhood (uses StoredEntity) */
export interface StorageNeighborhoodGroup {
  total: number;
  entities: StoredEntity[];
  relationships: StoredRelationship[];
}

export interface StorageNeighborhoodLayer {
  [relationshipType: string]: StorageNeighborhoodGroup;
}

export interface StorageNeighborhood {
  centerId: string;
  layers: StorageNeighborhoodLayer[];
}

/** Storage-level path result */
export interface StoragePath {
  entityIds: string[];
  relationshipIds: string[];
}

export interface StoragePathResult {
  paths: StoragePath[];
  totalPaths: number;
}

/** Storage-level timeline result */
export interface StorageTimelineEvent {
  timestamp: string;
  eventType: string;
  entityId: string;
  relationshipId?: string;
}

export interface StorageTimelineResult {
  events: StorageTimelineEvent[];
  total: number;
}

/** Search hit from a SearchProvider */
export interface SearchHit {
  id: string;
  score: number;
  highlights?: Record<string, string[]>;
}

/** One row that a bulk import could not write */
export interface BulkImportItemError {
  /** The row that failed, e.g. `entity:<id>` or `relationship:<id>` */
  item: string;
  /** Human-readable reason */
  error: string;
  /**
   * Code of the typed error the row failed with (e.g. `ENTITY_ALREADY_EXISTS`,
   * `SLUG_CONFLICT`), when the provider classified the failure.
   */
  code?: DeepMemoryErrorCode;
}

/**
 * Result of a bulk import operation.
 *
 * `errors` lists rows that failed on their own (a duplicate key, a value the
 * store rejects). A failure of the store itself — a timeout, a lost
 * connection — is not a row error: the import rejects with the typed error.
 * A provider whose import is a single transaction rolls back on any failed
 * row and rejects with an error naming that row.
 */
export interface BulkImportResult {
  entitiesImported: number;
  relationshipsImported: number;
  errors: BulkImportItemError[];
}

/** Result of a re-embedding operation */
export interface ReembedResult {
  processed: number;
  failed: number;
  errors: Array<{ entityId: string; error: string }>;
  modelId: string;
  dimensions: number;
}

// ─── Repository validation ──────────────────────────────────────

/** A single entity that failed vocabulary validation */
export interface EntityValidationIssue {
  entityId: string;
  slug: string;
  entityType: string;
  label: string;
  errors: ValidationError[];
}

/** A single relationship that failed vocabulary validation */
export interface RelationshipValidationIssue {
  relationshipId: string;
  relationshipType: string;
  sourceEntityId: string;
  targetEntityId: string;
  /** Label of the source entity if it exists (aids human/AI diagnosis) */
  sourceLabel?: string;
  /** Label of the target entity if it exists */
  targetLabel?: string;
  /** Type of the source entity if it exists (for context on type-mismatch errors) */
  sourceEntityType?: string;
  /** Type of the target entity if it exists */
  targetEntityType?: string;
  errors: ValidationError[];
}

/** One page of entity validation results from RepositoryValidator.validateEntities() */
export interface EntityValidationPage {
  issues: EntityValidationIssue[];
  /** Number of entities inspected in this call (for diagnostics; not bounded by take) */
  scanned: number;
  /** Issue-offset to pass on the next call; equal to the input offset + issues.length */
  nextOffset: number;
  /** True when the export stream ended before take was hit (no further issues beyond this page) */
  done: boolean;
}

/** One page of relationship validation results from RepositoryValidator.validateRelationships() */
export interface RelationshipValidationPage {
  issues: RelationshipValidationIssue[];
  /** Number of relationships inspected in this call (for diagnostics; not bounded by take) */
  scanned: number;
  /** Issue-offset to pass on the next call; equal to the input offset + issues.length */
  nextOffset: number;
  /** True when the export stream ended before take was hit (no further issues beyond this page) */
  done: boolean;
  /** Number of entities loaded into the resolution map (for diagnostics) */
  entitiesInMap: number;
}

export interface ValidateEntitiesOptions {
  /** Number of issues to skip before returning (not entities); default 0 */
  offset?: number;
  /** Maximum number of issues to return in this call; default 200 */
  take?: number;
  /** Milliseconds to pause between export chunks (for manual rate limiting); default 0 */
  delayBetweenChunksMs?: number;
}

export interface ValidateRelationshipsOptions {
  /** Number of issues to skip before returning (not relationships); default 0 */
  offset?: number;
  /** Maximum number of issues to return in this call; default 200 */
  take?: number;
  /** Milliseconds to pause between export chunks (for manual rate limiting); default 0 */
  delayBetweenChunksMs?: number;
}
