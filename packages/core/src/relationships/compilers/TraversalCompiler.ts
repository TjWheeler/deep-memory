// TraversalCompiler — interface for compiling TraversalSpec to native queries

import type { TraversalSpec } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';

export interface TraversalCompiler {
  /** The query language this compiler targets. */
  readonly language: 'gremlin' | 'cypher' | 'sql';

  /** Compile a validated TraversalSpec into a native query string. */
  compile(spec: TraversalSpec, vocabulary: MemoryVocabulary): CompiledQuery;
}

export interface CompiledQuery {
  /** The native query string. */
  query: string;

  /** Parameter bindings (for parameterized queries). */
  params: Record<string, unknown>;

  /** Estimated cost heuristic (fan-out estimation). Provider may override. */
  estimatedFanOut: number;
}
