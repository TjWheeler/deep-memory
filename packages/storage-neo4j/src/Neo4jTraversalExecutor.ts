// Neo4jTraversalExecutor — compile + submit + parse pipeline shared by
// `traverse`, `exploreNeighborhood`, and `findPaths`.
//
// Mirrors the Cosmos `executeTraversal` private — the language differs (Cypher
// vs Gremlin), the wire shape differs (typed `Node` / `Relationship` / `Path`
// objects vs projected `Map`s with a synthetic `__kind` field), but the
// discriminated-output contract is the same: `'terminal'` yields a flat row
// stream of node-only records, `'all'` yields a row-tuple of nodes and
// relationships per match, `'path'` yields full `Path` objects.
//
// Repository scope is injected at the compiled-query boundary by rewriting the
// first `MATCH (n0)` (or `MATCH p = (n0)`) the compiler emits to include the
// `:_Entity {repositoryId: $rid}` qualifier. The chokepoint's `$rid` assertion
// then passes structurally. The compiler does not itself emit repositoryId
// because the compiler is provider-agnostic — the rewrite lives here.

import type {
  MemoryVocabulary,
  StoredEntity,
  StoredRelationship,
  TraversalSpec,
} from '@utaba/deep-memory/types';
import { CypherCompiler, ProviderError } from '@utaba/deep-memory';
import type { Neo4jConnection } from './Neo4jConnection.js';
import { entityFromProperties, relationshipFromProperties } from './mapping.js';

/**
 * Raw, un-projected output of `Neo4jTraversalExecutor.execute`. Only the
 * fields relevant to the spec's `returnMode` are populated; the rest stay
 * empty. The public `traverseInternal` projects this bag into the
 * `TraversalResult` shape; `exploreNeighborhoodImpl` and `findPathsImpl`
 * consume `entityMap` / `relationshipMap` / `pathRows` directly.
 */
export interface RawTraversalResult {
  /** Populated for `returnMode === 'terminal'`. Row order preserved. */
  terminalEntities: StoredEntity[];
  /** Populated for `returnMode === 'all'`. Deduped by entity id across rows. */
  allEntities: StoredEntity[];
  /** Populated for `returnMode === 'all'`. Deduped by relationship id across rows. */
  allRelationships: StoredRelationship[];
  /** Populated for `returnMode === 'path'`. One entry per matching path. */
  pathRows: Array<{
    entityIds: string[];
    relationshipIds: string[];
    relationshipDirections: Array<'out' | 'in'>;
  }>;
  /** Lookup table for every entity that appeared in any returned row. */
  entityMap: Map<string, StoredEntity>;
  /** Lookup table for every relationship that appeared in any returned row. */
  relationshipMap: Map<string, StoredRelationship>;
  /**
   * First-seen walk direction per deduped edge id. Populated for `'path'`
   * mode only — `'all'` mode's row tuples have no walk context, only stored
   * topology.
   */
  pathRelFirstDirection: Map<string, 'out' | 'in'>;
  executionTimeMs: number;
  /** `summary.resultConsumedAfter` in ms — the cost number for the sink record. */
  serverMs: number;
  /** The Cypher actually shipped, after the repositoryId-scope rewrite. */
  compiledQuery: string;
  /** Captured when `profileTraversals: true`; otherwise `undefined`. */
  profile?: {
    totalDbHits: number;
    rootOperator: string;
  };
}

/**
 * Configuration the executor reads from the surrounding provider. The flag is
 * driver-wide so a single provider instance picks one behaviour — switching
 * it on/off per call would change query strings and pollute the plan cache.
 */
export interface Neo4jTraversalExecutorConfig {
  /**
   * When `true`, every compiled traversal query is prepended with `PROFILE`
   * and `summary.profile` is harvested into `RawTraversalResult.profile`. Off
   * by default (probe P17 measured ~129 % wall-clock overhead vs plain).
   */
  profileTraversals: boolean;
}

/**
 * Result-summary subset the executor reads. The driver's runtime type is
 * richer; the structural subset here lets the executor stay loosely typed.
 */
interface SummaryLike {
  resultConsumedAfter?: unknown;
  profile?: PlanLike;
}

interface PlanLike {
  operatorType?: string;
  dbHits?: unknown;
  children?: PlanLike[];
}

interface NodeLike {
  elementId: string;
  labels: string[];
  properties: Record<string, unknown>;
}

interface RelationshipLike {
  elementId: string;
  type: string;
  startNodeElementId: string;
  endNodeElementId: string;
  properties: Record<string, unknown>;
}

export class Neo4jTraversalExecutor {
  private readonly compiler = new CypherCompiler();

  constructor(
    private readonly connection: Neo4jConnection,
    private readonly config: Neo4jTraversalExecutorConfig,
  ) {}

  /**
   * Compile, scope, submit, and parse a traversal spec. The provider's vocab
   * cache is the source of `vocabulary` — `traverse` / `exploreNeighborhood`
   * / `findPaths` look it up once and pass it down.
   */
  public async execute(
    repositoryId: string,
    spec: TraversalSpec,
    vocabulary: MemoryVocabulary,
  ): Promise<RawTraversalResult> {
    const startTime = Date.now();
    const compiled = this.compiler.compile(spec, vocabulary);
    const scopedQuery = this.scopeQuery(compiled.query);
    const finalQuery = this.config.profileTraversals ? `PROFILE ${scopedQuery}` : scopedQuery;
    // The compiler emits `SKIP / LIMIT $pN` with JS-number bindings; Cypher's
    // pagination clauses require a Cypher INTEGER, and with `useBigInt: true`
    // a plain number arrives as FLOAT (`Neo.ClientError.Statement.ArgumentError:
    // '50.0' is not a valid value...`). Coerce those specific bindings to
    // BigInt at the boundary so the compiler stays language-pure.
    const params = coerceSkipLimitToBigInt(finalQuery, compiled.params);

    let result;
    try {
      result = await this.connection.executeQuery(
        finalQuery,
        params,
        { repositoryId, routing: 'READ' },
      );
    } catch (err: unknown) {
      throw new ProviderError(
        `Neo4j traversal failed: ${err instanceof Error ? err.message : String(err)}`,
        'Inspect the compiled Cypher in queryMetadata.compiledQuery and confirm the spec passed validation.',
      );
    }

    const executionTimeMs = Date.now() - startTime;
    const summary = result.summary as unknown as SummaryLike;
    const serverMs = bigintLike(summary.resultConsumedAfter);

    const raw: RawTraversalResult = {
      terminalEntities: [],
      allEntities: [],
      allRelationships: [],
      pathRows: [],
      entityMap: new Map(),
      relationshipMap: new Map(),
      pathRelFirstDirection: new Map(),
      executionTimeMs,
      serverMs,
      compiledQuery: finalQuery,
    };

    if (this.config.profileTraversals && summary.profile !== undefined) {
      raw.profile = summariseProfile(summary.profile);
    }

    if (spec.returnMode === 'terminal') {
      this.parseTerminalRows(result.records, raw);
    } else if (spec.returnMode === 'all') {
      this.parseAllRows(result.records, raw);
    } else {
      this.parsePathRows(result.records, raw);
    }

    return raw;
  }

  /**
   * Inject the repositoryId scope onto the start node so the chokepoint's
   * `$rid` assertion is satisfied structurally and the planner uses the
   * `(repositoryId, id)` unique constraint's backing index for the seek.
   *
   * The compiler always emits `(n0)` as the first match part (it never adds a
   * label or property map there) — we rewrite that single occurrence. The
   * provider's defence-in-depth (D3b layer 3) prevents cross-repository edges
   * from existing in the first place, so scoping just the start node is
   * sufficient — once the planner anchors on a node in this repo, every
   * reachable node is also in this repo.
   */
  private scopeQuery(query: string): string {
    // Two cases the compiler can emit at the start of the MATCH:
    //   'MATCH (n0)...' (terminal / all modes)
    //   'MATCH p = (n0)...' (path mode)
    // Either way the literal substring `(n0)` is the start-node form.
    const scope = '(n0:_Entity {repositoryId: $rid})';
    const replaced = query.replace('(n0)', scope);
    if (replaced === query) {
      throw new ProviderError(
        'Neo4jTraversalExecutor: compiled query did not contain the expected `(n0)` start-node form; cannot inject repositoryId scope.',
        'This indicates a CypherCompiler emission change that the provider has not been updated for.',
      );
    }
    return replaced;
  }

  private parseTerminalRows(
    records: ReadonlyArray<{ keys: ReadonlyArray<PropertyKey>; get(key: string): unknown }>,
    raw: RawTraversalResult,
  ): void {
    // 'terminal' mode emits one node alias (the last hop's target). Walk every
    // column on every row and pick up the first Node-shaped value — the
    // compiler's RETURN has exactly one column in terminal mode.
    for (const record of records) {
      for (const key of record.keys) {
        if (typeof key !== 'string') continue;
        const value = record.get(key);
        if (isNode(value)) {
          const stored = entityFromNode(value);
          raw.terminalEntities.push(stored);
          if (!raw.entityMap.has(stored.id)) raw.entityMap.set(stored.id, stored);
        }
      }
    }
  }

  private parseAllRows(
    records: ReadonlyArray<{ keys: ReadonlyArray<PropertyKey>; get(key: string): unknown }>,
    raw: RawTraversalResult,
  ): void {
    // 'all' mode rows are tuples like (n0, n1, ..., nD, r0, ..., r(D-1)). Each
    // column may be a Node or a Relationship — discriminate by shape and dedup
    // by entity/relationship id across rows. Each id contributes to the
    // entities / relationships arrays exactly once.
    for (const record of records) {
      for (const key of record.keys) {
        if (typeof key !== 'string') continue;
        const value = record.get(key);
        if (isNode(value)) {
          const stored = entityFromNode(value);
          if (!raw.entityMap.has(stored.id)) {
            raw.entityMap.set(stored.id, stored);
            raw.allEntities.push(stored);
          }
        } else if (isRelationship(value)) {
          const stored = relationshipFromRelationship(value);
          if (!raw.relationshipMap.has(stored.id)) {
            raw.relationshipMap.set(stored.id, stored);
            raw.allRelationships.push(stored);
          }
        }
        // Other column shapes (BigInt counters, list-typed relationships from
        // variable-length patterns) are not expected in non-repeat 'all'
        // emission; ignore them so the parser stays forward-compatible.
      }
    }
  }

  private parsePathRows(
    records: ReadonlyArray<{ keys: ReadonlyArray<PropertyKey>; get(key: string): unknown }>,
    raw: RawTraversalResult,
  ): void {
    // 'path' mode returns `pathNodes` (list of Node), `pathRels` (list of
    // Relationship), `pathLength` (Integer). The variable-length pattern
    // produces one row per matching walk — including the 0-hop start-only
    // "path" — and `nodes(p)` / `relationships(p)` are ordered along the walk.
    // Walk direction per segment is recovered by comparing each relationship's
    // `startNodeElementId` to the preceding node's `elementId`.
    for (const record of records) {
      const pathNodes = record.get('pathNodes');
      const pathRels = record.get('pathRels');
      if (!Array.isArray(pathNodes) || !Array.isArray(pathRels)) continue;

      const pathEntityIds: string[] = [];
      const pathRelIds: string[] = [];
      const pathRelDirections: Array<'out' | 'in'> = [];
      let previousElementId: string | undefined;

      for (const node of pathNodes) {
        if (!isNode(node)) continue;
        const stored = entityFromNode(node);
        if (!raw.entityMap.has(stored.id)) raw.entityMap.set(stored.id, stored);
        pathEntityIds.push(stored.id);
      }

      for (let i = 0; i < pathRels.length; i++) {
        const rel = pathRels[i];
        if (!isRelationship(rel)) continue;
        const stored = relationshipFromRelationship(rel);
        if (!raw.relationshipMap.has(stored.id)) raw.relationshipMap.set(stored.id, stored);
        pathRelIds.push(stored.id);

        // Determine walk direction at this segment by aligning the relationship's
        // stored topology with the path's node ordering. The node at index `i`
        // is the source of segment `i`; if the relationship's stored start
        // matches that node, the walk crossed source → target (`'out'`),
        // otherwise it crossed target → source (`'in'`).
        const segmentStartNode = pathNodes[i];
        const segmentStartElementId = isNode(segmentStartNode)
          ? segmentStartNode.elementId
          : previousElementId;
        const direction: 'out' | 'in' =
          segmentStartElementId !== undefined &&
          rel.startNodeElementId === segmentStartElementId
            ? 'out'
            : 'in';
        pathRelDirections.push(direction);
        if (!raw.pathRelFirstDirection.has(stored.id)) {
          raw.pathRelFirstDirection.set(stored.id, direction);
        }
        const segmentEndNode = pathNodes[i + 1];
        if (isNode(segmentEndNode)) previousElementId = segmentEndNode.elementId;
      }

      raw.pathRows.push({
        entityIds: pathEntityIds,
        relationshipIds: pathRelIds,
        relationshipDirections: pathRelDirections,
      });
    }
  }
}

function isNode(value: unknown): value is NodeLike {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { elementId?: unknown; labels?: unknown; properties?: unknown };
  return (
    typeof v.elementId === 'string' &&
    Array.isArray(v.labels) &&
    typeof v.properties === 'object' &&
    v.properties !== null
  );
}

function isRelationship(value: unknown): value is RelationshipLike {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as {
    elementId?: unknown;
    type?: unknown;
    startNodeElementId?: unknown;
    endNodeElementId?: unknown;
    properties?: unknown;
  };
  return (
    typeof v.elementId === 'string' &&
    typeof v.type === 'string' &&
    typeof v.startNodeElementId === 'string' &&
    typeof v.endNodeElementId === 'string' &&
    typeof v.properties === 'object' &&
    v.properties !== null
  );
}

function entityFromNode(node: NodeLike): StoredEntity {
  return entityFromProperties(node.properties);
}

function relationshipFromRelationship(rel: RelationshipLike): StoredRelationship {
  // The vocabulary relationship type is stored on the edge's properties bag
  // — `r.relationshipType` matches the slug; the Cypher edge label
  // (`type(r)`) is the upper-cased Cypher identifier the compiler emitted.
  // The property is authoritative because it round-trips verbatim across
  // CRUD; the Cypher label is consumed only by Cypher pattern matching.
  return relationshipFromProperties(rel.properties);
}

function bigintLike(value: unknown): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return 0;
}

const SKIP_LIMIT_PARAM_PATTERN = /\b(?:SKIP|LIMIT)\s+\$(\w+)/gi;

function coerceSkipLimitToBigInt(
  cypher: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  const targetKeys = new Set<string>();
  for (const match of cypher.matchAll(SKIP_LIMIT_PARAM_PATTERN)) {
    if (match[1] !== undefined) targetKeys.add(match[1]);
  }
  if (targetKeys.size === 0) return params;
  const out: Record<string, unknown> = { ...params };
  for (const key of targetKeys) {
    const value = out[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = BigInt(Math.trunc(value));
    }
  }
  return out;
}

function summariseProfile(plan: PlanLike): { totalDbHits: number; rootOperator: string } {
  let total = 0;
  const visit = (node: PlanLike | undefined): void => {
    if (node === undefined) return;
    const hits = node.dbHits;
    if (typeof hits === 'bigint') total += Number(hits);
    else if (typeof hits === 'number') total += hits;
    for (const child of node.children ?? []) visit(child);
  };
  visit(plan);
  return { totalDbHits: total, rootOperator: plan.operatorType ?? 'unknown' };
}

