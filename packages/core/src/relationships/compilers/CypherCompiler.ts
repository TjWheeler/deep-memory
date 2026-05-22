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

    const matchClause = `MATCH ${matchParts[0]}${matchParts.slice(1).join('')}`;
    const whereClause = whereClauses.length > 0
      ? `\nWHERE ${whereClauses.join(' AND ')}`
      : '';

    // Return clause
    let returnClause: string;
    if (spec.returnMode === 'path') {
      // Return full paths
      const allNodes = Array.from({ length: nodeIndex }, (_, i) => `n${i}`);
      const allRels = steps.map((_, i) => `r${i}`);
      returnClause = `RETURN ${[...allNodes, ...allRels].join(', ')}`;
    } else if (spec.returnMode === 'all') {
      // Return all nodes
      const allNodes = Array.from({ length: nodeIndex }, (_, i) => `n${i}`);
      returnClause = spec.dedup !== false
        ? `RETURN DISTINCT ${allNodes.join(', ')}`
        : `RETURN ${allNodes.join(', ')}`;
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
