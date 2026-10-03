// Query plans of the relationship id checks (live).
//
// A relationship id must be unique across every type in a repository, and
// Neo4j relationship indexes cover one type only, so the id checks in
// `createRelationship` and the upsert import template are anchored on the
// repository's entities. The anchor must reach them through the
// `(repositoryId, id)` unique index; a plan that scans every `_Entity` in
// the database, or every relationship, makes each create pay for every
// repository in the store. EXPLAIN plans the statements without running
// them, so this checks the operators the server would use.
//
// Set NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD to run. Skipped otherwise so
// CI builds without a live Neo4j stay green.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Neo4jConnection } from './Neo4jConnection.js';
import { buildCreateRelationshipQuery } from './queries/relationship.js';
import { buildInsertRelationshipsQuery, buildUpsertRelationshipsQuery } from './queries/bulk.js';

const NEO4J_URI = process.env['NEO4J_URI'];
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? '';
const NEO4J_DATABASE = process.env['NEO4J_DATABASE'] ?? 'neo4j';

/** Operators that visit every node of a label, or every relationship, in the database. */
const WHOLE_STORE_SCANS = ['NodeByLabelScan', 'AllNodesScan', 'AllRelationshipsScan', 'DirectedAllRelationshipsScan', 'UndirectedAllRelationshipsScan'];

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

const ROW = {
  id: 'plan-r1',
  relationshipType: 'KNOWS',
  sourceEntityId: 'plan-a',
  targetEntityId: 'plan-b',
};

if (NEO4J_URI) {
  describe('relationship id checks — query plans (live)', () => {
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
      const names = (await explain(buildInsertRelationshipsQuery('KNOWS'), { rows: [ROW] })).map(operatorName);
      for (const scan of WHOLE_STORE_SCANS) expect(names).not.toContain(scan);
    });
  });
} else {
  describe('relationship id checks — query plans', () => {
    it('skipped — set NEO4J_URI to run', () => {
      expect(true).toBe(true);
    });
  });
}
