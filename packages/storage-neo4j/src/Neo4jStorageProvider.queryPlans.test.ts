// Query plans of the repository-scoped relationship and drain statements (live).
//
// A relationship id must be unique across every type in a repository, and
// Neo4j relationship indexes cover one type only, so the id checks in
// `createRelationship` and the upsert import template, the lookups and
// deletes by relationship id, and the batched drains of `deleteRepository` /
// `deleteAllContents` and the `getRepositoryStats` counts are anchored on
// the repository's entities. The anchor
// must reach them through the `(repositoryId, id)` unique index; a plan that
// scans every `_Entity` in the database, or every relationship, makes each
// call pay for every repository in the store. The write-token read-backs that
// answer a re-run of a committed create are held to the same rule, and a
// create with an engine-minted id must not expand the repository's edges at
// all. EXPLAIN plans the statements without running them, so this checks the
// operators the server would use.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jConnection } from './Neo4jConnection.js';
import {
  buildCreateMintedRelationshipQuery,
  buildCreateRelationshipQuery,
  RELATIONSHIP_DELETE_MANY_QUERY,
  RELATIONSHIP_DELETE_QUERY,
  RELATIONSHIP_GET_QUERY,
  RELATIONSHIP_WRITE_ATTEMPT_QUERY,
} from './queries/relationship.js';
import {
  ENTITY_DRAIN_QUERY,
  RELATIONSHIP_DRAIN_QUERY,
  REPOSITORY_MARKER_EXISTS_QUERY,
} from './queries/repositoryDrain.js';
import { ENTITY_STATS_QUERY, RELATIONSHIP_STATS_QUERY } from './queries/repository.js';
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

const ROW = {
  id: 'plan-r1',
  relationshipType: 'KNOWS',
  sourceEntityId: 'plan-a',
  targetEntityId: 'plan-b',
};

if (NEO4J_URI) {
  describe('repository-scoped relationship statements — query plans (live)', () => {
    let conn: Neo4jConnection;

    beforeAll(() => {
      conn = new Neo4jConnection({
        uri: NEO4J_URI,
        username: NEO4J_USER,
        password: NEO4J_PASSWORD,
        database: NEO4J_DATABASE,
      });
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

    it('deleteRelationship seeks the entity index for its anchor', async () => {
      expectIndexAnchoredPlan(await explain(RELATIONSHIP_DELETE_QUERY, { relId: ROW.id }));
    });

    it('deleteRelationships seeks the entity index for its anchor', async () => {
      expectIndexAnchoredPlan(await explain(RELATIONSHIP_DELETE_MANY_QUERY, { ids: [ROW.id, 'plan-r2'] }));
    });

    /** The plan of a batched drain; `IN TRANSACTIONS` plans only on an auto-commit session. */
    async function drainPlan(cypher: string): Promise<PlanNode> {
      const { summary } = await conn.executeImplicitInTransactions(
        `EXPLAIN ${cypher}`,
        { batchSize: 500n, edgeCap: 10_000n, after: '' },
        { repositoryId: 'plan-check' },
      );
      expect(summary.plan).not.toBe(false);
      return summary.plan as PlanNode;
    }

    it('the relationship drain range-seeks the entity index after its cursor, in index order', async () => {
      const plan = await drainPlan(RELATIONSHIP_DRAIN_QUERY);
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
    });

    it('the entity drain seeks the entity index rather than scanning the label', async () => {
      expectIndexAnchoredPlan(operators(await drainPlan(ENTITY_DRAIN_QUERY)));
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
  });
} else {
  describe('repository-scoped relationship statements — query plans', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
