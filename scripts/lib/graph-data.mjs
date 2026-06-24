// Shared data layer for the graph-viewer tooling — used by both the live server
// (graph-viewer-server.mjs) and the self-contained HTML exporter (export-graph-html.mjs).
//
// It resolves the storage provider from the same config the MCP server uses and assembles graph
// payloads in the exact shape the viewer consumes ({ manifest, entities, relationships }).
//
// Requires the workspace packages to be built (it imports their dist output).

import { readFileSync, existsSync } from 'node:fs';
import {
  DeepMemory,
  InMemoryStorageProvider,
  InMemorySearchProvider,
} from '@utaba/deep-memory';
import { SqlServerStorageProvider } from '@utaba/deep-memory-storage-sqlserver';
import { CosmosDbProvider } from '@utaba/deep-memory-storage-cosmosdb';
import { Neo4jStorageProvider } from '@utaba/deep-memory-storage-neo4j';

// The Neo4j provider surfaces benign Cypher notifications via console.warn on every query; a full
// repository export fires hundreds of identical lines. Drop just those so the console stays
// readable — every other warning passes through unchanged. (Module side-effect: applied on import.)
const realWarn = console.warn.bind(console);
console.warn = (...args) => {
  if (typeof args[0] === 'string' && args[0].startsWith('[neo4j] notifications')) return;
  realWarn(...args);
};

// ── Config: .mcp.json env block, overridden by any DEEP_MEMORY_* in the environment ─────────
export function resolveConfig(mcpPath, serverKey) {
  const merged = {};
  if (existsSync(mcpPath)) {
    try {
      const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
      const envBlock = mcp?.mcpServers?.[serverKey]?.env ?? {};
      Object.assign(merged, envBlock);
    } catch (err) {
      console.warn(`Could not parse ${mcpPath}: ${err.message} — falling back to environment only.`);
    }
  } else {
    console.warn(`${mcpPath} not found — using environment variables only.`);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('DEEP_MEMORY_') && v !== undefined) merged[k] = v;
  }
  return merged;
}

export function buildDeepMemory(cfg) {
  const storageSetting = cfg['DEEP_MEMORY_STORAGE'];
  let storage;
  let graphTraversal;

  if (storageSetting === 'sqlserver') {
    storage = new SqlServerStorageProvider({
      connection: {
        server: cfg['DEEP_MEMORY_SQL_HOST'],
        port: cfg['DEEP_MEMORY_SQL_PORT'] ? Number(cfg['DEEP_MEMORY_SQL_PORT']) : 1433,
        database: cfg['DEEP_MEMORY_SQL_DATABASE'],
        user: cfg['DEEP_MEMORY_SQL_USER'],
        password: cfg['DEEP_MEMORY_SQL_PASSWORD'],
        options: {
          encrypt: false,
          trustServerCertificate: cfg['DEEP_MEMORY_SQL_TRUST_CERT'] === 'true',
        },
      },
      schema: cfg['DEEP_MEMORY_SQL_SCHEMA'] ?? 'dbo',
    });
  } else if (storageSetting === 'cosmosdb') {
    const cosmos = new CosmosDbProvider({
      endpoint: cfg['DEEP_MEMORY_COSMOSDB_ENDPOINT'],
      restEndpoint: cfg['DEEP_MEMORY_COSMOSDB_REST_ENDPOINT'],
      key: cfg['DEEP_MEMORY_COSMOSDB_KEY'],
      database: cfg['DEEP_MEMORY_COSMOSDB_DATABASE'],
      container: cfg['DEEP_MEMORY_COSMOSDB_CONTAINER'],
      rejectUnauthorized: cfg['DEEP_MEMORY_COSMOSDB_REJECT_UNAUTHORIZED'] !== 'false',
    });
    storage = cosmos;
    graphTraversal = cosmos;
  } else if (storageSetting === 'neo4j') {
    const neo4j = new Neo4jStorageProvider({
      uri: cfg['DEEP_MEMORY_NEO4J_URI'],
      username: cfg['DEEP_MEMORY_NEO4J_USERNAME'] ?? 'neo4j',
      password: cfg['DEEP_MEMORY_NEO4J_PASSWORD'],
      database: cfg['DEEP_MEMORY_NEO4J_DATABASE'] ?? 'neo4j',
    });
    storage = neo4j;
    graphTraversal = neo4j;
  } else {
    storage = new InMemoryStorageProvider();
  }

  const search = !storageSetting || storageSetting === 'memory' ? new InMemorySearchProvider() : undefined;

  // The viewer is read-only — no embeddings needed (no semantic search, no writes).
  const deepMemory = new DeepMemory({
    storage,
    search,
    graphTraversal,
    provenance: {
      actorId: cfg['DEEP_MEMORY_ACTOR_ID'] ?? 'graph-viewer',
      actorType: (cfg['DEEP_MEMORY_ACTOR_TYPE'] ?? 'agent'),
    },
  });

  return { deepMemory, storage, storageSetting: storageSetting ?? 'memory' };
}

// ── Data assembly (matches the static build's payload shape) ────────────────
async function openRepo(deepMemory, repoCache, repositoryId) {
  let repo = repoCache.get(repositoryId);
  if (!repo) {
    repo = await deepMemory.openRepository(repositoryId);
    repoCache.set(repositoryId, repo);
  }
  return repo;
}

export async function listRepositoriesWithStats(deepMemory, repoCache = new Map()) {
  const list = await deepMemory.listRepositories({ limit: 1000, offset: 0 });
  const out = [];
  for (const r of list.items) {
    const repo = await openRepo(deepMemory, repoCache, r.repositoryId);
    const stats = await repo.getStats();
    out.push({
      repositoryId: r.repositoryId,
      label: r.label,
      entityCount: stats.entityCount,
      relationshipCount: stats.relationshipCount,
      entityTypeBreakdown: stats.entityTypeBreakdown ?? {},
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

export async function buildGraphPayload(deepMemory, repositoryId) {
  // Stream the whole repository in bulk — the same path the .dkg export uses, so the entity and
  // relationship shape matches the static build exactly (and there's no per-entity query fan-out).
  let manifest = null;
  const rawEntities = [];
  const rawRelationships = [];
  for await (const item of deepMemory.exportRepositoryStream(repositoryId)) {
    if (item.type === 'manifest') manifest = item.data;
    else if (item.type === 'entities') rawEntities.push(...item.data);
    else if (item.type === 'relationships') rawRelationships.push(...item.data);
  }

  // Precompute degree (relationships touching each entity), exactly like the static build.
  const degree = new Map();
  for (const r of rawRelationships) {
    degree.set(r.sourceEntityId, (degree.get(r.sourceEntityId) ?? 0) + 1);
    degree.set(r.targetEntityId, (degree.get(r.targetEntityId) ?? 0) + 1);
  }

  // Project to the viewer's compact shape — never emit embeddings.
  const entities = rawEntities.map((e) => ({
    id: e.id,
    slug: e.slug,
    entityType: e.entityType,
    label: e.label,
    summary: e.summary,
    properties: e.properties ?? {},
    provenance: e.provenance,
    degree: degree.get(e.id) ?? 0,
  }));

  const relationships = rawRelationships.map((r) => ({
    id: r.id,
    type: r.relationshipType,
    source: r.sourceEntityId,
    target: r.targetEntityId,
    properties: r.properties ?? {},
    bidirectional: !!r.bidirectional,
  }));

  const stats = manifest?.statistics ?? {};
  return {
    manifest: {
      repositoryId,
      label: manifest?.repository?.label,
      statistics: {
        entityCount: stats.entityCount ?? entities.length,
        relationshipCount: stats.relationshipCount ?? relationships.length,
        entityTypeBreakdown: stats.entityTypeBreakdown ?? {},
        relationshipTypeBreakdown: stats.relationshipTypeBreakdown ?? {},
      },
    },
    entities,
    relationships,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// On-demand (lazy) data layer — the live viewer loads degree-ranked hubs first,
// then expands as the user explores, instead of pulling the whole graph up front.
// ───────────────────────────────────────────────────────────────────────────

/** Coerce a Neo4j Integer / Gremlin number / plain number to a JS number. */
function toNum(v) {
  if (typeof v === 'number') return v;
  if (v && typeof v.toNumber === 'function') return v.toNumber();
  if (v && typeof v.low === 'number') return v.low;
  return Number(v) || 0;
}

/** Compact entity projection for the viewer — never includes embeddings. */
function projectEntity(e) {
  return {
    id: e.id,
    entityType: e.entityType,
    label: e.label,
    summary: e.summary,
    properties: e.properties ?? {},
    ...(e.degree !== undefined ? { degree: e.degree } : {}),
  };
}

const NEO4J_HUBS = `
  MATCH (n:_Entity {repositoryId: $rid})
  OPTIONAL MATCH (n)-[r {repositoryId: $rid}]-()
  WITH n, count(r) AS degree
  RETURN n.id AS vertexId, n.label AS entityLabel, n.entityType AS entityType, degree
  ORDER BY degree DESC
  LIMIT toInteger($lim)`;

const NEO4J_HUB_EDGES = `
  MATCH (a:_Entity {repositoryId: $rid})-[r {repositoryId: $rid}]-(b:_Entity {repositoryId: $rid})
  WHERE a.id IN $ids AND b.id IN $ids
  RETURN DISTINCT r.id AS edgeId, r.relationshipType AS type, r.sourceEntityId AS source, r.targetEntityId AS target`;

// Gremlin, lifted from the UCM GetGraphHubsCommand. deep-memory's Cosmos stores the label as
// `entityLabel`, so this matches the schema. bothE().count() is the degree.
const COSMOS_HUBS =
  "g.V().has('repositoryId', rid).has('entityType')" +
  ".project('vertexId','entityLabel','entityType','degree')" +
  ".by(id()).by(values('entityLabel')).by(values('entityType')).by(bothE().count())" +
  ".order().by(select('degree'), decr).limit(lim)";

function cosmosHubEdges(idParamNames) {
  return (
    "g.V().has('repositoryId', rid).has('entityType')" +
    `.has('id', P.within(${idParamNames}))` +
    '.bothE()' +
    `.where(otherV().has('repositoryId', rid).has('entityType').has('id', P.within(${idParamNames})))` +
    ".dedup().project('edgeId','type','source','target')" +
    '.by(id()).by(label()).by(outV().id()).by(inV().id())'
  );
}

/** Degree-ranked top-N entities + the edges among them + repo stats. Native query per provider. */
export async function getHubs(deepMemory, storage, storageSetting, repoCache, repositoryId, limit = 25) {
  const repo = await openRepo(deepMemory, repoCache, repositoryId);
  const lim = Math.max(1, Math.min(50, limit));
  let entities;
  let edges;

  if (storageSetting === 'neo4j') {
    const rows = await storage.executeNativeQuery(repositoryId, NEO4J_HUBS, { rid: repositoryId, lim });
    entities = rows.map((r) => ({ id: r.vertexId, entityType: r.entityType, label: r.entityLabel, degree: toNum(r.degree) }));
    edges = entities.length >= 2
      ? (await storage.executeNativeQuery(repositoryId, NEO4J_HUB_EDGES, { rid: repositoryId, ids: entities.map((e) => e.id) }))
          .map((r) => ({ id: r.edgeId, type: r.type, source: r.source, target: r.target }))
      : [];
  } else if (storageSetting === 'cosmosdb') {
    const rows = await storage.executeNativeQuery(repositoryId, COSMOS_HUBS, { rid: repositoryId, lim });
    entities = rows.map((r) => ({ id: r.vertexId, entityType: r.entityType, label: r.entityLabel, degree: toNum(r.degree) }));
    if (entities.length >= 2) {
      const ids = entities.map((e) => e.id);
      const idParamNames = ids.map((_, i) => `hid${i}`).join(', ');
      const bindings = { rid: repositoryId };
      ids.forEach((id, i) => { bindings[`hid${i}`] = id; });
      const rows2 = await storage.executeNativeQuery(repositoryId, cosmosHubEdges(idParamNames), bindings);
      edges = rows2.map((r) => ({ id: r.edgeId, type: r.type, source: r.source, target: r.target }));
    } else {
      edges = [];
    }
  } else {
    // Fallback for providers without a native hub query (memory / sqlserver): full read +
    // client-side top-N. Fine for the small graphs these back in practice.
    const payload = await buildGraphPayload(deepMemory, repositoryId);
    const top = [...payload.entities].sort((a, b) => b.degree - a.degree).slice(0, lim);
    const ids = new Set(top.map((e) => e.id));
    entities = top.map((e) => ({ id: e.id, entityType: e.entityType, label: e.label, degree: e.degree }));
    edges = payload.relationships
      .filter((r) => ids.has(r.source) && ids.has(r.target))
      .map((r) => ({ id: r.id, type: r.type, source: r.source, target: r.target }));
  }

  const stats = await repo.getStats();
  return { entities, edges, totalEntityCount: stats.entityCount, entityTypeCounts: stats.entityTypeBreakdown ?? {} };
}

/** Neighbourhood of one entity — the on-demand expansion. layers: [{ relType → { total, returned, entities } }]. */
export async function exploreEntity(deepMemory, repoCache, repositoryId, entityId, options = {}) {
  const repo = await openRepo(deepMemory, repoCache, repositoryId);
  const neighborhood = await repo.exploreNeighborhood(entityId, {
    depth: options.depth ?? 1,
    limitPerType: options.limitPerType ?? 10,
    detailLevel: 'summary',
  });
  return {
    center: neighborhood.center,
    layers: neighborhood.layers.map((layer) => {
      const out = {};
      for (const [relType, group] of Object.entries(layer)) {
        out[relType] = { total: group.total, returned: group.returned, entities: group.entities.map(projectEntity) };
      }
      return out;
    }),
    statistics: neighborhood.statistics,
  };
}

/** Search by label, or page entities of a type — drives search + the type drill-down. */
export async function findEntitiesPage(deepMemory, repoCache, repositoryId, { searchTerm, entityTypes, limit = 25, offset = 0 } = {}) {
  const repo = await openRepo(deepMemory, repoCache, repositoryId);
  const result = await repo.findEntities({
    ...(searchTerm ? { searchTerm } : {}),
    ...(entityTypes && entityTypes.length ? { entityTypes } : {}),
    limit,
    offset,
    detailLevel: 'summary',
  });
  return {
    items: result.items.map(projectEntity),
    total: result.total,
    hasMore: result.hasMore,
    limit: result.limit,
    offset: result.offset,
  };
}

/** Full detail for one entity — drives the detail panel. */
export async function getEntityDetail(deepMemory, repoCache, repositoryId, entityId, detailLevel = 'full') {
  const repo = await openRepo(deepMemory, repoCache, repositoryId);
  const e = await repo.getEntity(entityId, detailLevel);
  if (!e) return null;
  return {
    id: e.id,
    slug: e.slug,
    entityType: e.entityType,
    label: e.label,
    summary: e.summary,
    properties: e.properties ?? {},
    provenance: e.provenance,
  };
}
