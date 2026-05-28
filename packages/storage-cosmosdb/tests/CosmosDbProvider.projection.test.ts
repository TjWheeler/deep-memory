// Live integration tests for server-side projection against the Cosmos
// emulator. Mirrors the Neo4j projection live tests so contract divergence
// surfaces in CI rather than at first agent call against a Cosmos repo.
//
// Two layers exercised here:
//   1. The compiler emits projection-aware Gremlin terminals
//      (`group().by(...).by(count()).unfold()` for count, `.values('p').dedup()`
//      for distinct).
//   2. The provider writes user-supplied property keys as native vertex
//      scalars alongside the JSON `properties` blob, so the projection
//      terminal can resolve `values('orgType')` against actual vertex
//      properties. Without the dual-write, the emulator raises
//      `GraphRuntimeException: The provided traversal or property name does
//      not exist as the key has no associated value for the element` — which
//      is precisely the symptom this test guards against.
//
// Requires a running Cosmos emulator with Gremlin enabled.
// Set environment variables:
//   COSMOSDB_GREMLIN_ENDPOINT=wss://localhost:8901/
//   COSMOSDB_KEY=C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CosmosDbProvider } from '../src/CosmosDbProvider.js';

const ENDPOINT = process.env['COSMOSDB_GREMLIN_ENDPOINT'];
const KEY = process.env['COSMOSDB_KEY'];

// Stable v4 UUID distinct from the conformance suite's repo id. Lazy-cleanup
// at beforeAll handles interrupted prior runs.
const RID = '40000000-0000-4000-a000-000000000007';

const skipIfNoEmulator = !ENDPOINT || !KEY;

(skipIfNoEmulator ? describe.skip : describe)(
  'CosmosDbProvider — projection (live)',
  () => {
    let provider: CosmosDbProvider;

    beforeAll(async () => {
      provider = new CosmosDbProvider({
        endpoint: ENDPOINT!,
        key: KEY!,
        database: 'deep-memory-test',
        container: 'graph-test',
        rejectUnauthorized: false,
      });
      await provider.initialize();
      await provider.ensureSchema();
      try {
        await provider.deleteRepository(RID);
      } catch {
        // First-run / nothing to clean — fine.
      }
      await provider.createRepository({
        repositoryId: RID,
        label: 'projection test',
        governanceConfig: { mode: 'open' },
        createdAt: new Date().toISOString(),
        createdBy: 'projection-test',
      });

      // 5 companies, 4 universities, 1 non-profit — mirrors the bug-report
      // shape so the count aggregation produces a recognisable grouping.
      const orgs: Array<[string, string]> = [
        ['c1', 'company'],    ['c2', 'company'],    ['c3', 'company'],
        ['c4', 'company'],    ['c5', 'company'],    ['u1', 'university'],
        ['u2', 'university'], ['u3', 'university'], ['u4', 'university'],
        ['n1', 'non-profit'],
      ];
      for (const [id, orgType] of orgs) {
        await provider.createEntity(RID, {
          id,
          slug: `Organization:${id}`,
          entityType: 'Organization',
          label: id,
          summary: '',
          properties: { orgType },
          provenance: {
            createdBy: 'projection-test',
            createdByType: 'agent',
            createdAt: new Date().toISOString(),
            modifiedBy: 'projection-test',
            modifiedByType: 'agent',
            modifiedAt: new Date().toISOString(),
          },
        });
      }
    }, 120_000);

    afterAll(async () => {
      if (provider) {
        try {
          await provider.deleteRepository(RID);
        } catch {
          // Best-effort cleanup.
        }
        await provider.dispose();
      }
    });

    it('emits server-side count aggregation grouped by user-property scalar', async () => {
      const result = await provider.traverse(RID, {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], mode: 'count' },
        limit: 200,
      });

      // Entities suppressed — projection owns the response.
      expect(result.entities).toEqual([]);

      // Compiled Gremlin carries the count-terminal shape from the compiler.
      const compiled = result.queryMetadata.compiledQuery ?? '';
      expect(compiled).toContain('group()');
      expect(compiled).toContain("values('orgType')");
      expect(compiled).toContain('count()');
      expect(compiled).toContain('unfold()');

      // Aggregations: one row per distinct orgType.
      expect(result.aggregations).toBeDefined();
      expect(result.aggregations).toHaveLength(3);
      const byType = new Map(
        result.aggregations!.map((a) => [a.values['orgType'], a.count]),
      );
      expect(byType.get('company')).toBe(5);
      expect(byType.get('university')).toBe(4);
      expect(byType.get('non-profit')).toBe(1);

      // RU regression — projection queries must carry a request-charge.
      expect(result.queryMetadata.resourceCost).toBeDefined();
      expect(result.queryMetadata.resourceCost?.units).toBe('RU');
      expect(typeof result.queryMetadata.resourceCost?.value).toBe('number');
      expect(result.queryMetadata.resourceCost!.value!).toBeGreaterThan(0);
    }, 60_000);

    it('emits server-side dedup for distinct values mode', async () => {
      const result = await provider.traverse(RID, {
        start: { entityType: 'Organization' },
        returnMode: 'terminal',
        projection: { properties: ['orgType'], distinct: true },
        limit: 200,
      });

      const compiled = result.queryMetadata.compiledQuery ?? '';
      expect(compiled).toContain("values('orgType')");
      expect(compiled).toContain('dedup()');
      expect(compiled).not.toContain('group()');
      expect(compiled).not.toContain('count()');

      expect(result.entities).toEqual([]);
      expect(result.aggregations).toBeDefined();
      // 3 distinct orgType values, no count column on any row.
      expect(result.aggregations).toHaveLength(3);
      for (const agg of result.aggregations!) {
        expect(agg.count).toBeUndefined();
      }
      const values = new Set(result.aggregations!.map((a) => a.values['orgType']));
      expect(values).toEqual(new Set(['company', 'university', 'non-profit']));
    }, 60_000);

    // Plan-cache observation. Not a hard assertion — the planning doc flags
    // this as informational. The expectation is vocabulary-bounded growth:
    // every Organization is written with the same `{ orgType }` shape, so
    // the per-call createEntity Gremlin string should be byte-identical
    // across all same-shape writes; only the bound values differ. A
    // regression where the distinct string count grows with entity count
    // (rather than entity-type count) would mean a value has leaked into
    // the Gremlin string itself.
    it('observes vocabulary-bounded distinct compiled-string count across the seed shape', async () => {
      type Conn = {
        submit: (
          query: string,
          bindings?: Record<string, unknown>,
        ) => Promise<unknown>;
      };
      const conn = (provider as unknown as { conn: Conn }).conn;
      const originalSubmit = conn.submit.bind(conn);
      const captured: string[] = [];
      const spy = vi
        .spyOn(conn, 'submit')
        .mockImplementation(async (query: string, bindings) => {
          captured.push(query);
          return (await originalSubmit(query, bindings)) as never;
        });

      try {
        const extras: Array<[string, string]> = [
          ['c6', 'company'],    ['c7', 'company'],    ['c8', 'company'],
          ['u5', 'university'], ['u6', 'university'],
          ['n2', 'non-profit'], ['n3', 'non-profit'],
        ];
        for (const [id, orgType] of extras) {
          await provider.createEntity(RID, {
            id,
            slug: `Organization:${id}`,
            entityType: 'Organization',
            label: id,
            summary: '',
            properties: { orgType },
            provenance: {
              createdBy: 'projection-test',
              createdByType: 'agent',
              createdAt: new Date().toISOString(),
              modifiedBy: 'projection-test',
              modifiedByType: 'agent',
              modifiedAt: new Date().toISOString(),
            },
          });
        }
      } finally {
        spy.mockRestore();
      }

      const distinct = new Set(captured);
      // eslint-disable-next-line no-console
      console.log(
        `[projection observation] distinct compiled-Gremlin-string count over ${captured.length} round-trips: ${distinct.size}`,
      );
      // Soft sanity bound — same-shape repeats must share a query string,
      // so the distinct count must be strictly less than the round-trip
      // count. A 1:1 distinct-to-round-trip ratio would mean every write
      // emitted a unique string.
      expect(distinct.size).toBeLessThan(captured.length);
    }, 120_000);
  },
);
