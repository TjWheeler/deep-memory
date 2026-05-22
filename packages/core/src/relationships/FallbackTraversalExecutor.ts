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

  let resultEntries: FrontierEntry[];
  if (spec.returnMode === 'all') {
    resultEntries = allCollected;
  } else {
    resultEntries = frontier;
  }

  // Dedup by entity ID
  if (dedup) {
    const seen = new Set<string>();
    resultEntries = resultEntries.filter((entry) => {
      if (seen.has(entry.entity.id)) return false;
      seen.add(entry.entity.id);
      return true;
    });
  }

  const total = resultEntries.length;
  const paged = resultEntries.slice(offset, offset + limit);

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

    // Operate on ALL matching entities (pre-pagination) for aggregation
    const sourceEntries = dedup
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

  if (!suppressEntities && (spec.returnMode === 'path' || spec.returnMode === 'all')) {
    const relMap = new Map<string, TraversalRelationship>();
    for (const entry of paged) {
      for (const rel of entry.relationshipPath) {
        if (!relMap.has(rel.id)) {
          relMap.set(rel.id, {
            id: rel.id,
            type: rel.relationshipType,
            sourceEntityId: rel.sourceEntityId,
            targetEntityId: rel.targetEntityId,
            direction: 'outbound',
            properties: rel.properties,
          });
        }
      }
    }
    relationships = Array.from(relMap.values());
  }

  if (!suppressEntities && spec.returnMode === 'path') {
    paths = paged.map((entry) => ({
      length: entry.entityPath.length - 1,
      entities: [(() => {
        const e = projectEntity(entry.entity, detailLevel) as TraversalEntity;
        if (!spec.includeProvenance) delete (e as unknown as Record<string, unknown>)['provenance'];
        return e;
      })()],
      relationships: entry.relationshipPath.map((rel) => ({
        id: rel.id,
        type: rel.relationshipType,
        sourceEntityId: rel.sourceEntityId,
        targetEntityId: rel.targetEntityId,
        direction: 'outbound' as const,
        properties: rel.properties,
      })),
    }));
  }

  const executionTimeMs = Date.now() - startTime;

  return {
    entities,
    relationships,
    paths,
    aggregations,
    total,
    returned: paged.length,
    hasMore: offset + limit < total,
    queryMetadata: {
      executionTimeMs,
      appliedLimits: {
        maxResults: limit,
      },
      truncated: total > limit + offset,
      truncationReason: total > limit + offset ? 'result_limit' : undefined,
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
