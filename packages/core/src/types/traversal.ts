// Traversal types — structured DSL for graph queries and multi-hop traversal

import type { Entity, EntityBrief, EntitySummary, DetailLevel } from './entities.js';
import type { PropertyFilter } from './queries.js';
import type { RelationshipSummary } from './relationships.js';

/**
 * An entity as returned inside a TraversalResult — the projected entity plus
 * an optional relationship summary when includeRelationshipSummary is set.
 */
export type TraversalEntity = (Entity | EntitySummary | EntityBrief) & {
  relationshipSummary?: RelationshipSummary;
};

/**
 * A structured graph query specification that can be compiled to
 * Gremlin, Cypher, or executed via application-level BFS.
 *
 * Designed to be expressible by AI agents without raw query
 * language knowledge. Covers both vertex-only queries (property
 * aggregation, distinct values, filtered lookups) and multi-hop
 * relationship traversals.
 *
 * When steps is empty or omitted, the query operates on the
 * starting entities directly — no relationship hops needed.
 */
export interface TraversalSpec {
  /** Starting point — which entities to query or start traversing from. */
  start: TraversalStart;

  /**
   * Ordered sequence of traversal steps (relationship hops).
   * When empty or omitted, the query operates on the starting entities
   * directly — useful for property aggregation, distinct value queries,
   * and filtered entity lookups without relationship hops.
   */
  steps?: TraversalStep[];

  /** What to return from the query. */
  returnMode: TraversalReturnMode;

  /**
   * Property projection — extract and aggregate property values from
   * result entities. When present, returns projected values in the
   * `aggregations` array. By default, the `entities` array is suppressed
   * (projection replaces full entity output). Set `includeEntities: true`
   * to return both.
   *
   * Works with both vertex-only queries and traversals.
   */
  projection?: TraversalProjection;

  /**
   * Maximum number of results to return.
   * Default: 50. Max: 200.
   * Applied to the final result set after traversal.
   */
  limit?: number;

  /**
   * Pagination offset for the final result set.
   * Default: 0.
   */
  offset?: number;

  /** Detail level for returned entities. Default: 'summary'. */
  detailLevel?: DetailLevel;

  /** Whether to deduplicate entities in the result set. Default: true. */
  dedup?: boolean;

  /**
   * Whether to include a relationship summary (outbound/inbound counts by type)
   * on each entity in the result. Default: false.
   *
   * Native GraphTraversalProviders (Gremlin, Cypher) can return this in a single
   * query. The fallback executor fetches all relationship data in one batch call
   * and computes summaries locally. Check GraphTraversalCapabilities.supportsRelationshipSummary
   * to know whether the active provider handles this natively.
   */
  includeRelationshipSummary?: boolean;

  /**
   * Whether to include provenance data on entities. Default: false.
   * Only has effect when detailLevel is 'full'.
   */
  includeProvenance?: boolean;
}

/**
 * Property projection — extract and optionally aggregate property values
 * from result entities. Like SQL SELECT or Gremlin valueMap(), projection
 * returns the projected values, not the full objects.
 *
 * By default, when projection is present the entities array is suppressed
 * (only aggregations are returned). Set includeEntities to also get the
 * full entity objects back.
 */
export interface TraversalProjection {
  /**
   * Property names to extract from result entities.
   */
  properties: string[];

  /**
   * Return only distinct combinations of the projected properties.
   * Default: false.
   */
  distinct?: boolean;

  /**
   * Aggregation mode for the projected properties.
   * - 'values': return the raw property values (default)
   * - 'count': count entities per distinct value combination
   */
  mode?: 'count' | 'values';

  /**
   * When true, also return the full entities array alongside the
   * projected aggregations. By default, projection suppresses entities
   * to keep responses lightweight.
   * Default: false.
   */
  includeEntities?: boolean;
}

/** Where the traversal begins. */
export interface TraversalStart {
  /** Start from a specific entity by ID (GUID) or slug. */
  entityId?: string;

  /** Start from all entities of a given type. Requires limit on the spec. */
  entityType?: string;

  /** Filter starting entities by property values. */
  filter?: PropertyFilter[];
}

/**
 * A single step in the traversal — one hop along a relationship edge.
 */
export interface TraversalStep {
  /** Direction to traverse. */
  direction: 'out' | 'in' | 'both';

  /**
   * Relationship types to follow in this step.
   * Validated against the repository vocabulary.
   * If omitted, follows all relationship types.
   */
  relationshipTypes?: string[];

  /**
   * Filter target entities by type.
   * If omitted, accepts all entity types.
   */
  entityTypes?: string[];

  /** Filter relationships by property values during traversal. */
  relationshipFilter?: PropertyFilter[];

  /** Filter target entities by property values during traversal. */
  entityFilter?: PropertyFilter[];

  /**
   * Repeat this step up to maxDepth times.
   * Useful for variable-depth traversals like "find all sub-components
   * at any depth" via repeated CONTAINS hops.
   *
   * When present, this step becomes a loop. The step's direction,
   * relationshipTypes, and filters apply to each iteration.
   */
  repeat?: {
    /**
     * Maximum number of times to repeat this step.
     * Mandatory — no unbounded recursion.
     * Capped by provider's maxTraversalDepth.
     */
    maxDepth: number;

    /**
     * Stop condition: stop expanding a path when the current entity
     * matches these filters. The matching entity IS included in results.
     */
    until?: PropertyFilter[];

    /** Whether to include intermediate entities or only terminal ones. Default: true. */
    emitIntermediates?: boolean;
  };
}

/** What the traversal returns. */
export type TraversalReturnMode =
  /** Return only entities at the final step (most common). */
  | 'terminal'
  /** Return full paths (all entities and relationships from start to end). */
  | 'path'
  /** Return all entities encountered during traversal (every step). */
  | 'all';

/**
 * Result of a graph traversal, including query metadata for
 * implementers to use in audit, billing, and circuit breaker logic.
 */
export interface TraversalResult {
  /** Entities in the result set, projected to the requested detail level. */
  entities: TraversalEntity[];

  /**
   * Relationships in the result set.
   * Present when returnMode is 'path' or 'all'.
   */
  relationships?: TraversalRelationship[];

  /**
   * Full paths from start to terminal entities.
   * Present only when returnMode is 'path'.
   */
  paths?: TraversalPath[];

  /**
   * Aggregated property values.
   * Present when select is specified in the query.
   * Each entry is a distinct value combination with an optional count.
   */
  aggregations?: TraversalAggregation[];

  /**
   * Total number of results matching the traversal (before limit/offset).
   *
   * For `'all'` mode, the response is an interleaved union of entities AND
   * relationships, and `total` counts both arrays' page-size combined
   * (`entities.length + relationships.length`). Use `hasMore` to determine
   * whether further pages exist.
   */
  total: number;

  /** Number of results returned in this response. */
  returned: number;

  /** Whether more results exist beyond offset + limit. */
  hasMore: boolean;

  /** Query execution metadata. */
  queryMetadata: QueryMetadata;
}

/** A single aggregation row — a distinct property value combination with optional count. */
export interface TraversalAggregation {
  /** Property values for this combination. */
  values: Record<string, unknown>;
  /** Number of entities with this value combination. Present when mode is 'count'. */
  count?: number;
}

export interface TraversalRelationship {
  id: string;
  type: string;
  sourceEntityId: string;
  targetEntityId: string;
  /**
   * Walk direction at the last hop, with mode-specific semantics:
   *
   * - **`'path'` mode** — `'outbound'` when the walk crossed the edge from
   *   `sourceEntityId` to `targetEntityId`, `'inbound'` when it crossed in
   *   the opposite direction. Computed relative to the entity at the
   *   start of the hop within each `TraversalPath`.
   * - **`'all'` mode** — always `'outbound'`. Reflects the stored edge
   *   topology (`sourceEntityId` → `targetEntityId`), not any particular
   *   walk; the deduped union has no walk context. Callers can derive
   *   walk-direction relative to any anchor using `sourceEntityId` /
   *   `targetEntityId`.
   * - **`'terminal'` mode** — relationships are not returned.
   */
  direction: 'outbound' | 'inbound';
  properties: Record<string, unknown>;
}

export interface TraversalPath {
  /** Number of hops in this path. */
  length: number;

  /** Ordered sequence of entities from start to end. */
  entities: TraversalEntity[];

  /** Ordered sequence of relationships connecting the entities. */
  relationships: TraversalRelationship[];
}

/**
 * Metadata about query execution.
 * Providers populate this from database response headers/metrics.
 * Implementers use this for audit, billing, and circuit breaker logic.
 */
export interface QueryMetadata {
  /** Wall-clock execution time in milliseconds. */
  executionTimeMs: number;

  /**
   * Provider-specific resource cost.
   * CosmosDB: { units: 'RU', value: 42.3 }
   * Neo4j: { units: 'db_hits', value: 1250 }
   * SQL Server: { units: 'logical_reads', value: 340 }
   */
  resourceCost?: {
    units: string;
    value: number;
  };

  /**
   * The native query that was actually executed.
   * Useful for debugging DSL compilation and for implementers
   * building query audit logs.
   * Only populated when the traversal was compiled from a spec.
   */
  compiledQuery?: string;

  /** The native query language of the compiled query. */
  compiledQueryLanguage?: 'gremlin' | 'cypher' | 'sql';

  /** Limits that were applied during execution. */
  appliedLimits: {
    timeoutMs?: number;
    maxResults: number;
    maxDepth?: number;
  };

  /** Whether the result was truncated by any limit. */
  truncated: boolean;

  /** Reason for truncation, if truncated. */
  truncationReason?: 'result_limit' | 'timeout' | 'cost_limit' | 'depth_limit';
}
