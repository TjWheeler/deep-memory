// Relationship types — edges in the memory graph

import type { Provenance } from './provenance.js';

/** Direction filter for relationship queries */
export type RelationshipDirection = 'outbound' | 'inbound' | 'both';

/** Public relationship representation */
export interface Relationship {
  id: string;
  relationshipType: string;
  sourceEntityId: string;
  targetEntityId: string;
  properties: Record<string, unknown>;
  bidirectional: boolean;
  provenance: Provenance;
}

/** Input for creating a new relationship */
export interface CreateRelationshipInput {
  /** Explicit GUID — auto-generated if omitted */
  id?: string;
  /** Must exist in the repository's vocabulary */
  relationshipType: string;
  /** Must match allowedSourceTypes (GUID or slug) */
  sourceEntityId: string;
  /** Must match allowedTargetTypes (GUID or slug) */
  targetEntityId: string;
  /** Must conform to the relationship type's property schema */
  properties?: Record<string, unknown>;
}

/** Internal stored representation */
export interface StoredRelationship {
  id: string;
  relationshipType: string;
  sourceEntityId: string;
  targetEntityId: string;
  properties: Record<string, unknown>;
  bidirectional: boolean;
  provenance: Provenance;
}

/** Relationship with human-readable source/target info */
export interface EnrichedRelationship {
  id: string;
  relationshipType: string;
  sourceEntityId: string;
  sourceSlug: string;
  sourceLabel: string;
  targetEntityId: string;
  targetSlug: string;
  targetLabel: string;
  properties: Record<string, unknown>;
  bidirectional: boolean;
  provenance: Provenance;
}

/** Aggregated relationship counts by type and direction */
export interface RelationshipSummary {
  outbound: Record<string, number>;
  inbound: Record<string, number>;
}

/** Result of a bulk relationship removal */
export interface RemoveRelationshipsResult {
  removed: string[];
  failed: Array<{ id: string; error: string }>;
}

/** Options for querying relationships of an entity */
export interface RelationshipQueryOptions {
  /** Filter by relationship type(s) */
  relationshipTypes?: string[];
  /** Filter by direction relative to the entity */
  direction?: RelationshipDirection;
  /** Maximum number of results */
  limit?: number;
  /** Pagination offset */
  offset?: number;
  /** Filter by relationship property values (all filters are AND'd) */
  propertyFilters?: import('./queries.js').PropertyFilter[];
}
