// Bulk export/import Gremlin queries — optimized for throughput
//
// Import optimizations:
//   1. Parallel execution with concurrency limiter (avoids sequential round-trips)
//   2. Direct addV/addE when skipExistenceCheck is true (no existence query needed)
//   3. Gremlin coalesce pattern for atomic upserts when existence checks are needed
//      (1 query instead of 2)
//
// Export optimizations:
//   1. Cursor-based pagination using ID ordering instead of offset-based range()
//      (avoids O(n²) scan on large repositories)
//
// `valueMap(true)` exception: this is the one read path that intentionally
// keeps it. Export must include every stored property — including the
// embedding — so a re-import is field-for-field faithful. Do not migrate to
// the project-chain helpers used elsewhere; they strip fields the import path
// expects.

import type { CosmosDbConnection } from '../CosmosDbConnection.js';
import type { ExportChunk, ImportChunk, BulkImportOptions } from '@utaba/deep-memory/types';
import type { BulkImportResult, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import {
  buildEntityPropertyLadder,
  buildRelationshipPropertyLadder,
  entityFromGremlin,
  entityToLadderBindings,
  relationshipFromGremlin,
  relationshipToLadderBindings,
} from '../mapping.js';
import { resolveController, runAdaptive } from './adaptive-import.js';

const EXPORT_BATCH_SIZE = 100;

// ─── Export ──────────────────────────────────────────────────────

export async function* exportAll(
  conn: CosmosDbConnection,
  repositoryId: string,
): AsyncIterable<ExportChunk> {
  let sequence = 0;

  // Export entities using cursor-based pagination (ordered by id)
  let cursor = '';
  while (true) {
    const result = cursor === ''
      ? await conn.submit(
          "g.V().has('repositoryId', rid).has('entityType').order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, batchSize: EXPORT_BATCH_SIZE },
        )
      : await conn.submit(
          "g.V().has('repositoryId', rid).has('entityType').has('id', gt(cursor)).order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, cursor, batchSize: EXPORT_BATCH_SIZE },
        );

    const entities = (result.items as Record<string, unknown>[]).map(entityFromGremlin);
    const isLast = entities.length < EXPORT_BATCH_SIZE;

    if (entities.length > 0) {
      cursor = entities[entities.length - 1]!.id;
      yield {
        type: 'entities',
        data: entities,
        sequence: sequence++,
        isLast,
      };
    }

    if (isLast) break;
  }

  // Export relationships using cursor-based pagination (ordered by id)
  cursor = '';
  while (true) {
    const result = cursor === ''
      ? await conn.submit(
          "g.E().has('repositoryId', rid).order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, batchSize: EXPORT_BATCH_SIZE },
        )
      : await conn.submit(
          "g.E().has('repositoryId', rid).has('id', gt(cursor)).order().by('id').limit(batchSize).valueMap(true)",
          { rid: repositoryId, cursor, batchSize: EXPORT_BATCH_SIZE },
        );

    const relationships = (result.items as Record<string, unknown>[]).map(relationshipFromGremlin);
    const isLast = relationships.length < EXPORT_BATCH_SIZE;

    if (relationships.length > 0) {
      cursor = relationships[relationships.length - 1]!.id;
      yield {
        type: 'relationships',
        data: relationships,
        sequence: sequence++,
        isLast,
      };
    }

    if (isLast) break;
  }

  // If nothing was yielded, yield an empty final chunk
  if (sequence === 0) {
    yield {
      type: 'entities',
      data: [],
      sequence: 0,
      isLast: true,
    };
  }
}

// ─── Import ─────────────────────────────────────────────────────

export async function importBulk(
  conn: CosmosDbConnection,
  repositoryId: string,
  data: ImportChunk[],
  options?: BulkImportOptions,
): Promise<BulkImportResult> {
  let entitiesImported = 0;
  let relationshipsImported = 0;
  const errors: Array<{ item: string; error: string }> = [];
  const skipCheck = options?.skipExistenceCheck ?? false;

  // Resolve the controller from the caller-supplied handle if any, so the
  // controller's learned state (concurrency level, success streak, cooldown,
  // soft ceiling) carries across multiple importBulk calls within a single
  // import operation. Without a handle, each importBulk call gets a fresh
  // controller — fine for single-shot usage but wrong for streaming imports
  // that issue one importBulk call per chunk. RepositoryImporter creates a
  // handle per import and threads it through automatically.
  const controller = resolveController(options?.adaptiveConcurrency, options?.adaptiveConcurrencyHandle);

  for (const chunk of data) {
    if (chunk.entities && chunk.entities.length > 0) {
      const results = await runAdaptive(
        chunk.entities,
        controller,
        async (entity): Promise<{ ok: boolean; id: string; error?: string }> => {
          try {
            if (skipCheck) {
              await insertEntity(conn, repositoryId, entity);
            } else {
              await upsertEntity(conn, repositoryId, entity);
            }
            return { ok: true, id: entity.id };
          } catch (err: unknown) {
            return {
              ok: false,
              id: entity.id,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      );

      for (const r of results) {
        if (r.ok) {
          entitiesImported++;
        } else {
          errors.push({ item: `entity:${r.id}`, error: r.error! });
        }
      }
    }

    if (chunk.relationships && chunk.relationships.length > 0) {
      const results = await runAdaptive(
        chunk.relationships,
        controller,
        async (rel): Promise<{ ok: boolean; id: string; error?: string }> => {
          try {
            if (skipCheck) {
              await insertRelationship(conn, repositoryId, rel);
            } else {
              await upsertRelationship(conn, repositoryId, rel);
            }
            return { ok: true, id: rel.id };
          } catch (err: unknown) {
            return {
              ok: false,
              id: rel.id,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        },
      );

      for (const r of results) {
        if (r.ok) {
          relationshipsImported++;
        } else {
          errors.push({ item: `relationship:${r.id}`, error: r.error! });
        }
      }
    }
  }

  return { entitiesImported, relationshipsImported, errors };
}

// ─── Fixed-shape query templates ─────────────────────────────────
//
// Same Gremlin string across every entity/relationship write regardless of
// which optional fields are populated, so the Cosmos plan cache reuses one
// compiled plan. Computed once at module load. The upsert update branch
// reuses the SAME ladder as the create branch — Cosmos already rejects
// `.property('repositoryId', ...)` after `unfold()`, and the ladder excludes
// `id` and `repositoryId` (both written explicitly only on the create branch).

const ENTITY_LADDER_CHAIN = buildEntityPropertyLadder();
const RELATIONSHIP_LADDER_CHAIN = buildRelationshipPropertyLadder();

const INSERT_ENTITY_QUERY =
  `g.addV(vertexLabel).property('id', vid).property('repositoryId', rid)${ENTITY_LADDER_CHAIN}`;

const INSERT_RELATIONSHIP_QUERY =
  `g.V().has('repositoryId', rid).hasId(srcId).has('entityType')` +
  `.addE(edgeLabel)` +
  `.to(g.V().has('repositoryId', rid).hasId(tgtId).has('entityType'))` +
  `.property('id', relId).property('repositoryId', rid)${RELATIONSHIP_LADDER_CHAIN}`;

const UPSERT_ENTITY_QUERY =
  `g.V().has('repositoryId', rid).hasId(vid).has('entityType').fold().coalesce(` +
  `unfold()${ENTITY_LADDER_CHAIN},` +
  ` addV(vertexLabel).property('id', vid).property('repositoryId', rid)${ENTITY_LADDER_CHAIN})`;

const UPSERT_RELATIONSHIP_QUERY =
  `g.E().has('repositoryId', rid).hasId(relId).fold().coalesce(` +
  `unfold()${RELATIONSHIP_LADDER_CHAIN},` +
  ` g.V().has('repositoryId', rid).hasId(srcId).has('entityType').addE(edgeLabel)` +
  `.to(g.V().has('repositoryId', rid).hasId(tgtId).has('entityType'))` +
  `.property('id', relId).property('repositoryId', rid)${RELATIONSHIP_LADDER_CHAIN})`;

// ─── Direct insert (no existence check) ─────────────────────────

/** Insert an entity directly — assumes it does not exist. */
async function insertEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entity: StoredEntity,
): Promise<void> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    vid: entity.id,
    vertexLabel: entity.entityType,
    ...entityToLadderBindings(entity),
  };
  await conn.submit(INSERT_ENTITY_QUERY, bindings);
}

/** Insert a relationship directly — assumes it does not exist. */
async function insertRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  rel: StoredRelationship,
): Promise<void> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    relId: rel.id,
    srcId: rel.sourceEntityId,
    tgtId: rel.targetEntityId,
    edgeLabel: rel.relationshipType,
    ...relationshipToLadderBindings(rel),
  };
  await conn.submit(INSERT_RELATIONSHIP_QUERY, bindings);
}

// ─── Atomic upsert (single query with coalesce) ─────────────────

/**
 * Upsert an entity using Gremlin's coalesce pattern — single query.
 * Replaces the old 2-query check-then-create/update approach.
 *
 * Both branches share the same fixed-shape entity ladder (which omits `id`
 * and `repositoryId`). The create branch prepends `.property('id',
 * vid).property('repositoryId', rid)` to addV; the update branch (after
 * `unfold`) relies on those system properties already being set. Cosmos
 * rejects `.property('repositoryId', ...)` after `unfold()` at parse time,
 * so excluding `repositoryId` from the ladder is required for correctness
 * as well as plan-cache shape.
 */
async function upsertEntity(
  conn: CosmosDbConnection,
  repositoryId: string,
  entity: StoredEntity,
): Promise<void> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    vid: entity.id,
    vertexLabel: entity.entityType,
    ...entityToLadderBindings(entity),
  };
  await conn.submit(UPSERT_ENTITY_QUERY, bindings);
}

/**
 * Upsert a relationship using Gremlin's coalesce pattern — single query.
 * Replaces the old 2-query check-then-create/update approach.
 *
 * The E() lookup is scoped by repositoryId so an edge with the same id in a
 * different repo cannot be matched and silently overwritten.
 */
async function upsertRelationship(
  conn: CosmosDbConnection,
  repositoryId: string,
  rel: StoredRelationship,
): Promise<void> {
  const bindings: Record<string, unknown> = {
    rid: repositoryId,
    relId: rel.id,
    srcId: rel.sourceEntityId,
    tgtId: rel.targetEntityId,
    edgeLabel: rel.relationshipType,
    ...relationshipToLadderBindings(rel),
  };
  await conn.submit(UPSERT_RELATIONSHIP_QUERY, bindings);
}
