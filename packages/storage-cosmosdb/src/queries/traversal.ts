// Graph traversal + neighborhood + path Gremlin queries

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type {
  StorageExploreOptions,
  StoragePathOptions,
} from '@utaba/deep-memory/types';
import type {
  StorageNeighborhood,
  StorageNeighborhoodLayer,
  StoragePathResult,
  StoragePath,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import { entityFromGremlin, relationshipFromGremlin } from '../mapping.js';
import { matchesPropertyFilters } from '@utaba/deep-memory';

/**
 * Explore neighborhood using BFS layer-by-layer.
 * Each layer fetches relationships from the frontier, then loads connected entities.
 */
export async function exploreNeighborhood(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  options: StorageExploreOptions,
): Promise<StorageNeighborhood> {
  const layers: StorageNeighborhoodLayer[] = [];
  let frontier = new Set<string>([entityId]);
  const visited = new Set<string>([entityId]);

  for (let depth = 0; depth < options.depth; depth++) {
    const layer: StorageNeighborhoodLayer = {};
    const nextFrontier = new Set<string>();
    // Cache entity loads within this layer to avoid redundant DB round-trips when
    // the same entity is connected via multiple relationship types. null = rejected by filter.
    const layerCache = new Map<string, StoredEntity | null>();

    for (const currentId of frontier) {
      // Get relationships from this entity
      const rels = await getRelationshipsForEntity(conn, repositoryId, currentId, options);

      for (const rel of rels) {
        const relType = rel.relationshipType;
        if (!layer[relType]) {
          layer[relType] = { total: 0, entities: [], relationships: [] };
        }

        // Determine the connected entity ID
        let connectedId: string;
        if (rel.sourceEntityId === currentId) {
          connectedId = rel.targetEntityId;
        } else {
          connectedId = rel.sourceEntityId;
        }

        // Skip entities already visited in a previous BFS layer
        if (visited.has(connectedId)) continue;

        // Load entity, using per-layer cache to avoid redundant fetches
        let entity: StoredEntity | null | undefined = layerCache.get(connectedId);
        if (entity === undefined) {
          const loaded = await getEntityLight(conn, repositoryId, connectedId);
          if (loaded && (!options.entityTypes || options.entityTypes.length === 0 || options.entityTypes.includes(loaded.entityType))) {
            entity = loaded;
          } else {
            entity = null;
          }
          layerCache.set(connectedId, entity);
          if (entity) nextFrontier.add(connectedId);
        }

        if (!entity) continue;

        layer[relType]!.entities.push(entity);
        layer[relType]!.relationships.push(rel);
        layer[relType]!.total = layer[relType]!.entities.length;
      }
    }

    // Apply limitPerType
    for (const relType of Object.keys(layer)) {
      const group = layer[relType]!;
      const start = options.offsetPerType;
      const end = start + options.limitPerType;
      group.entities = group.entities.slice(start, end);
      group.relationships = group.relationships.slice(start, end);
    }

    if (Object.keys(layer).length > 0) {
      layers.push(layer);
    }

    // Promote this layer's entities into visited after the full layer is processed,
    // not mid-loop, so the same entity can appear under multiple relationship types.
    for (const id of nextFrontier) {
      visited.add(id);
    }
    frontier = nextFrontier;

    if (frontier.size === 0) break;
  }

  return { centerId: entityId, layers };
}

/** Get relationships for a single entity with direction and type filtering. */
async function getRelationshipsForEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
  options: StorageExploreOptions,
): Promise<StoredRelationship[]> {
  const bindings: Record<string, unknown> = { rid: repositoryId, eid: entityId };

  let edgeTraversal: string;
  switch (options.direction) {
    case 'outbound':
      edgeTraversal = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').union(outE(), inE().has('bidirectional', true))";
      break;
    case 'inbound':
      edgeTraversal = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').union(inE(), outE().has('bidirectional', true))";
      break;
    case 'both':
    default:
      edgeTraversal = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').bothE()";
      break;
  }

  let typeFilter = '';
  if (options.relationshipTypes && options.relationshipTypes.length > 0) {
    const typeParams: string[] = [];
    options.relationshipTypes.forEach((t, i) => {
      const paramName = `rtype${i}`;
      bindings[paramName] = t;
      typeParams.push(paramName);
    });
    typeFilter = `.hasLabel(${typeParams.join(', ')})`;
  }

  const result = await conn.submit(
    `${edgeTraversal}${typeFilter}.dedup().valueMap(true)`,
    bindings,
  );

  let rels = (result.items as Record<string, unknown>[]).map(relationshipFromGremlin);

  // Apply relationship property filters
  if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
    rels = rels.filter(rel => matchesPropertyFilters(rel.properties, options.relationshipPropertyFilters!));
  }

  return rels;
}

/** Get a single entity without embedding (light). */
async function getEntityLight(
  conn: CosmosDbConnection,
  repositoryId: string,
  entityId: string,
): Promise<StoredEntity | null> {
  const result = await conn.submit(
    "g.V().has('repositoryId', rid).has('id', eid).has('entityType').valueMap(true)",
    { rid: repositoryId, eid: entityId },
  );
  if (result.items.length === 0) return null;
  return entityFromGremlin(result.items[0] as Record<string, unknown>);
}

/**
 * Find paths between two entities using BFS.
 * Gremlin native path() with simplePath() prevents cycles.
 */
export async function findPaths(
  conn: CosmosDbConnection,
  repositoryId: string,
  sourceId: string,
  targetId: string,
  options: StoragePathOptions,
): Promise<StoragePathResult> {
  // BFS approach layer by layer to find paths
  const paths: StoragePath[] = [];
  const maxDepth = options.maxDepth;
  const limit = options.limit;

  // Use application-level BFS to find paths
  // This is more reliable across CosmosDB Gremlin subset limitations
  interface BfsState {
    entityId: string;
    path: string[];
    relationshipIds: string[];
  }

  let queue: BfsState[] = [{ entityId: sourceId, path: [sourceId], relationshipIds: [] }];

  for (let depth = 0; depth < maxDepth && paths.length < limit; depth++) {
    const nextQueue: BfsState[] = [];

    for (const state of queue) {
      if (paths.length >= limit) break;

      // Get all relationships for current entity (both directions)
      const bindings: Record<string, unknown> = { rid: repositoryId, eid: state.entityId };
      let edgeQuery = "g.V().has('repositoryId', rid).has('id', eid).has('entityType').bothE()";

      if (options.relationshipTypes && options.relationshipTypes.length > 0) {
        const typeParams: string[] = [];
        options.relationshipTypes.forEach((t, i) => {
          const paramName = `rtype${i}`;
          bindings[paramName] = t;
          typeParams.push(paramName);
        });
        edgeQuery += `.hasLabel(${typeParams.join(', ')})`;
      }

      const relResult = await conn.submit(`${edgeQuery}.valueMap(true)`, bindings);
      const rels = (relResult.items as Record<string, unknown>[]).map(relationshipFromGremlin);

      // Filter by relationship property filters
      let filteredRels = rels;
      if (options.relationshipPropertyFilters && options.relationshipPropertyFilters.length > 0) {
        filteredRels = rels.filter(r => matchesPropertyFilters(r.properties, options.relationshipPropertyFilters!));
      }

      for (const rel of filteredRels) {
        const nextId = rel.sourceEntityId === state.entityId
          ? rel.targetEntityId
          : rel.sourceEntityId;

        // Prevent cycles
        if (state.path.includes(nextId)) continue;

        // Entity type filter
        if (options.entityTypes && options.entityTypes.length > 0 && nextId !== targetId) {
          const entity = await getEntityLight(conn, repositoryId, nextId);
          if (!entity || !options.entityTypes.includes(entity.entityType)) continue;
        }

        const newPath = [...state.path, nextId];
        const newRelIds = [...state.relationshipIds, rel.id];

        if (nextId === targetId) {
          paths.push({ entityIds: newPath, relationshipIds: newRelIds });
          if (paths.length >= limit) break;
        } else {
          nextQueue.push({ entityId: nextId, path: newPath, relationshipIds: newRelIds });
        }
      }
    }

    queue = nextQueue;
    if (queue.length === 0) break;
  }

  return {
    paths,
    totalPaths: paths.length,
  };
}
