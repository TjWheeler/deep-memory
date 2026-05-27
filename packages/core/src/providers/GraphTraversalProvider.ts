// GraphTraversalProvider — optional provider for native graph traversal
//
// When registered, enables multi-hop traversal queries and native graph
// query pass-through. When absent, the library falls back to application-level
// BFS over StorageProvider for structured traversals.

import type { TraversalSpec, TraversalResult } from '../types/traversal.js';

/**
 * Optional provider for native graph traversal.
 * When registered, enables multi-hop traversal queries and native graph
 * query pass-through. When absent, the library falls back to application-level
 * BFS over StorageProvider for structured traversals.
 */
export interface GraphTraversalProvider {
  /**
   * Execute a structured traversal described by a TraversalSpec.
   * The provider owns compilation to its native dialect — the core
   * never hands down a pre-compiled query string.
   */
  traverse(
    repositoryId: string,
    spec: TraversalSpec,
  ): Promise<TraversalResult>;

  /**
   * Execute a native graph query (Gremlin, Cypher, etc.).
   *
   * ⚠️  ELEVATED PRIVILEGE — SYSTEM-LEVEL OPERATION ⚠️
   *
   * This is an unscoped pass-through. The library does not rewrite the query,
   * does not inject partition or repository scoping, and performs no
   * validation on the query string or bindings. A single call may reach any
   * data the underlying store exposes to the connection — across partitions,
   * repositories, or tenants.
   *
   * DO NOT expose this method to AI agents, end users, or any untrusted
   * caller. It is intended for administrative tooling, migrations,
   * diagnostics, and trusted internal operations only.
   *
   * For agent-facing graph queries use {@link traverse}, which takes a
   * structured TraversalSpec and lets the provider enforce repository scoping.
   */
  executeNativeQuery(
    repositoryId: string,
    query: string,
    params?: Record<string, unknown>,
  ): Promise<unknown[]>;

  /**
   * Report provider capabilities so the library can adapt
   * DSL compilation and validate traversal specs accordingly.
   */
  getCapabilities(): GraphTraversalCapabilities;

  /** Optional lifecycle hooks, matching StorageProvider pattern. */
  initialize?(): Promise<void>;
  dispose?(): Promise<void>;
}

export interface GraphTraversalCapabilities {
  /** Whether executeNativeQuery() is implemented. */
  supportsNativeQuery: boolean;

  /** The native query language, for DSL compilation targeting. */
  nativeQueryLanguage: 'gremlin' | 'cypher' | 'sql' | 'other';

  /** Maximum traversal depth the provider supports. */
  maxTraversalDepth: number;

  /** Whether the provider supports property filters on relationships during traversal. */
  supportsRelationshipPropertyFilters: boolean;

  /** Whether the provider supports property filters on entities during traversal. */
  supportsEntityPropertyFilters: boolean;

  /** Whether the provider supports aggregation (count, sum, avg) on terminal results. */
  supportsAggregation: boolean;

  /** Whether the provider supports repeat/loop traversal steps. */
  supportsRepeat: boolean;

  /** Whether the provider supports dedup across traversal results. */
  supportsDedup: boolean;

  /**
   * Whether the provider can return relationship summaries (out/in
   * counts by type) natively in a single traversal query.
   * When false, the library falls back to a batch fetch + local computation.
   */
  supportsRelationshipSummary: boolean;
}
