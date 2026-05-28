// GremlinCompiler — compiles TraversalSpec to Gremlin query strings
// Zero runtime dependencies — pure string construction with parameterized bindings.

import type { TraversalProjection, TraversalSpec, TraversalStep } from '../../types/traversal.js';
import type { MemoryVocabulary } from '../../types/vocabulary.js';
import type { PropertyFilter } from '../../types/queries.js';
import type { TraversalCompiler, CompiledQuery } from './TraversalCompiler.js';

const DEFAULT_ESTIMATED_FANOUT_PER_HOP = 10;

// ─── Read-path projections ────────────────────────────────────────
//
// Goal: stop wire-shipping `embedding` (and any other unused properties) on
// every traversal. We emit explicit project chains listing only the keys the
// storage-cosmosdb mappers consume.
//
// CosmosDB Gremlin shape constraints (live-validated 2026-05-25 against the
// emulator):
//
//   1. A single `.path().by(project(...))` across mixed vertex+edge objects
//      crashes when an edge lacks a vertex-only key. The working form is two
//      `.by(...)` modulators in round-robin: by-1 applies to vertices in path
//      order, by-2 to edges.
//   2. `dedup().by('id')` on a stream of projected Maps fails because the
//      property-name string doesn't resolve on a Map. Use
//      `dedup().by(select('id'))` to pluck the id key off the projected Map.
//   3. Bare `.by('field')` for properties that may be absent on a given
//      vertex crashes that row. Wrap optional fields with
//      `coalesce(values('field'), constant(default))`.
//   4. `.by(id)` (the Gremlin token, not the string 'id') is the way to
//      extract the system id. `.by('id')` is a property-name lookup and
//      slower / behaves differently.
//   5. `__kind` is a synthetic discriminator field projected as
//      `.by(constant('v'))` / `.by(constant('e'))`. The CosmosDB parser
//      uses it to split union-output rows into entities vs relationships
//      (clearer than checking entityType vs relationshipType on every row).
//
// Each entry below is `[fieldName, byEmission]`. The field-name list
// (excluding the synthetic '__kind') is exported as
// GREMLIN_VERTEX_PROJECTION_FIELDS / GREMLIN_EDGE_PROJECTION_FIELDS for the
// cross-package sync test in @utaba/deep-memory-storage-cosmosdb. Keep this
// list in sync with STORED_ENTITY_FIELDS / STORED_RELATIONSHIP_FIELDS in
// `packages/storage-cosmosdb/src/mapping.ts` — the sync test fails on drift.

type ProjectionEntry = readonly [field: string, by: string];

const VERTEX_PROJECTION: ReadonlyArray<ProjectionEntry> = [
  ['__kind', `.by(constant('v'))`],
  ['id', `.by(id)`],
  ['entityType', `.by('entityType')`],
  ['entityLabel', `.by('entityLabel')`],
  ['slug', `.by('slug')`],
  ['summary', `.by(coalesce(values('summary'), constant('')))`],
  ['properties', `.by(coalesce(values('properties'), constant('{}')))`],
  ['data', `.by(coalesce(values('data'), constant('')))`],
  ['dataFormat', `.by(coalesce(values('dataFormat'), constant('')))`],
  ['createdBy', `.by('createdBy')`],
  ['createdByType', `.by('createdByType')`],
  ['createdAt', `.by('createdAt')`],
  ['createdInConversation', `.by(coalesce(values('createdInConversation'), constant('')))`],
  ['createdFromMessage', `.by(coalesce(values('createdFromMessage'), constant('')))`],
  ['modifiedBy', `.by('modifiedBy')`],
  ['modifiedByType', `.by('modifiedByType')`],
  ['modifiedAt', `.by('modifiedAt')`],
  ['modifiedInConversation', `.by(coalesce(values('modifiedInConversation'), constant('')))`],
  ['modifiedFromMessage', `.by(coalesce(values('modifiedFromMessage'), constant('')))`],
];

const EDGE_PROJECTION: ReadonlyArray<ProjectionEntry> = [
  ['__kind', `.by(constant('e'))`],
  ['id', `.by(id)`],
  ['relationshipType', `.by('relationshipType')`],
  ['sourceEntityId', `.by('sourceEntityId')`],
  ['targetEntityId', `.by('targetEntityId')`],
  ['properties', `.by(coalesce(values('properties'), constant('{}')))`],
  ['bidirectional', `.by(coalesce(values('bidirectional'), constant(false)))`],
  ['createdBy', `.by('createdBy')`],
  ['createdByType', `.by('createdByType')`],
  ['createdAt', `.by('createdAt')`],
  ['createdInConversation', `.by(coalesce(values('createdInConversation'), constant('')))`],
  ['createdFromMessage', `.by(coalesce(values('createdFromMessage'), constant('')))`],
  ['modifiedBy', `.by('modifiedBy')`],
  ['modifiedByType', `.by('modifiedByType')`],
  ['modifiedAt', `.by('modifiedAt')`],
  ['modifiedInConversation', `.by(coalesce(values('modifiedInConversation'), constant('')))`],
  ['modifiedFromMessage', `.by(coalesce(values('modifiedFromMessage'), constant('')))`],
];

// Embedding is opt-in via `loadEmbeddings: true`. Stored as the
// JSON-stringified float array on the vertex; the projection emits the raw
// string (or '' when absent) and `entityFromGremlin` parses it.
const EMBEDDING_PROJECTION_ENTRY: ProjectionEntry = [
  'embedding',
  `.by(coalesce(values('embedding'), constant('')))`,
];

/**
 * Build a project-chain expression with no leading dot.
 * Form: `project('k1','k2',...).by(...).by(...)...`.
 * Used inside `.by(...)` modulators (path mode) and as the body of branch
 * suffix steps (all mode).
 */
function buildProjectExpression(entries: ReadonlyArray<ProjectionEntry>): string {
  const keys = entries.map(([k]) => `'${k}'`).join(',');
  const bys = entries.map(([, by]) => by).join('');
  return `project(${keys})${bys}`;
}

const VERTEX_PROJECT_EXPR = buildProjectExpression(VERTEX_PROJECTION);
const VERTEX_PROJECT_EXPR_WITH_EMBEDDING = buildProjectExpression([
  ...VERTEX_PROJECTION,
  EMBEDDING_PROJECTION_ENTRY,
]);
const EDGE_PROJECT_EXPR = buildProjectExpression(EDGE_PROJECTION);

/**
 * Stored-field name lists exposed for the cross-package sync test in
 * @utaba/deep-memory-storage-cosmosdb. Excludes synthetic projection-only
 * fields (`__kind`) — those are emission detail, not data the mapper reads.
 */
export const GREMLIN_VERTEX_PROJECTION_FIELDS: ReadonlyArray<string> =
  VERTEX_PROJECTION.map(([k]) => k).filter((k) => k !== '__kind');

export const GREMLIN_EDGE_PROJECTION_FIELDS: ReadonlyArray<string> =
  EDGE_PROJECTION.map(([k]) => k).filter((k) => k !== '__kind');

/**
 * Build a Gremlin `.project(...).by(...)...` chain expression for a stored
 * entity vertex, with no leading dot. Append after a vertex predicate
 * (e.g. `g.V().has('repositoryId', rid).hasId(p0)`) to read only the keys
 * `entityFromGremlin` consumes — avoiding `valueMap(true)` and its
 * ~30 KB-per-row embedding payload.
 *
 * The default omits `embedding`. Pass `{ withEmbedding: true }` only from
 * legitimate consumers of stored embeddings on read (the vector-search path).
 */
export function buildVertexProjectChain(opts?: { withEmbedding?: boolean }): string {
  return opts?.withEmbedding ? VERTEX_PROJECT_EXPR_WITH_EMBEDDING : VERTEX_PROJECT_EXPR;
}

/**
 * Build a Gremlin `.project(...).by(...)...` chain expression for a stored
 * relationship edge, with no leading dot. Edges never carry embeddings.
 */
export function buildEdgeProjectChain(): string {
  return EDGE_PROJECT_EXPR;
}

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
      // hasId(x) is a direct doc fetch by system id; has('id', x) is a
      // property-equality lookup that goes through the property index.
      // See docs/cosmosdb-gremlin-compatibility.md §Performance.
      parts.push(`.hasId(${p})`);
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
      //
      // Each branch pre-projects to a map (`.project(...).by(...)...`) so
      // the post-union stream is uniform projected maps — `dedup` then needs
      // `.by(select('id'))` to pluck the id key off the maps (see the
      // projection-field comment block above for the live-validated shape
      // constraints).
      const branches: string[] = [`__.identity().${VERTEX_PROJECT_EXPR}`];
      let prefix = '';
      for (const { edge, vertex, entityFilters } of compiledSteps) {
        // Vertex at depth i, with this depth's entity filters applied — emitted
        // BEFORE the edge branch so the deduped stream is closed under entity
        // references within a single hop: an edge in any .range() prefix is
        // preceded by the vertex it newly introduced. Single-hop pagination
        // therefore returns a referentially self-contained slice for any limit.
        branches.push(`__${prefix}${edge}${vertex}${entityFilters}.${VERTEX_PROJECT_EXPR}`);
        // Edge at depth i
        branches.push(`__${prefix}${edge}.${EDGE_PROJECT_EXPR}`);
        // Deeper branches walk through the unfiltered vertex hop
        prefix = `${prefix}${edge}${vertex}`;
        estimatedFanOut *= DEFAULT_ESTIMATED_FANOUT_PER_HOP;
      }

      parts.push(`.union(${branches.join(', ')})`);

      // 'all' is inherently deduped by id — spec.dedup is ignored. Items are
      // projected Maps, so dedup must select the 'id' key (property-name
      // strings don't resolve on Maps in CosmosDB Gremlin's subset).
      parts.push(`.dedup().by(select('id'))`);

      // ─── Pagination ───────────────────────────────────────────
      const limit = spec.limit ?? 50;
      const offset = spec.offset ?? 0;
      const pOffset = nextParam(offset);
      const pEnd = nextParam(offset + limit);
      parts.push(`.range(${pOffset}, ${pEnd})`);
      params['_limit'] = limit;
      params['_offset'] = offset;

      // No terminal projection step — each branch already projected.
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

      // Server-side projection replaces the vertex-projected terminal with a
      // group/dedup/values shape. Only emitted for terminal-mode queries — the
      // anchor (the last hop's target) is unambiguous there. For 'path' mode
      // projection is dropped silently (the same decision Cypher makes); 'all'
      // is handled by the branch above and never reaches this point.
      const emitProjection = spec.projection !== undefined && returnMode === 'terminal';

      // Dedup: 'terminal' honours spec.dedup. 'path' never dedups — paths are
      // distinct walks by definition; collapsing them by terminal id throws
      // away the answer. Skipped when emitProjection is set — projection owns
      // its own row semantics (count groups, distinct on projected Maps), and
      // a vertex-level dedup ahead of it would conflate "count rows" with
      // "count distinct vertices" against the Cypher contract.
      if (returnMode === 'terminal' && !emitProjection && spec.dedup !== false) {
        parts.push('.dedup()');
      }

      // Cycle prevention: 'path' mode always emits .simplePath(). A "path" in
      // graph terms has no repeated vertices; without this, a repeat() walk
      // emits walks-with-cycles (A→B→A→B…) that inflate the result set
      // O(fanout^maxDepth) and are not paths in any sensible sense. simplePath()
      // must be placed BEFORE .path() so it filters traversers; placed after,
      // it would (incorrectly) operate on the collected Path objects. Live-
      // probed against the Cosmos emulator 2026-05-25 — see
      // docs/cosmosdb-gremlin-compatibility.md §Repeat/variable-depth.
      // Not emitted for 'terminal' (no walk context) or 'all' (no path).
      if (returnMode === 'path') {
        parts.push('.simplePath()');
      }

      // Projection terminal — emitted BEFORE .range() so pagination slices
      // group rows / distinct rows, not the un-aggregated vertex stream.
      // .group() and .dedup() are barrier steps; .range() applied after them
      // operates on the post-aggregation stream, matching the Cypher
      // `SKIP / LIMIT` semantic over `RETURN n.p, count(*)`.
      if (emitProjection) {
        parts.push(emitProjectionTerminal(spec.projection!));
      }

      // ─── Pagination ───────────────────────────────────────────
      const limit = spec.limit ?? 50;
      const offset = spec.offset ?? 0;
      const pOffset = nextParam(offset);
      const pEnd = nextParam(offset + limit);
      parts.push(`.range(${pOffset}, ${pEnd})`);
      params['_limit'] = limit;
      params['_offset'] = offset;

      // Projection already emitted its own terminal — skip the vertex/path
      // emission below.
      if (emitProjection) {
        // no-op
      } else if (returnMode === 'terminal') {
        // 'terminal': flat vertex-projected rows.
        parts.push(`.${VERTEX_PROJECT_EXPR}`);
      } else {
        // 'path': path objects with each vertex+edge projected. A single
        // `.path().by(project(...))` across mixed objects crashes whenever an
        // edge lacks a vertex-only key, so we use the two-by round-robin form:
        // by-1 applies to vertices in path order, by-2 to edges.
        parts.push(`.path().by(${VERTEX_PROJECT_EXPR}).by(${EDGE_PROJECT_EXPR})`);
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

  // Max depth via times() — CosmosDB Gremlin does not accept a binding for
  // times(); it must be a literal int. Validate the input is a positive
  // integer before interpolating so the literal can't carry injected
  // Gremlin syntax. `nextParam` is intentionally not used here. This
  // function only runs when `step.repeat` is set (caller-checked), and
  // `maxDepth` is required on the repeat object — so an unset value here
  // would already be a type error upstream.
  const n = step.repeat!.maxDepth;
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(
      `GremlinCompiler: repeat.maxDepth must be a positive integer; got ${n}`,
    );
  }
  parts.push(`.times(${n})`);

  if (step.repeat?.emitIntermediates === false) {
    parts.push('.emit()');
  }

  return parts.join('');
}

const SAFE_PROJECTION_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Guard against Gremlin injection through projection property names.
 * Property names land inline in `values('p')` / `project('p')` steps —
 * Gremlin does not parameterise identifier positions — so they must look
 * like ordinary identifiers (letters, digits, underscores, leading non-digit).
 * Same rule and error shape the sibling CypherCompiler enforces for symmetry.
 */
function assertSafeProjectionKey(key: string): void {
  if (!SAFE_PROJECTION_KEY_RE.test(key)) {
    throw new Error(
      `Unsafe projection property name: "${key}". Property names must match ${SAFE_PROJECTION_KEY_RE.source}.`,
    );
  }
}

/**
 * Build the projection terminal — a single chain that replaces the
 * `.${VERTEX_PROJECT_EXPR}` emission for terminal-mode queries.
 *
 * Three shapes, mapped from `TraversalProjection.mode` + `.distinct`:
 *
 *   count           →  .group().by(<keyExpr>).by(count()).unfold()
 *   values+distinct →  .<keyExpr>.dedup()
 *   values (plain)  →  .<keyExpr>
 *
 * Single-property shortcut: when only one property is projected, `<keyExpr>`
 * is `values('p')` (a scalar per traverser). For two or more, `<keyExpr>` is
 * `project('p1','p2').by(values('p1')).by(values('p2'))` so each row is a
 * Map keyed by property name — the parser walks the same Map shape in either
 * mode and a single property still wraps to `{ p: scalar }` downstream.
 *
 * Property names are validated with `assertSafeProjectionKey` because they
 * cannot be parameterised in Gremlin.
 */
function emitProjectionTerminal(projection: TraversalProjection): string {
  const properties = projection.properties;
  const mode = projection.mode ?? 'values';
  const distinct = projection.distinct ?? false;

  for (const prop of properties) {
    assertSafeProjectionKey(prop);
  }

  const singleProperty = properties.length === 1;
  // keyExpr has no leading dot — used inside `.by(...)` (count mode) and as
  // the terminal step itself (distinct / values modes, with a leading dot).
  const keyExpr = singleProperty
    ? `values('${properties[0]}')`
    : `project(${properties.map((p) => `'${p}'`).join(',')})${properties.map((p) => `.by(values('${p}'))`).join('')}`;

  if (mode === 'count') {
    // .group() collects into a single Map keyed by the projected combination;
    // .by(count()) aggregates per key; .unfold() expands the Map into one
    // traverser per entry so .range() pagination slices group rows.
    return `.group().by(${keyExpr}).by(count()).unfold()`;
  }
  if (distinct) {
    // .dedup() on projected Maps relies on value-equality dedup on the
    // current traverser — the documented Gremlin semantic.
    return `.${keyExpr}.dedup()`;
  }
  return `.${keyExpr}`;
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
