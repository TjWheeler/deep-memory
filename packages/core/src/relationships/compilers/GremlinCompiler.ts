// GremlinCompiler — compiles TraversalSpec to Gremlin query strings
// Zero runtime dependencies — pure string construction with parameterized bindings.

import type { TraversalSpec, TraversalStep } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';
import type { PropertyFilter } from '../../types/queries.js';
import type { TraversalCompiler, CompiledQuery } from './TraversalCompiler.js';

const DEFAULT_ESTIMATED_FANOUT_PER_HOP = 10;

export class GremlinCompiler implements TraversalCompiler {
  readonly language = 'gremlin' as const;

  compile(spec: TraversalSpec, _vocabulary: MemoryVocabulary): CompiledQuery {
    const parts: string[] = [];
    const params: Record<string, unknown> = {};
    let paramIndex = 0;
    let estimatedFanOut = 1;

    const nextParam = (value: unknown): string => {
      const name = `p${paramIndex++}`;
      params[name] = value;
      return name;
    };

    // ─── Start ──────────────────────────────────────────────────

    parts.push('g.V()');

    if (spec.start.entityId) {
      const p = nextParam(spec.start.entityId);
      parts.push(`.has('id', ${p})`);
    } else if (spec.start.entityType) {
      const p = nextParam(spec.start.entityType);
      parts.push(`.has('entityType', ${p})`);
      estimatedFanOut *= DEFAULT_ESTIMATED_FANOUT_PER_HOP;
    }

    if (spec.start.filter) {
      for (const f of spec.start.filter) {
        parts.push(compilePropertyFilter(f, nextParam));
      }
    }

    // ─── Mode-specific emission ─────────────────────────────────

    const steps = spec.steps ?? [];
    const returnMode = spec.returnMode ?? 'terminal';

    if (returnMode === 'all') {
      // Server-side union of every depth's edges and vertices, then dedup.
      // Each unique element is serialised once regardless of how many walks
      // visit it — large RU saving vs path()+client-dedup at depth ≥ 2.
      // See plan §3 (revised) for the construction.
      if (steps.some((s) => s.repeat)) {
        throw new Error(
          "GremlinCompiler: 'all' returnMode does not support repeat steps. Use 'terminal' or 'path' mode, or unroll the repeat into explicit steps.",
        );
      }

      // Pre-compile each step's edge and vertex strings ONCE so params are
      // allocated once and shared across the branches that reference them.
      const compiledSteps = steps.map((step) => ({
        edge: compileEdgeOnly(step, nextParam),
        vertex: compileVertexHop(step),
        // Per plan §3: entity-type/property filters apply only on branches
        // ending at that depth's vertex. They are NOT included in the prefix
        // that deeper branches traverse through.
        entityFilters: compileEntityFilters(step, nextParam),
      }));

      // Branches inside .union(...) are anonymous traversals — each must be
      // rooted with `__` (TinkerPop's anonymous-traversal helper), not a
      // leading-dot chain off the receiver. Same convention used by
      // compileRepeatStep for .repeat() arguments.
      const branches: string[] = ['__.identity()'];
      let prefix = '';
      for (const { edge, vertex, entityFilters } of compiledSteps) {
        // Edge at depth i
        branches.push(`__${prefix}${edge}`);
        // Vertex at depth i, with this depth's entity filters applied
        branches.push(`__${prefix}${edge}${vertex}${entityFilters}`);
        // Deeper branches walk through the unfiltered vertex hop
        prefix = `${prefix}${edge}${vertex}`;
        estimatedFanOut *= DEFAULT_ESTIMATED_FANOUT_PER_HOP;
      }

      parts.push(`.union(${branches.join(', ')})`);

      // 'all' is inherently deduped by id — spec.dedup is ignored.
      parts.push('.dedup()');

      // ─── Pagination ───────────────────────────────────────────
      const limit = spec.limit ?? 50;
      const offset = spec.offset ?? 0;
      const pOffset = nextParam(offset);
      const pEnd = nextParam(offset + limit);
      parts.push(`.range(${pOffset}, ${pEnd})`);
      params['_limit'] = limit;
      params['_offset'] = offset;

      // Flat stream of vertex/edge property maps; provider splits by marker.
      parts.push('.valueMap(true)');
    } else {
      // 'terminal' and 'path' share the step-loop emission, but differ in
      // whether they use edge-explicit emission and in their projection.
      const useEdgeEmission = returnMode === 'path';

      for (const step of steps) {
        if (step.repeat) {
          parts.push(compileRepeatStep(step, nextParam, useEdgeEmission));
          estimatedFanOut *= step.repeat.maxDepth * DEFAULT_ESTIMATED_FANOUT_PER_HOP;
        } else if (useEdgeEmission || (step.relationshipFilter && step.relationshipFilter.length > 0)) {
          // Edge-explicit traversal — required for path-walking, or for relationship property filters
          parts.push(compileEdgeStep(step, nextParam));
          estimatedFanOut *= DEFAULT_ESTIMATED_FANOUT_PER_HOP;
        } else {
          parts.push(compileSimpleStep(step, nextParam));
          estimatedFanOut *= DEFAULT_ESTIMATED_FANOUT_PER_HOP;
        }

        // Entity type filter on target vertices
        if (step.entityTypes && step.entityTypes.length > 0) {
          const typeParams = step.entityTypes.map((t) => nextParam(t));
          parts.push(`.has('entityType', within(${typeParams.join(', ')}))`);
        }

        // Entity property filters on target vertices
        if (step.entityFilter) {
          for (const f of step.entityFilter) {
            parts.push(compilePropertyFilter(f, nextParam));
          }
        }
      }

      // Dedup: 'terminal' honours spec.dedup. 'path' never dedups — paths are
      // distinct walks by definition; collapsing them by terminal id throws
      // away the answer.
      if (returnMode === 'terminal' && spec.dedup !== false) {
        parts.push('.dedup()');
      }

      // ─── Pagination ───────────────────────────────────────────
      const limit = spec.limit ?? 50;
      const offset = spec.offset ?? 0;
      const pOffset = nextParam(offset);
      const pEnd = nextParam(offset + limit);
      parts.push(`.range(${pOffset}, ${pEnd})`);
      params['_limit'] = limit;
      params['_offset'] = offset;

      // 'terminal': flat valueMap rows.
      // 'path': path objects with every vertex AND edge projected as a
      // valueMap so the provider can split objects[] into entities/relationships.
      if (returnMode === 'terminal') {
        parts.push('.valueMap(true)');
      } else {
        parts.push('.path().by(valueMap(true))');
      }
    }

    return {
      query: parts.join(''),
      params,
      estimatedFanOut: Math.min(estimatedFanOut, 10000),
    };
  }
}

/** Compile a simple vertex-to-vertex step (no relationship property filters). */
function compileSimpleStep(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
): string {
  const types = step.relationshipTypes;
  const typeArgs = types ? types.map((t) => nextParam(t)).join(', ') : '';

  switch (step.direction) {
    case 'out':
      return types ? `.out(${typeArgs})` : '.out()';
    case 'in':
      return types ? `.in(${typeArgs})` : '.in()';
    case 'both':
      return types ? `.both(${typeArgs})` : '.both()';
  }
}

/** Compile the edge portion of an edge-explicit step (no vertex hop). */
function compileEdgeOnly(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
): string {
  const parts: string[] = [];
  const types = step.relationshipTypes;
  const typeArgs = types ? types.map((t) => nextParam(t)).join(', ') : '';

  switch (step.direction) {
    case 'out':
      parts.push(types ? `.outE(${typeArgs})` : '.outE()');
      break;
    case 'in':
      parts.push(types ? `.inE(${typeArgs})` : '.inE()');
      break;
    case 'both':
      parts.push(types ? `.bothE(${typeArgs})` : '.bothE()');
      break;
  }

  if (step.relationshipFilter) {
    for (const f of step.relationshipFilter) {
      parts.push(compilePropertyFilter(f, nextParam));
    }
  }

  return parts.join('');
}

/** Compile the vertex-hop portion of an edge-explicit step. */
function compileVertexHop(step: TraversalStep): string {
  switch (step.direction) {
    case 'out':
      return '.inV()';
    case 'in':
      return '.outV()';
    case 'both':
      return '.otherV()';
  }
}

/** Compile entity-type and entity-property filters that apply to a target vertex. */
function compileEntityFilters(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
): string {
  const parts: string[] = [];

  if (step.entityTypes && step.entityTypes.length > 0) {
    const typeParams = step.entityTypes.map((t) => nextParam(t));
    parts.push(`.has('entityType', within(${typeParams.join(', ')}))`);
  }

  if (step.entityFilter) {
    for (const f of step.entityFilter) {
      parts.push(compilePropertyFilter(f, nextParam));
    }
  }

  return parts.join('');
}

/** Compile an edge-explicit step for relationship property filtering. */
function compileEdgeStep(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
): string {
  return compileEdgeOnly(step, nextParam) + compileVertexHop(step);
}

/** Compile a repeat/loop step. */
function compileRepeatStep(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
  useEdgeEmission: boolean,
): string {
  const parts: string[] = [];
  const innerStep = (useEdgeEmission || step.relationshipFilter?.length)
    ? compileEdgeStep({ ...step, repeat: undefined }, nextParam)
    : compileSimpleStep(step, nextParam);

  // emit() placement: before repeat for intermediates, after for terminal-only
  if (step.repeat?.emitIntermediates !== false) {
    parts.push('.emit()');
  }

  parts.push(`.repeat(${innerStep.startsWith('.') ? `__${innerStep}` : innerStep})`);

  // Until condition
  if (step.repeat?.until && step.repeat.until.length > 0) {
    const untilParts = step.repeat.until.map((f) => compilePropertyFilter(f, nextParam));
    parts.push(`.until(${untilParts.join('')})`);
  }

  // Max depth via times()
  if (step.repeat?.maxDepth) {
    const p = nextParam(step.repeat.maxDepth);
    parts.push(`.times(${p})`);
  }

  if (step.repeat?.emitIntermediates === false) {
    parts.push('.emit()');
  }

  return parts.join('');
}

/** Compile a single property filter to a Gremlin .has() predicate. */
function compilePropertyFilter(
  filter: PropertyFilter,
  nextParam: (value: unknown) => string,
): string {
  const key = nextParam(filter.key);

  switch (filter.operator) {
    case 'eq': {
      const val = nextParam(filter.value);
      return `.has(${key}, ${val})`;
    }
    case 'neq': {
      const val = nextParam(filter.value);
      return `.has(${key}, neq(${val}))`;
    }
    case 'gt': {
      const val = nextParam(filter.value);
      return `.has(${key}, gt(${val}))`;
    }
    case 'gte': {
      const val = nextParam(filter.value);
      return `.has(${key}, gte(${val}))`;
    }
    case 'lt': {
      const val = nextParam(filter.value);
      return `.has(${key}, lt(${val}))`;
    }
    case 'lte': {
      const val = nextParam(filter.value);
      return `.has(${key}, lte(${val}))`;
    }
    case 'contains': {
      const val = nextParam(filter.value);
      return `.has(${key}, containing(${val}))`;
    }
    case 'isNull':
      return `.hasNot(${key})`;
    case 'isNotNull':
      return `.has(${key})`;
  }
}
