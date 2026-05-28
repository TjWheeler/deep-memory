// CypherCompiler — compiles TraversalSpec to Cypher query strings
// Zero runtime dependencies — pure string construction with parameterized bindings.

import type { TraversalSpec } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';
import type { PropertyFilter } from '../../types/queries.js';
import type { TraversalCompiler, CompiledQuery } from './TraversalCompiler.js';

const DEFAULT_ESTIMATED_FANOUT_PER_HOP = 10;

export class CypherCompiler implements TraversalCompiler {
  readonly language = 'cypher' as const;

  compile(spec: TraversalSpec, _vocabulary: MemoryVocabulary): CompiledQuery {
    const params: Record<string, unknown> = {};
    let paramIndex = 0;
    let estimatedFanOut = 1;
    const whereClauses: string[] = [];
    let nodeIndex = 0;

    const nextParam = (value: unknown): string => {
      const name = `p${paramIndex++}`;
      params[name] = value;
      return `$${name}`;
    };

    // ─── Start ──────────────────────────────────────────────────

    const startNode = `n${nodeIndex++}`;
    let matchParts: string[] = [];

    if (spec.start.entityId) {
      matchParts.push(`(${startNode})`);
      whereClauses.push(`${startNode}.id = ${nextParam(spec.start.entityId)}`);
    } else if (spec.start.entityType) {
      matchParts.push(`(${startNode})`);
      whereClauses.push(`${startNode}.entityType = ${nextParam(spec.start.entityType)}`);
      estimatedFanOut *= DEFAULT_ESTIMATED_FANOUT_PER_HOP;
    } else {
      matchParts.push(`(${startNode})`);
    }

    if (spec.start.filter) {
      for (const f of spec.start.filter) {
        whereClauses.push(compilePropertyFilterCypher(startNode, f, nextParam));
      }
    }

    // ─── Steps ──────────────────────────────────────────────────

    let lastNode = startNode;
    const steps = spec.steps ?? [];

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i]!;
      const targetNode = `n${nodeIndex++}`;
      const relAlias = `r${i}`;

      // Relationship type pattern
      const relTypes = step.relationshipTypes?.length
        ? step.relationshipTypes.join('|')
        : '';
      const relTypePattern = relTypes ? `:${relTypes}` : '';

      // Repeat — variable-length path
      const depthPattern = step.repeat
        ? `*1..${step.repeat.maxDepth}`
        : '';

      // Direction — only include the relationship and target node (left node is already in the chain)
      let pattern: string;
      switch (step.direction) {
        case 'out':
          pattern = `-[${relAlias}${relTypePattern}${depthPattern}]->(${targetNode})`;
          break;
        case 'in':
          pattern = `<-[${relAlias}${relTypePattern}${depthPattern}]-(${targetNode})`;
          break;
        case 'both':
          pattern = `-[${relAlias}${relTypePattern}${depthPattern}]-(${targetNode})`;
          break;
      }

      matchParts.push(pattern);
      estimatedFanOut *= step.repeat
        ? step.repeat.maxDepth * DEFAULT_ESTIMATED_FANOUT_PER_HOP
        : DEFAULT_ESTIMATED_FANOUT_PER_HOP;

      // Entity type filter
      if (step.entityTypes && step.entityTypes.length > 0) {
        const typeParam = nextParam(step.entityTypes);
        whereClauses.push(`${targetNode}.entityType IN ${typeParam}`);
      }

      // Entity property filters
      if (step.entityFilter) {
        for (const f of step.entityFilter) {
          whereClauses.push(compilePropertyFilterCypher(targetNode, f, nextParam));
        }
      }

      // Relationship property filters
      if (step.relationshipFilter) {
        for (const f of step.relationshipFilter) {
          whereClauses.push(compilePropertyFilterCypher(relAlias, f, nextParam));
        }
      }

      lastNode = targetNode;
    }

    // ─── Build query ────────────────────────────────────────────

    // Path mode binds the whole walk to `p` so the parser can recover ordered
    // intermediate nodes via `nodes(p)` / `relationships(p)`. Variable-length
    // patterns (`-[r*1..N]-`) compress every intermediate node into a single
    // hop alias, so without the path binding the round-trip would lose every
    // node between source and terminal — fatal for `findPaths`. Multi-alias
    // `RETURN n0, n1, …` works only for fully unrolled fixed-step chains.
    const bindPath = spec.returnMode === 'path';
    const pathBinding = bindPath ? 'p = ' : '';
    const matchClause = `MATCH ${pathBinding}${matchParts[0]}${matchParts.slice(1).join('')}`;
    const whereClause = whereClauses.length > 0
      ? `\nWHERE ${whereClauses.join(' AND ')}`
      : '';

    // Return clause
    let returnClause: string;
    // Server-side projection is only emitted for terminal-mode queries — the
    // anchor (lastNode) is unambiguous there. For 'all' / 'path' modes the
    // emission stays vertex/edge-oriented and projection is dropped silently
    // (the bug repro is terminal mode; multi-anchor projection over the
    // walked set is a separate concern).
    const emitProjection =
      spec.projection !== undefined && spec.returnMode !== 'path' && spec.returnMode !== 'all';

    if (emitProjection) {
      const projection = spec.projection!;
      const mode = projection.mode ?? 'values';
      const distinct = projection.distinct ?? false;

      // Each projected property becomes one column aliased to its own name so
      // the executor can rebuild { [prop]: value } maps positionally. Property
      // keys are validated against the same identifier rule used for filter
      // emission upstream (compilePropertyFilterCypher); user-supplied data
      // never reaches Cypher unparameterised.
      const projectionColumns = projection.properties.map((prop) => {
        assertSafeProjectionKey(prop);
        return `${lastNode}.${prop} AS ${prop}`;
      });

      if (mode === 'count') {
        returnClause = `RETURN ${projectionColumns.join(', ')}, count(*) AS count`;
      } else if (distinct) {
        returnClause = `RETURN DISTINCT ${projectionColumns.join(', ')}`;
      } else {
        returnClause = `RETURN ${projectionColumns.join(', ')}`;
      }
    } else if (spec.returnMode === 'path') {
      // Ordered node + relationship lists from the path binding. The parser
      // walks segments to recover per-edge walk direction.
      returnClause = 'RETURN nodes(p) AS pathNodes, relationships(p) AS pathRels, length(p) AS pathLength';
    } else if (spec.returnMode === 'all') {
      // Return every node AND every relationship from the step chain. The
      // sibling GremlinCompiler emits the same vertex+edge union shape (with a
      // synthetic `__kind` discriminator); the provider-side `executeTraversal`
      // depends on both backends agreeing on the discriminated-emission contract.
      // Cypher discriminates structurally — the driver returns typed Node /
      // Relationship objects per column, so no `__kind` field is needed.
      const allNodes = Array.from({ length: nodeIndex }, (_, i) => `n${i}`);
      const allRels = steps.map((_, i) => `r${i}`);
      const projection = [...allNodes, ...allRels].join(', ');
      returnClause = spec.dedup !== false
        ? `RETURN DISTINCT ${projection}`
        : `RETURN ${projection}`;
    } else {
      // Terminal — return only the last node
      returnClause = spec.dedup !== false
        ? `RETURN DISTINCT ${lastNode}`
        : `RETURN ${lastNode}`;
    }

    // Pagination
    const offset = spec.offset ?? 0;
    const limit = spec.limit ?? 50;
    const skipClause = offset > 0 ? `\nSKIP ${nextParam(offset)}` : '';
    const limitClause = `\nLIMIT ${nextParam(limit)}`;

    params['_limit'] = limit;
    params['_offset'] = offset;

    const query = `${matchClause}${whereClause}\n${returnClause}${skipClause}${limitClause}`;

    return {
      query,
      params,
      estimatedFanOut: Math.min(estimatedFanOut, 10000),
    };
  }
}

const SAFE_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Guard against Cypher injection through projection property names. Projection
 * keys are emitted inline (Cypher does not parameterise identifier positions),
 * so they must look like ordinary identifiers — letters, digits, underscores,
 * starting with a non-digit. The same rule is enforced upstream when a key
 * lands on the wire via the storage layer's safe-key validator.
 */
function assertSafeProjectionKey(key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(
      `Unsafe projection property name: "${key}". Property names must match ${SAFE_KEY_RE.source}.`,
    );
  }
}

/** Compile a single property filter to a Cypher WHERE clause fragment. */
function compilePropertyFilterCypher(
  nodeAlias: string,
  filter: PropertyFilter,
  nextParam: (value: unknown) => string,
): string {
  const prop = `${nodeAlias}.${filter.key}`;

  switch (filter.operator) {
    case 'eq':
      return `${prop} = ${nextParam(filter.value)}`;
    case 'neq':
      return `${prop} <> ${nextParam(filter.value)}`;
    case 'gt':
      return `${prop} > ${nextParam(filter.value)}`;
    case 'gte':
      return `${prop} >= ${nextParam(filter.value)}`;
    case 'lt':
      return `${prop} < ${nextParam(filter.value)}`;
    case 'lte':
      return `${prop} <= ${nextParam(filter.value)}`;
    case 'contains':
      return `${prop} CONTAINS ${nextParam(filter.value)}`;
    case 'isNull':
      return `${prop} IS NULL`;
    case 'isNotNull':
      return `${prop} IS NOT NULL`;
  }
}
