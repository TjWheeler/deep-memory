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

    // ─── Steps ──────────────────────────────────────────────────

    const steps = spec.steps ?? [];
    for (const step of steps) {
      if (step.repeat) {
        parts.push(compileRepeatStep(step, nextParam));
        estimatedFanOut *= step.repeat.maxDepth * DEFAULT_ESTIMATED_FANOUT_PER_HOP;
      } else if (step.relationshipFilter && step.relationshipFilter.length > 0) {
        // Edge-explicit traversal for relationship property filters
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

    // ─── Return mode modifiers ──────────────────────────────────

    if (spec.returnMode === 'all') {
      // emit() at each step is handled within repeat; for non-repeat this is implicit
    }

    if (spec.dedup !== false) {
      parts.push('.dedup()');
    }

    // ─── Pagination ─────────────────────────────────────────────

    const limit = spec.limit ?? 50;
    const offset = spec.offset ?? 0;
    const pOffset = nextParam(offset);
    const pEnd = nextParam(offset + limit);
    parts.push(`.range(${pOffset}, ${pEnd})`);

    params['_limit'] = limit;
    params['_offset'] = offset;

    // ─── Path mode ──────────────────────────────────────────────

    if (spec.returnMode === 'path') {
      parts.push('.path()');
    }

    // ─── Value projection ───────────────────────────────────────

    if (spec.returnMode !== 'path') {
      parts.push('.valueMap(true)');
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

/** Compile an edge-explicit step for relationship property filtering. */
function compileEdgeStep(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
): string {
  const parts: string[] = [];
  const types = step.relationshipTypes;
  const typeArgs = types ? types.map((t) => nextParam(t)).join(', ') : '';

  // Edge traversal
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

  // Relationship property filters on the edge
  if (step.relationshipFilter) {
    for (const f of step.relationshipFilter) {
      parts.push(compilePropertyFilter(f, nextParam));
    }
  }

  // Traverse to the target vertex
  switch (step.direction) {
    case 'out':
      parts.push('.inV()');
      break;
    case 'in':
      parts.push('.outV()');
      break;
    case 'both':
      parts.push('.otherV()');
      break;
  }

  return parts.join('');
}

/** Compile a repeat/loop step. */
function compileRepeatStep(
  step: TraversalStep,
  nextParam: (value: unknown) => string,
): string {
  const parts: string[] = [];
  const innerStep = step.relationshipFilter?.length
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
