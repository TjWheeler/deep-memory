// FallbackTraversalExecutor — executes a TraversalSpec over StorageProvider
// using iterative relationship lookups with batched entity resolution.
// Provides multi-hop traversal for implementers who don't have a graph database.

import type { StorageProvider } from '../providers/StorageProvider.js';
import type { TraversalSpec, TraversalStep, TraversalResult, TraversalRelationship, TraversalPath, TraversalAggregation, TraversalEntity } from '../types/traversal.js';
import type { RelationshipSummary } from '../types/relationships.js';
import type { StoredEntity, DetailLevel } from '../types/entities.js';
import type { StoredRelationship, RelationshipDirection } from '../types/relationships.js';
import { projectEntity } from '../entities/entityProjection.js';
import { matchesPropertyFilters } from './PropertyFilterMatcher.js';
import { EntityNotFoundError } from '../core/errors.js';

/** Maximum storage round-trips before aborting to prevent runaway traversals. */
const MAX_STORAGE_CALLS = 500;

/** Maximum entities to scan for vertex queries and aggregation. */
const MAX_ENTITY_SCAN = 10000;

/**
 * Maximum number of relationship results to fetch per frontier entity.
 * Set high to avoid truncation — client-side filtering handles the rest.
 */
const REL_FETCH_LIMIT = 1000;

interface FrontierEntry {
  entity: StoredEntity;
  /** Path of entity IDs from start to this entity. */
  entityPath: string[];
  /** Path of relationships from start to this entity. */
  relationshipPath: StoredRelationship[];
}

/**
 * Execute a TraversalSpec using application-level BFS over StorageProvider.
 *
 * Optimized for SQL Server round-trips:
 * - Relationship lookups are per-entity (unavoidable without a batch interface)
 * - Entity resolution is batched via getEntities() — one call per step
 *   instead of one call per relationship result
 */
export async function executeFallbackTraversal(
  repositoryId: string,
  storage: StorageProvider,
  spec: TraversalSpec,
): Promise<TraversalResult> {
  const startTime = Date.now();
  let storageCalls = 0;

  const checkCallLimit = (): void => {
    if (storageCalls >= MAX_STORAGE_CALLS) {
      throw new Error(`Fallback traversal exceeded ${MAX_STORAGE_CALLS} storage calls. Consider using a GraphTraversalProvider for large traversals.`);
    }
  };

  // ─── 1. Resolve starting entities ─────────────────────────────

  // When select is present or no steps (vertex query), fetch all matching
  // entities so aggregation is computed over the full dataset.
  // When traversing with steps, use the spec limit as the fetch cap.
  const isVertexQuery = !spec.steps || spec.steps.length === 0;
  const needsFullScan = isVertexQuery || spec.projection !== undefined;
  const fetchLimit = needsFullScan ? MAX_ENTITY_SCAN : (spec.limit ?? 50);

  let frontier: FrontierEntry[] = [];

  if (spec.start.entityId) {
    const entity = await resolveEntity(repositoryId, storage, spec.start.entityId);
    storageCalls++;
    if (entity) {
      frontier.push({ entity, entityPath: [entity.id], relationshipPath: [] });
    } else {
      throw new EntityNotFoundError(spec.start.entityId);
    }
  } else if (spec.start.entityType) {
    const result = await storage.findEntities(repositoryId, {
      entityTypes: [spec.start.entityType],
      limit: fetchLimit,
      offset: 0,
    });
    storageCalls++;
    frontier = result.items.map((e) => ({
      entity: e,
      entityPath: [e.id],
      relationshipPath: [],
    }));
  } else if (spec.start.filter && spec.start.filter.length > 0) {
    const result = await storage.findEntities(repositoryId, {
      limit: fetchLimit,
      offset: 0,
    });
    storageCalls++;
    frontier = result.items
      .filter((e) => matchesPropertyFilters(e.properties, spec.start.filter!))
      .map((e) => ({
        entity: e,
        entityPath: [e.id],
        relationshipPath: [],
      }));
  }

  // Apply start filters to frontier (when combined with entityId or entityType)
  if (spec.start.filter && spec.start.filter.length > 0 && (spec.start.entityId || spec.start.entityType)) {
    frontier = frontier.filter((entry) =>
      matchesPropertyFilters(entry.entity.properties, spec.start.filter!),
    );
  }

  // ─── 2. Execute steps (if any) ─────────────────────────────────

  const steps = spec.steps ?? [];
  const allCollected: FrontierEntry[] = spec.returnMode === 'all' ? [...frontier] : [];

  for (const step of steps) {
    checkCallLimit();

    if (step.repeat) {
      const result = await executeRepeatStep(
        repositoryId, storage, frontier, step,
        () => { storageCalls++; checkCallLimit(); },
      );
      frontier = result.terminal;
      if (spec.returnMode === 'all') {
        allCollected.push(...result.intermediates);
      }
    } else {
      frontier = await executeSingleStep(
        repositoryId, storage, frontier, step,
        () => { storageCalls++; checkCallLimit(); },
      );
      if (spec.returnMode === 'all') {
        allCollected.push(...frontier);
      }
    }
  }

  // ─── 3. Assemble results ──────────────────────────────────────

  const detailLevel: DetailLevel = spec.detailLevel ?? 'summary';
  const dedup = spec.dedup !== false;
  const limit = spec.limit ?? 50;
  const offset = spec.offset ?? 0;

  // Result selection & pagination.
  //
  // - 'all' mode paginates against an interleaved entity+edge union ordered
  //   by BFS layer (start vertices → step-1 edges → step-1 vertices → …),
  //   with id-dedup applied within entities and within relationships. This
  //   mirrors the post-dedup stream Cosmos's `.union(...).dedup().range()`
  //   produces, so a paginated 'all' response holds a self-consistent slice
  //   of the reached sub-graph instead of "this page's entities + every
  //   edge in the subgraph".
  // - 'terminal' and 'path' continue to paginate the entity list directly
  //   (existing behaviour). 'terminal' honours spec.dedup; 'path' never
  //   dedups (distinct walks are the answer).
  let paged: FrontierEntry[];
  let pagedAllRels: StoredRelationship[] = [];
  let total: number;
  let unionFullLength = 0;

  if (spec.returnMode === 'all') {
    const unionElements = buildAllModeUnion(allCollected);
    unionFullLength = unionElements.length;
    const pageSlice = unionElements.slice(offset, offset + limit);
    const pageEntries: FrontierEntry[] = [];
    for (const element of pageSlice) {
      if (element.kind === 'entity') {
        pageEntries.push(element.entry);
      } else {
        pagedAllRels.push(element.rel);
      }
    }
    paged = pageEntries;
    total = pageEntries.length + pagedAllRels.length;
  } else {
    const resultEntries = dedup && spec.returnMode !== 'path'
      ? dedupEntriesById(frontier)
      : frontier;
    total = resultEntries.length;
    paged = resultEntries.slice(offset, offset + limit);
  }

  // Build result
  // When projection is present, entities are suppressed by default (projection replaces full output).
  // Set projection.includeEntities to get both.
  const suppressEntities = spec.projection !== undefined && spec.projection.includeEntities !== true;

  let entities: TraversalEntity[];
  if (suppressEntities) {
    entities = [];
  } else {
    entities = paged.map((entry) => {
      const projected = projectEntity(entry.entity, detailLevel) as TraversalEntity;
      // Strip provenance unless explicitly requested (only present at detailLevel 'full')
      if (!spec.includeProvenance) {
        delete (projected as unknown as Record<string, unknown>)['provenance'];
      }
      return projected;
    });

    // Attach relationship summaries.
    // Fallback path: N parallel storage calls (one per result entity).
    // Native GraphTraversalProviders should handle this in a single query instead.
    if (spec.includeRelationshipSummary && entities.length > 0) {
      const summaryResults = await Promise.all(
        paged.map(async (entry) => {
          storageCalls++;
          const result = await storage.getEntityRelationships(repositoryId, entry.entity.id, {
            direction: 'both',
            limit: 10000,
          });
          const summary: RelationshipSummary = { outbound: {}, inbound: {} };
          for (const rel of result.items) {
            if (rel.sourceEntityId === entry.entity.id) {
              summary.outbound[rel.relationshipType] = (summary.outbound[rel.relationshipType] ?? 0) + 1;
            }
            if (rel.targetEntityId === entry.entity.id) {
              summary.inbound[rel.relationshipType] = (summary.inbound[rel.relationshipType] ?? 0) + 1;
            }
          }
          return summary;
        }),
      );

      entities = entities.map((e, i) => ({ ...e, relationshipSummary: summaryResults[i] }));
    }
  }

  // Build aggregations if projection is specified
  let aggregations: TraversalAggregation[] | undefined;
  if (spec.projection) {
    const propNames = spec.projection.properties;
    const mode = spec.projection.mode ?? 'values';
    const distinct = spec.projection.distinct ?? false;

    // Operate on ALL matching entities (pre-pagination) for aggregation.
    // Dedup decision matches the entities path: 'all' always dedups, 'terminal'
    // honours spec.dedup, 'path' never dedups.
    const aggregateDedup = spec.returnMode === 'all' || (dedup && spec.returnMode !== 'path');
    const sourceEntries = aggregateDedup
      ? (() => {
          const seen = new Set<string>();
          return (spec.returnMode === 'all' ? allCollected : frontier).filter((e) => {
            if (seen.has(e.entity.id)) return false;
            seen.add(e.entity.id);
            return true;
          });
        })()
      : (spec.returnMode === 'all' ? allCollected : frontier);

    if (mode === 'count' || distinct) {
      // Group by distinct value combinations
      const groups = new Map<string, { values: Record<string, unknown>; count: number }>();
      for (const entry of sourceEntries) {
        const vals: Record<string, unknown> = {};
        for (const prop of propNames) {
          vals[prop] = entry.entity.properties[prop] ?? null;
        }
        const key = JSON.stringify(vals);
        const existing = groups.get(key);
        if (existing) {
          existing.count++;
        } else {
          groups.set(key, { values: vals, count: 1 });
        }
      }

      aggregations = Array.from(groups.values()).map((g) => ({
        values: g.values,
        ...(mode === 'count' ? { count: g.count } : {}),
      }));

      // Sort by count descending for count mode
      if (mode === 'count') {
        aggregations.sort((a, b) => (b.count ?? 0) - (a.count ?? 0));
      }
    } else {
      // Raw values mode — extract properties from each entity
      aggregations = sourceEntries.map((entry) => {
        const vals: Record<string, unknown> = {};
        for (const prop of propNames) {
          vals[prop] = entry.entity.properties[prop] ?? null;
        }
        return { values: vals };
      });
    }
  }

  let relationships: TraversalRelationship[] | undefined;
  let paths: TraversalPath[] | undefined;

  if (!suppressEntities && spec.returnMode === 'all') {
    // 'all' mode: relationships come from the union page slice computed above,
    // so the response stays a self-consistent window into the union ordering.
    // direction is always 'outbound' (= stored topology) — the deduped union
    // carries no walk context, per Phase 7 contract.
    relationships = pagedAllRels.map((rel) => ({
      id: rel.id,
      type: rel.relationshipType,
      sourceEntityId: rel.sourceEntityId,
      targetEntityId: rel.targetEntityId,
      direction: 'outbound',
      properties: rel.properties,
    }));
  } else if (!suppressEntities && spec.returnMode === 'path') {
    // 'path' mode: outer rels mirror the per-page walks (one slot per
    // walked edge, deduped by rel id across the page's paths). direction is
    // relative to the walk at the position the edge was crossed; first
    // path to contribute an edge wins, matching the Cosmos provider.
    const relMap = new Map<string, TraversalRelationship>();
    for (const entry of paged) {
      for (let i = 0; i < entry.relationshipPath.length; i++) {
        const rel = entry.relationshipPath[i]!;
        if (!relMap.has(rel.id)) {
          const fromId = entry.entityPath[i]!;
          relMap.set(rel.id, {
            id: rel.id,
            type: rel.relationshipType,
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            direction: fromId === rel.sourceEntityId ? 'outbound' : 'inbound',
            properties: rel.properties,
          });
        }
      }
    }
    relationships = Array.from(relMap.values());
  }

  if (!suppressEntities && spec.returnMode === 'path') {
    // Resolve the full walked entity sequence per path. The frontier only
    // carries the terminal StoredEntity; intermediates live as IDs in
    // entry.entityPath, so we batch-resolve them in one storage call.
    const pathEntityIds = new Set<string>();
    for (const entry of paged) {
      for (const id of entry.entityPath) {
        pathEntityIds.add(id);
      }
    }
    const pathEntityMap = pathEntityIds.size > 0
      ? await storage.getEntities(repositoryId, [...pathEntityIds])
      : new Map<string, StoredEntity>();
    if (pathEntityIds.size > 0) {
      storageCalls++;
    }

    paths = paged.map((entry) => ({
      length: entry.entityPath.length - 1,
      entities: entry.entityPath.map((id) => {
        const stored = pathEntityMap.get(id);
        if (!stored) {
          throw new EntityNotFoundError(id);
        }
        const projected = projectEntity(stored, detailLevel) as TraversalEntity;
        if (!spec.includeProvenance) {
          delete (projected as unknown as Record<string, unknown>)['provenance'];
        }
        return projected;
      }),
      relationships: entry.relationshipPath.map((rel, i) => {
        // Direction is relative to the walk at this hop: 'outbound' when the
        // walk crossed the edge in stored topology, 'inbound' when reversed.
        const fromId = entry.entityPath[i]!;
        return {
          id: rel.id,
          type: rel.relationshipType,
          sourceEntityId: rel.sourceEntityId,
          targetEntityId: rel.targetEntityId,
          direction: fromId === rel.sourceEntityId ? ('outbound' as const) : ('inbound' as const),
          properties: rel.properties,
        };
      }),
    }));
  }

  const executionTimeMs = Date.now() - startTime;

  // 'all' mode: returned/total/hasMore are computed against the union of
  // entities+relationships actually in the page (matches the Cosmos
  // provider's per-page semantic). 'terminal'/'path' keep the existing
  // "full pre-pagination total, page-size returned" semantic.
  const returned = spec.returnMode === 'all' ? total : paged.length;
  const hasMore = spec.returnMode === 'all'
    ? offset + limit < unionFullLength
    : offset + limit < total;
  const truncated = spec.returnMode === 'all'
    ? unionFullLength > limit + offset
    : total > limit + offset;

  return {
    entities,
    relationships,
    paths,
    aggregations,
    total,
    returned,
    hasMore,
    queryMetadata: {
      executionTimeMs,
      appliedLimits: {
        maxResults: limit,
      },
      truncated,
      truncationReason: truncated ? 'result_limit' : undefined,
    },
  };
}

/**
 * Execute a single (non-repeat) traversal step across the frontier.
 *
 * Optimization: relationship queries are per-entity (required by StorageProvider
 * interface), but entity resolution is batched — one getEntities() call for
 * all target IDs discovered in this step, instead of one getEntity() per target.
 */
async function executeSingleStep(
  repositoryId: string,
  storage: StorageProvider,
  frontier: FrontierEntry[],
  step: TraversalStep,
  onStorageCall: () => void,
): Promise<FrontierEntry[]> {
  // Phase 1: Collect all relationships from the frontier (N queries, 1 per frontier entity)
  const direction = mapDirection(step.direction);
  const pendingEdges: Array<{
    entry: FrontierEntry;
    rel: StoredRelationship;
    targetId: string;
  }> = [];

  for (const entry of frontier) {
    const rels = await storage.getEntityRelationships(repositoryId, entry.entity.id, {
      direction,
      relationshipTypes: step.relationshipTypes,
      limit: REL_FETCH_LIMIT,
    });
    onStorageCall();

    for (const rel of rels.items) {
      // Apply relationship property filters early (avoids unnecessary entity lookups)
      if (step.relationshipFilter && step.relationshipFilter.length > 0) {
        if (!matchesPropertyFilters(rel.properties, step.relationshipFilter)) {
          continue;
        }
      }

      const targetId = getTargetId(rel, entry.entity.id);
      pendingEdges.push({ entry, rel, targetId });
    }
  }

  if (pendingEdges.length === 0) return [];

  // Phase 2: Batch-resolve all target entities in one call
  const uniqueTargetIds = [...new Set(pendingEdges.map((e) => e.targetId))];
  const entityMap = await storage.getEntities(repositoryId, uniqueTargetIds);
  onStorageCall();

  // Phase 3: Assemble the next frontier with client-side filtering
  const nextFrontier: FrontierEntry[] = [];

  for (const { entry, rel, targetId } of pendingEdges) {
    const targetEntity = entityMap.get(targetId);
    if (!targetEntity) continue;

    // Apply entity type filter
    if (step.entityTypes && step.entityTypes.length > 0) {
      if (!step.entityTypes.includes(targetEntity.entityType)) continue;
    }

    // Apply entity property filters
    if (step.entityFilter && step.entityFilter.length > 0) {
      if (!matchesPropertyFilters(targetEntity.properties, step.entityFilter)) continue;
    }

    nextFrontier.push({
      entity: targetEntity,
      entityPath: [...entry.entityPath, targetEntity.id],
      relationshipPath: [...entry.relationshipPath, rel],
    });
  }

  return nextFrontier;
}

/** Execute a repeat/loop step, iterating up to maxDepth times. */
async function executeRepeatStep(
  repositoryId: string,
  storage: StorageProvider,
  frontier: FrontierEntry[],
  step: TraversalStep,
  onStorageCall: () => void,
): Promise<{ terminal: FrontierEntry[]; intermediates: FrontierEntry[] }> {
  const maxDepth = step.repeat?.maxDepth ?? 1;
  const emitIntermediates = step.repeat?.emitIntermediates !== false;
  const untilFilters = step.repeat?.until;

  let current = frontier;
  const allIntermediates: FrontierEntry[] = [];
  const visited = new Set<string>();

  for (const entry of frontier) {
    visited.add(entry.entity.id);
  }

  for (let depth = 0; depth < maxDepth; depth++) {
    const next = await executeSingleStep(repositoryId, storage, current, step, onStorageCall);

    // Filter out already-visited to prevent cycles
    const unvisited = next.filter((entry) => {
      if (visited.has(entry.entity.id)) return false;
      visited.add(entry.entity.id);
      return true;
    });

    if (unvisited.length === 0) break;

    if (untilFilters && untilFilters.length > 0) {
      const matching: FrontierEntry[] = [];
      const continuing: FrontierEntry[] = [];

      for (const entry of unvisited) {
        if (matchesPropertyFilters(entry.entity.properties, untilFilters)) {
          matching.push(entry);
        } else {
          continuing.push(entry);
        }
      }

      if (emitIntermediates) {
        allIntermediates.push(...continuing);
      }
      allIntermediates.push(...matching);

      if (matching.length > 0 && continuing.length === 0) {
        current = matching;
        break;
      }
      current = continuing;
    } else {
      if (emitIntermediates) {
        allIntermediates.push(...unvisited);
      }
      current = unvisited;
    }
  }

  return {
    terminal: current,
    intermediates: allIntermediates,
  };
}

/** Resolve an entity by ID or slug. */
async function resolveEntity(
  repositoryId: string,
  storage: StorageProvider,
  idOrSlug: string,
): Promise<StoredEntity | null> {
  const byId = await storage.getEntity(repositoryId, idOrSlug);
  if (byId) return byId;
  return storage.getEntityBySlug(repositoryId, idOrSlug);
}

/** Map traversal direction to storage direction. */
function mapDirection(direction: 'out' | 'in' | 'both'): RelationshipDirection {
  switch (direction) {
    case 'out': return 'outbound';
    case 'in': return 'inbound';
    case 'both': return 'both';
  }
}

/** Get the target entity ID from a relationship relative to the current entity. */
function getTargetId(rel: StoredRelationship, currentEntityId: string): string {
  if (rel.sourceEntityId === currentEntityId) {
    return rel.targetEntityId;
  }
  return rel.sourceEntityId;
}

/** Dedup frontier entries by entity id, preserving first occurrence. */
function dedupEntriesById(entries: FrontierEntry[]): FrontierEntry[] {
  const seen = new Set<string>();
  const result: FrontierEntry[] = [];
  for (const entry of entries) {
    if (!seen.has(entry.entity.id)) {
      seen.add(entry.entity.id);
      result.push(entry);
    }
  }
  return result;
}

/**
 * A single element of the 'all'-mode interleaved union. Tagged so the page
 * splitter can route entries to `entities[]` and edges to `relationships[]`.
 */
type UnionElement =
  | { kind: 'entity'; entry: FrontierEntry }
  | { kind: 'relationship'; rel: StoredRelationship };

/**
 * Build the BFS-layer-ordered union for 'all' mode. Order mirrors what
 * Cosmos's `.union(identity, outE(r1), outE(r1).inV(), outE(r1).inV().outE(r2), …)`
 * would emit logically: start frontier → step-1 edges → step-1 vertices →
 * step-2 edges → step-2 vertices → … . Entities dedup by id; relationships
 * dedup by id. spec.dedup is ignored — 'all' is inherently deduped.
 *
 * Cosmos itself does not guarantee this exact ordering (a `.union().dedup()`
 * stream is unordered); the in-memory provider's ordering is the
 * deterministic spec used for pagination, and both providers honour
 * "every union element appears in exactly one page".
 */
function buildAllModeUnion(entries: FrontierEntry[]): UnionElement[] {
  if (entries.length === 0) return [];

  let maxDepth = 0;
  const byDepth = new Map<number, FrontierEntry[]>();
  for (const entry of entries) {
    const depth = entry.relationshipPath.length;
    if (depth > maxDepth) maxDepth = depth;
    let bucket = byDepth.get(depth);
    if (!bucket) {
      bucket = [];
      byDepth.set(depth, bucket);
    }
    bucket.push(entry);
  }

  const seenEntities = new Set<string>();
  const seenRels = new Set<string>();
  const result: UnionElement[] = [];

  for (const entry of byDepth.get(0) ?? []) {
    if (!seenEntities.has(entry.entity.id)) {
      seenEntities.add(entry.entity.id);
      result.push({ kind: 'entity', entry });
    }
  }

  for (let depth = 1; depth <= maxDepth; depth++) {
    const bucket = byDepth.get(depth) ?? [];
    for (const entry of bucket) {
      const newRel = entry.relationshipPath[depth - 1];
      if (newRel && !seenRels.has(newRel.id)) {
        seenRels.add(newRel.id);
        result.push({ kind: 'relationship', rel: newRel });
      }
    }
    for (const entry of bucket) {
      if (!seenEntities.has(entry.entity.id)) {
        seenEntities.add(entry.entity.id);
        result.push({ kind: 'entity', entry });
      }
    }
  }

  return result;
}
