// Query plans of the repository-scoped relationship and drain statements (live).
//
// A relationship id must be unique across every type in a repository, and
// Neo4j relationship indexes cover one type only, so the id checks in
// `createRelationship` and the upsert import template, the lookups and
// deletes by relationship id, and the batched drains of `deleteRepository` /
// `deleteAllContents` and the `getRepositoryStats` counts are anchored on
// the repository's entities. The anchor must reach them through the
// `(repositoryId, id)` unique index; a plan that scans every `_Entity` in
// the database, or every relationship, makes each call pay for every
// repository in the store. The write-token read-backs that answer a re-run of
// a committed create are held to the same rule, and a create with an
// engine-minted id must not expand the repository's edges at all.
// Statements that refuse a deleted repository — writes, entity and
// relationship reads, page counts, type deletes and compiled traversals —
// check its marker through the marker's unique constraint index, and the
// entity reads they guard keep to the entity indexes. The vocabulary write
// and the change-log reads and drain reach the change log through its
// `(repositoryId, changeId)` constraint index, and the vocabulary read,
// write and outcome read reach the vocabulary node through its
// `repositoryId` index. EXPLAIN plans the
// statements without running them, so this checks the operators the server
// would use.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jConnection } from './Neo4jConnection.js';
import {
  buildCreateMintedRelationshipQuery,
  buildCreateRelationshipQuery,
  buildDeleteRelationshipsByTypeQuery,
  buildEntityRelationshipQueries,
  RELATIONSHIP_DELETE_MANY_QUERY,
  RELATIONSHIP_GET_QUERY,
  RELATIONSHIP_WRITE_ATTEMPT_QUERY,
} from './queries/relationship.js';
import {
  CHANGE_LOG_DRAIN_QUERY,
  ENTITY_DRAIN_QUERY,
  RELATIONSHIP_DRAIN_QUERY,
  REPOSITORY_MARKER_EXISTS_QUERY,
} from './queries/repositoryDrain.js';
import { ENTITY_STATS_QUERY, RELATIONSHIP_STATS_QUERY } from './queries/repository.js';
import {
  buildFindCountQuery,
  buildFindEntitiesWhere,
  buildMatchFindQuery,
  ENTITY_DELETE_BY_TYPE_QUERY,
  ENTITY_DELETE_MANY_QUERY,
  ENTITY_GET_BY_SLUG_QUERY_LIGHT,
  ENTITY_GET_MANY_QUERY_LIGHT,
  ENTITY_GET_QUERY_LIGHT,
  UPDATE_ENTITY_MATCH,
} from './queries/entity.js';
import { TIMELINE_QUERY } from './queries/timeline.js';
import {
  VOCABULARY_CHANGE_LOG_COUNT_QUERY,
  VOCABULARY_CHANGE_LOG_PAGE_QUERY,
  VOCABULARY_READ_QUERY,
  VOCABULARY_SAVE_OUTCOME_QUERY,
  VOCABULARY_SAVE_QUERY,
} from './queries/vocabulary.js';
import { getSchemaCypher } from './schema.js';
import { Neo4jTraversalExecutor } from './Neo4jTraversalExecutor.js';
import type { MemoryVocabulary, TraversalSpec } from '@utaba/deep-memory/types';
import {
  buildInsertRelationshipsQuery,
  buildUpsertRelationshipsQuery,
  ENTITY_WRITE_ATTEMPT_COUNT_QUERY,
  ENTITY_WRITE_ATTEMPTS_QUERY,
} from './queries/bulk.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

/** Operators that visit every node of a label, or every relationship (of a type), in the database. */
const WHOLE_STORE_SCANS = [
  'NodeByLabelScan',
  'AllNodesScan',
  'AllRelationshipsScan',
  'DirectedAllRelationshipsScan',
  'UndirectedAllRelationshipsScan',
  'RelationshipTypeScan',
  'DirectedRelationshipTypeScan',
  'UndirectedRelationshipTypeScan',
];

interface PlanNode {
  operatorType: string;
  arguments?: Record<string, unknown>;
  children?: PlanNode[];
}

/** Every operator in the plan, with its details, depth first. */
function operators(plan: PlanNode): string[] {
  const details = plan.arguments?.['Details'];
  const own = `${plan.operatorType}${typeof details === 'string' ? ` [${details}]` : ''}`;
  return [own, ...(plan.children ?? []).flatMap(operators)];
}

/** Strip the `@database` suffix the server appends to operator names. */
function operatorName(op: string): string {
  return op.split(/[@\s[(]/, 1)[0] ?? op;
}

/** Operators that consume all of their input before producing a row. */
const BLOCKING_OPERATORS = ['Eager', 'EagerAggregation', 'Sort', 'Top', 'PartialSort', 'PartialTop'];

/** The plan nodes from `plan` down to the first node `isTarget` accepts, depth first. */
function pathTo(plan: PlanNode, isTarget: (node: PlanNode) => boolean): PlanNode[] | undefined {
  if (isTarget(plan)) return [plan];
  for (const child of plan.children ?? []) {
    const path = pathTo(child, isTarget);
    if (path !== undefined) return [plan, ...path];
  }
  return undefined;
}

function nodeDetails(node: PlanNode): string {
  const details = node.arguments?.['Details'];
  return typeof details === 'string' ? details : '';
}

/** Provenance parameters of a single create, bound so the plan compiles without warnings. */
const PROVENANCE_PARAMS = {
  createdBy: 'plan-check',
  createdByType: 'agent',
  createdAt: '2026-01-01T00:00:00.000Z',
  createdInConversation: null,
  createdFromMessage: null,
  modifiedBy: 'plan-check',
  modifiedByType: 'agent',
  modifiedAt: '2026-01-01T00:00:00.000Z',
  modifiedInConversation: null,
  modifiedFromMessage: null,
};

/** Compile-time vocabulary for the traversal plans; these specs name no types. */
const PLAN_VOCABULARY: MemoryVocabulary = {
  version: '1.0.0',
  lastModified: '',
  modifiedBy: '',
  entityTypes: [],
  relationshipTypes: [],
};

const ROW = {
  id: 'plan-r1',
  relationshipType: 'KNOWS',
  sourceEntityId: 'plan-a',
  targetEntityId: 'plan-b',
};

if (NEO4J_URI) {
  describe('repository-scoped relationship statements — query plans (live)', () => {
    let conn: Neo4jConnection;

    beforeAll(async () => {
      conn = new Neo4jConnection({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
      // The plans depend on the schema's indexes; every statement is idempotent.
      for (const statement of getSchemaCypher()) await conn.executeSystemDdl(statement);
      // A new index is planned only once it is online.
      await conn.executeSystemDdl('CALL db.awaitIndexes(60)');
    });

    afterAll(async () => {
      await conn.close();
    });

    async function explain(cypher: string, params: Record<string, unknown>): Promise<string[]> {
      const result = await conn.executeQuery(`EXPLAIN ${cypher}`, params, { repositoryId: 'plan-check' });
      const plan = result.summary.plan;
      expect(plan).not.toBe(false);
      return operators(plan as PlanNode);
    }

    function expectIndexAnchoredPlan(ops: string[]): void {
      const names = ops.map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
      expect(
        ops.some((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_Entity(repositoryId, id)') && op.includes('IS NOT NULL')),
      ).toBe(true);
    }

    it('createRelationship seeks the entity index for its id check', async () => {
      const ops = await explain(buildCreateRelationshipQuery('KNOWS'), {
        ...ROW,
        ...PROVENANCE_PARAMS,
        writeAttempt: 'plan-token',
        properties: '{}',
        bidirectional: false,
      });
      expectIndexAnchoredPlan(ops);
    });

    it('the upsert import template seeks the entity index for its id check', async () => {
      const ops = await explain(buildUpsertRelationshipsQuery('KNOWS'), { rows: [ROW], ids: [ROW.id] });
      expectIndexAnchoredPlan(ops);
    });

    it('the insert import template scans nothing store-wide', async () => {
      const names = (await explain(buildInsertRelationshipsQuery('KNOWS'), { rows: [ROW], writeAttempt: 'plan-token' })).map(
        operatorName,
      );
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
    });

    /** No whole-store scan, and a unique-index seek of the repository's entity by id. */
    function expectEntityIdSeek(ops: string[]): void {
      const names = ops.map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
      expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_Entity(repositoryId, id)'))).toBe(true);
    }

    it('the relationship write-token read-back seeks its source entity by id', async () => {
      expectEntityIdSeek(await explain(RELATIONSHIP_WRITE_ATTEMPT_QUERY, { id: ROW.id, sourceEntityId: ROW.sourceEntityId }));
    });

    it('the insert import entity token count seeks each id in the entity index', async () => {
      expectEntityIdSeek(await explain(ENTITY_WRITE_ATTEMPT_COUNT_QUERY, { ids: ['plan-a', 'plan-b'], writeAttempt: 'plan-token' }));
    });

    it('the insert import fallback token read seeks each id in the entity index', async () => {
      expectEntityIdSeek(await explain(ENTITY_WRITE_ATTEMPTS_QUERY, { ids: ['plan-a', 'plan-b'] }));
    });

    it('getRelationship seeks the entity index for its anchor', async () => {
      expectIndexAnchoredPlan(await explain(RELATIONSHIP_GET_QUERY, { relId: ROW.id }));
    });

    it('deleteRelationship and deleteRelationships seek the entity index for their anchor', async () => {
      expectIndexAnchoredPlan(await explain(RELATIONSHIP_DELETE_MANY_QUERY, { ids: [ROW.id, 'plan-r2'] }));
    });

    /** A seek of the repository marker's unique constraint index. */
    function expectMarkerSeek(ops: string[]): void {
      expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_Repository(repositoryId)'))).toBe(true);
    }

    it('deleteRelationships checks the repository marker through its constraint index', async () => {
      expectMarkerSeek(await explain(RELATIONSHIP_DELETE_MANY_QUERY, { ids: [ROW.id, 'plan-r2'] }));
    });

    it('deleteEntities seeks the marker and each entity by id', async () => {
      const ops = await explain(ENTITY_DELETE_MANY_QUERY, { ids: ['plan-a', 'plan-b'] });
      expectEntityIdSeek(ops);
      expectMarkerSeek(ops);
    });

    it('updateEntity seeks the marker and the entity by id', async () => {
      const ops = await explain(
        `${UPDATE_ENTITY_MATCH} SET n.label = $label RETURN repo IS NOT NULL AS repositoryExists, n.id AS id`,
        { id: 'plan-a', label: 'plan' },
      );
      expectEntityIdSeek(ops);
      expectMarkerSeek(ops);
    });

    /** A seek of the vocabulary's `repositoryId` index, and no scan of any label (`_Vocabulary` included). */
    function expectVocabularySeek(ops: string[]): void {
      expectNoWholeStoreScan(ops);
      expect(ops.some((op) => op.startsWith('NodeIndexSeek') && op.includes(':_Vocabulary(repositoryId)'))).toBe(true);
    }

    it('getVocabulary seeks the repository marker and the vocabulary through their indexes', async () => {
      const ops = await explain(VOCABULARY_READ_QUERY, {});
      expectVocabularySeek(ops);
      expectMarkerSeek(ops);
    });

    /** The plan of a batched drain; `IN TRANSACTIONS` plans only on an auto-commit session. */
    async function drainPlan(cypher: string, params: Record<string, unknown> = {}): Promise<PlanNode> {
      const { summary } = await conn.executeImplicitInTransactions(
        `EXPLAIN ${cypher}`,
        { batchSize: 500n, edgeCap: 10_000n, after: '', ...params },
        { repositoryId: 'plan-check' },
      );
      expect(summary.plan).not.toBe(false);
      return summary.plan as PlanNode;
    }

    /**
     * A keyset batch over the repository's entities: a range seek of the
     * `(repositoryId, id)` index after `$after`, read in index order and
     * stopped at `$batchSize`, with no whole-store scan.
     */
    function expectCursorSeekInIndexOrder(plan: PlanNode): void {
      const names = operators(plan).map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
      // Each batch reads only the entries past the cursor: a range seek of
      // the (repositoryId, id) index, read in index order, so no operator
      // sorts the repository's remaining entities to find the next batch.
      for (const sort of ['Sort', 'Top', 'PartialSort', 'PartialTop']) expect(names).not.toContain(sort);
      const path = pathTo(
        plan,
        (node) =>
          operatorName(node.operatorType) === 'NodeUniqueIndexSeek' &&
          nodeDetails(node).includes(':_Entity(repositoryId, id)') &&
          nodeDetails(node).includes('id > $after'),
      );
      expect(path).toBeDefined();
      // The seek stops at the batch limit only when the limit pulls rows from
      // it directly: a blocking operator between them would read every entry
      // past the cursor before the limit applied.
      const seekPath = path ?? [];
      const limitAt = seekPath.map((node) => operatorName(node.operatorType)).lastIndexOf('Limit');
      expect(limitAt).toBeGreaterThanOrEqual(0);
      expect(nodeDetails(seekPath[limitAt]!)).toContain('$batchSize');
      const between = seekPath.slice(limitAt + 1, -1).map((node) => operatorName(node.operatorType));
      for (const blocking of BLOCKING_OPERATORS) expect(between).not.toContain(blocking);
    }

    it('the relationship drain range-seeks the entity index after its cursor, in index order', async () => {
      expectCursorSeekInIndexOrder(await drainPlan(RELATIONSHIP_DRAIN_QUERY));
    });

    it('the entity drain seeks the entity index rather than scanning the label', async () => {
      expectIndexAnchoredPlan(operators(await drainPlan(ENTITY_DRAIN_QUERY)));
    });

    /** A seek of the change log's `(repositoryId, changeId)` constraint index, and no scan of the label. */
    function expectChangeLogSeek(ops: string[]): void {
      expect(
        ops.some((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_VocabularyChangeLog(repositoryId, changeId)')),
      ).toBe(true);
      expect(ops.some((op) => op.startsWith('NodeByLabelScan') && op.includes(':_VocabularyChangeLog'))).toBe(false);
    }

    it('the change-log drain seeks the change-log constraint index rather than scanning the label', async () => {
      const ops = operators(await drainPlan(CHANGE_LOG_DRAIN_QUERY));
      expectChangeLogSeek(ops);
      expect(ops.find((op) => op.startsWith('NodeUniqueIndexSeek'))).toContain('IS NOT NULL');
    });

    it('getRepositoryStats counts entities through the entity index', async () => {
      expectIndexAnchoredPlan(await explain(ENTITY_STATS_QUERY, {}));
    });

    it('getRepositoryStats counts relationships from the entity index anchor', async () => {
      expectIndexAnchoredPlan(await explain(RELATIONSHIP_STATS_QUERY, {}));
    });

    it('the deleteAllContents marker check seeks the repository constraint index', async () => {
      const ops = await explain(REPOSITORY_MARKER_EXISTS_QUERY, {});
      const names = ops.map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
      expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_Repository(repositoryId)'))).toBe(true);
    });

    it('a create with a minted id seeks its two endpoints and expands no repository edges', async () => {
      const ops = await explain(buildCreateMintedRelationshipQuery('KNOWS'), {
        ...ROW,
        ...PROVENANCE_PARAMS,
        properties: '{}',
        bidirectional: false,
        writeAttempt: 'plan-token',
      });
      const names = ops.map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
      // The endpoints are seeks by id; nothing anchors on the repository's
      // entities as a whole (the `IS NOT NULL` seek the id check uses).
      const entitySeeks = ops.filter((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_Entity(repositoryId, id)'));
      expect(entitySeeks.length).toBeGreaterThanOrEqual(2);
      expect(entitySeeks.some((op) => op.includes('IS NOT NULL'))).toBe(false);
      // The only relationship lookup is the MERGE's, between the bound endpoints.
      const expands = ops.filter((op) => op.startsWith('Expand'));
      expect(expands.length).toBeGreaterThan(0);
      for (const op of expands) {
        expect(op.startsWith('Expand(Into)')).toBe(true);
        expect(op).toContain('(s)-[r:KNOWS]->(t)');
      }
    });

    // ─── Reads, type deletes and traversals that refuse a deleted repository ───

    /** No whole-store scan of any kind. */
    function expectNoWholeStoreScan(ops: string[]): void {
      const names = ops.map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
    }

    it('getEntity seeks the marker and the entity by id', async () => {
      const ops = await explain(ENTITY_GET_QUERY_LIGHT, { id: 'plan-a' });
      expectEntityIdSeek(ops);
      expectMarkerSeek(ops);
    });

    it('getEntityBySlug seeks the marker and the entity by slug', async () => {
      const ops = await explain(ENTITY_GET_BY_SLUG_QUERY_LIGHT, { slug: 'thing:plan-a' });
      expectNoWholeStoreScan(ops);
      expectMarkerSeek(ops);
      expect(ops.some((op) => op.startsWith('NodeUniqueIndexSeek') && op.includes(':_Entity(repositoryId, slug)'))).toBe(true);
    });

    it('getEntities seeks the marker and each entity by id', async () => {
      const ops = await explain(ENTITY_GET_MANY_QUERY_LIGHT, { ids: ['plan-a', 'plan-b'] });
      expectEntityIdSeek(ops);
      expectMarkerSeek(ops);
    });

    it('findEntities without filters reads the entity index for its page and its count', async () => {
      const where = buildFindEntitiesWhere({ limit: 10, offset: 0 }, { alias: 'n', includeRepositoryPredicate: true });
      const page = await explain(buildMatchFindQuery(where.cypherWhere, 'n.id AS id'), { skip: 0n, limit: 10n });
      expectIndexAnchoredPlan(page);
      const count = await explain(buildFindCountQuery(`MATCH (n:_Entity) ${where.cypherWhere}`, 'n'), {});
      expectIndexAnchoredPlan(count);
      expectMarkerSeek(count);
    });

    it('findEntities with a type filter reads an entity index for its page and its count', async () => {
      const where = buildFindEntitiesWhere(
        { limit: 10, offset: 0, entityTypes: ['thing'] },
        { alias: 'n', includeRepositoryPredicate: true },
      );
      const page = await explain(buildMatchFindQuery(where.cypherWhere, 'n.id AS id'), { ...where.params, skip: 0n, limit: 10n });
      const count = await explain(buildFindCountQuery(`MATCH (n:_Entity) ${where.cypherWhere}`, 'n'), where.params);
      for (const ops of [page, count]) {
        expectNoWholeStoreScan(ops);
        expect(ops.some((op) => /^Node(Unique)?IndexSeek/.test(op) && op.includes(':_Entity(repositoryId, '))).toBe(true);
      }
      expectMarkerSeek(count);
    });

    it('findEntities with property filters only reads the entity index for its page and its count', async () => {
      const where = buildFindEntitiesWhere(
        { limit: 10, offset: 0, properties: { colour: 'red' } },
        { alias: 'n', includeRepositoryPredicate: true },
      );
      const page = await explain(buildMatchFindQuery(where.cypherWhere, 'n.id AS id'), { ...where.params, skip: 0n, limit: 10n });
      const count = await explain(buildFindCountQuery(`MATCH (n:_Entity) ${where.cypherWhere}`, 'n'), where.params);
      for (const ops of [page, count]) {
        expectNoWholeStoreScan(ops);
        expect(ops.some((op) => /^Node(Unique)?IndexSeek/.test(op) && op.includes(':_Entity(repositoryId, '))).toBe(true);
      }
      expectMarkerSeek(count);
    });

    it('findEntities with a search term counts through the fulltext index and seeks the marker', async () => {
      const ops = await explain(
        buildFindCountQuery(
          "CALL db.index.fulltext.queryNodes('dm_entity_text', $term) YIELD node WHERE node.repositoryId = $rid",
          'node',
        ),
        { term: 'plan' },
      );
      expectNoWholeStoreScan(ops);
      expectMarkerSeek(ops);
    });

    it('getRelationship checks the repository marker through its constraint index', async () => {
      expectMarkerSeek(await explain(RELATIONSHIP_GET_QUERY, { relId: ROW.id }));
    });

    for (const direction of ['both', 'out', 'in'] as const) {
      it(`getEntityRelationships (${direction}) seeks the marker and the entity by id`, async () => {
        const { dataCypher, countCypher } = buildEntityRelationshipQueries(direction, ' WHERE type(r) IN $relTypes');
        const params = { eid: 'plan-a', relTypes: ['KNOWS'], offset: 0n, limit: 10n };
        const data = await explain(dataCypher, params);
        expectEntityIdSeek(data);
        expectMarkerSeek(data);
        expectEntityIdSeek(await explain(countCypher, params));
      });

      it(`getEntityRelationships (${direction}) without a type filter seeks the marker and the entity by id`, async () => {
        const { dataCypher, countCypher } = buildEntityRelationshipQueries(direction, '');
        const params = { eid: 'plan-a', offset: 0n, limit: 10n };
        const data = await explain(dataCypher, params);
        expectEntityIdSeek(data);
        expectMarkerSeek(data);
        expectEntityIdSeek(await explain(countCypher, params));
      });
    }

    it('a deleteEntitiesByType batch seeks the marker and the entity type index, and expands the edges from the batch', async () => {
      const ops = operators(await drainPlan(ENTITY_DELETE_BY_TYPE_QUERY, { entityType: 'thing' }));
      expectNoWholeStoreScan(ops);
      expectMarkerSeek(ops);
      expect(ops.some((op) => op.startsWith('NodeIndexSeek') && op.includes(':_Entity(repositoryId, entityType)'))).toBe(true);
      expect(ops.map(operatorName)).toContain('Expand');
    });

    it('a deleteRelationshipsByType batch seeks the marker and range-seeks the entity index after its cursor', async () => {
      const plan = await drainPlan(buildDeleteRelationshipsByTypeQuery('KNOWS'));
      expectCursorSeekInIndexOrder(plan);
      expectMarkerSeek(operators(plan));
    });

    /** No scan of every node in the database, and none of the repository's entities. */
    function expectNoNodeScan(ops: string[]): void {
      const names = ops.map(operatorName);
      for (const scan of ['AllNodesScan', 'AllRelationshipsScan']) expect(names).not.toContain(scan);
      expect(ops.some((op) => op.startsWith('NodeByLabelScan') && op.includes(':_Entity'))).toBe(false);
    }

    it('getVocabularyChangeLog counts through the change-log index after a seek of the repository marker', async () => {
      const ops = await explain(VOCABULARY_CHANGE_LOG_COUNT_QUERY, {});
      expectNoNodeScan(ops);
      expectMarkerSeek(ops);
      expectChangeLogSeek(ops);
    });

    it('getVocabularyChangeLog pages through the change-log index', async () => {
      const ops = await explain(VOCABULARY_CHANGE_LOG_PAGE_QUERY, { offset: 0n, limit: 10n });
      expectNoNodeScan(ops);
      expectChangeLogSeek(ops);
    });

    it('saveVocabulary locks the marker, seeks the vocabulary and merges its change record, each through its index', async () => {
      const ops = await explain(VOCABULARY_SAVE_QUERY, {
        expectedVersion: '1.0.0',
        json: '{}',
        newVersion: '1.1.0',
        change: { changeId: 'plan-change', changeType: 'entity_type_added', typeName: 'thing' },
      });
      expectVocabularySeek(ops);
      expectMarkerSeek(ops);
      expectChangeLogSeek(ops);
    });

    it('the saveVocabulary outcome read seeks the repository marker and the vocabulary through their indexes', async () => {
      const ops = await explain(VOCABULARY_SAVE_OUTCOME_QUERY, {});
      expectVocabularySeek(ops);
      expectMarkerSeek(ops);
    });

    it('getTimeline seeks the marker and the centre entity by id', async () => {
      const ops = await explain(TIMELINE_QUERY, { id: 'plan-a' });
      expectEntityIdSeek(ops);
      expectMarkerSeek(ops);
    });

    /** The statement and parameters the traversal executor ships for a spec. */
    async function shippedTraversal(spec: TraversalSpec): Promise<{ cypher: string; params: Record<string, unknown> }> {
      let shipped: { cypher: string; params: Record<string, unknown> } | undefined;
      const recorder = {
        executeQuery: async (cypher: string, params: Record<string, unknown>) => {
          shipped = { cypher, params };
          return {
            records: [{ keys: ['dm-repository-exists'], get: (key: string) => key === 'dm-repository-exists' }],
            summary: {},
          };
        },
      } as unknown as Neo4jConnection;
      await new Neo4jTraversalExecutor(recorder, { profileTraversals: false }).execute('plan-check', spec, PLAN_VOCABULARY);
      if (shipped === undefined) throw new Error('the executor shipped no statement');
      return shipped;
    }

    const TRAVERSAL_SPECS: Array<[string, TraversalSpec]> = [
      ['traverse (terminal)', { start: { entityId: 'plan-a' }, steps: [{ direction: 'out' }], returnMode: 'terminal' }],
      [
        'exploreNeighborhood (all, two steps)',
        { start: { entityId: 'plan-a' }, steps: [{ direction: 'both' }, { direction: 'both' }], returnMode: 'all', limit: 10_000 },
      ],
      [
        'findPaths (path, variable length)',
        {
          start: { entityId: 'plan-a' },
          steps: [{ direction: 'both', repeat: { maxDepth: 3, emitIntermediates: true } }],
          returnMode: 'path',
        },
      ],
      [
        'traverse with a count projection',
        {
          start: { entityId: 'plan-a' },
          steps: [{ direction: 'out' }],
          returnMode: 'terminal',
          projection: { properties: ['colour'], mode: 'count' },
        },
      ],
    ];

    for (const [name, spec] of TRAVERSAL_SPECS) {
      it(`${name} seeks the marker and the start entity by id in one statement`, async () => {
        const { cypher, params } = await shippedTraversal(spec);
        const result = await conn.executeQuery(`EXPLAIN ${cypher}`, params, { repositoryId: 'plan-check' });
        expect(result.summary.plan).not.toBe(false);
        const ops = operators(result.summary.plan as PlanNode);
        expectEntityIdSeek(ops);
        expectMarkerSeek(ops);
      });
    }
  });
} else {
  describe('repository-scoped relationship statements — query plans', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
