// Entity types — nodes in the memory graph

import type { Provenance } from './provenance.js';

/** Detail level for entity retrieval */
export type DetailLevel = 'brief' | 'summary' | 'full';

/** Full entity representation (returned at "full" detail level) */
export interface Entity {
  id: string;
  slug: string;
  entityType: string;
  label: string;
  summary?: string;
  properties: Record<string, unknown>;
  /** Raw content/data of the entity — only at "full" detail level */
  data?: string;
  /** Format of the data field, e.g., "text/plain", "text/markdown" */
  dataFormat?: string;
  provenance: Provenance;
}

/** Entity at "summary" detail level — properties but no raw data */
export interface EntitySummary {
  id: string;
  slug: string;
  entityType: string;
  label: string;
  summary?: string;
  properties: Record<string, unknown>;
}

/** Entity at "brief" detail level — minimal info for lists */
export interface EntityBrief {
  id: string;
  slug: string;
  entityType: string;
  label: string;
  summary?: string;
}

/** Input for creating a new entity */
export interface CreateEntityInput {
  /** Explicit GUID — auto-generated if omitted */
  id?: string;
  /** Must exist in the repository's vocabulary */
  entityType: string;
  label: string;
  summary?: string;
  /** Must conform to the vocabulary's property schema */
  properties?: Record<string, unknown>;
  /** Raw content/data */
  data?: string;
  /** Format of the data field */
  dataFormat?: string;
}

/** Input for updating an existing entity */
export interface UpdateEntityInput {
  /**
   * Change the entity's type. Must exist in the vocabulary. The slug is
   * regenerated with the new type prefix, and any provided `properties` are
   * validated against the new type's schema.
   */
  entityType?: string;
  label?: string;
  /** `undefined` preserves the existing value; `null` clears it. */
  summary?: string | null;
  /**
   * Merged with existing properties. A property value of `null` deletes that
   * key from the entity's properties (RFC 7396 JSON Merge Patch semantics).
   */
  properties?: Record<string, unknown>;
  /** `undefined` preserves the existing value; `null` clears it. */
  data?: string | null;
  /** `undefined` preserves the existing value; `null` clears it. */
  dataFormat?: string | null;
  /** Force regeneration of the embedding vector (e.g. after switching embedding models) */
  reembed?: boolean;
}

/** Internal stored representation — includes provenance and embeddings */
export interface StoredEntity {
  id: string;
  slug: string;
  entityType: string;
  label: string;
  summary?: string;
  properties: Record<string, unknown>;
  data?: string;
  dataFormat?: string;
  provenance: Provenance;
  /** Vector embedding of the entity (label + summary + embeddable string properties) */
  embedding?: number[];
}

/**
 * Internal update representation for the storage provider.
 *
 * For optional string fields (`summary`, `data`, `dataFormat`), the tri-state
 * applies: `undefined` preserves the existing value, `null` clears it, and a
 * string sets the new value. For `properties`, storage receives the fully
 * merged map that the caller wants persisted — key deletions are already
 * applied upstream, so storage can replace the stored map wholesale.
 */
export interface StoredEntityUpdate {
  entityType?: string;
  label?: string;
  slug?: string;
  summary?: string | null;
  properties?: Record<string, unknown>;
  data?: string | null;
  dataFormat?: string | null;
  provenance: Provenance;
  embedding?: number[];
}

/** Options for getEntity */
export interface GetEntityOptions {
  detailLevel?: DetailLevel;
}

/** Options for getEntities (batch) */
export interface GetEntitiesOptions {
  /** Only "brief" or "summary" for batch retrieval */
  detailLevel?: 'brief' | 'summary';
}

/** Result of a bulk entity deletion */
export interface DeleteEntitiesResult {
  deleted: string[];
  failed: Array<{ id: string; error: string }>;
}
