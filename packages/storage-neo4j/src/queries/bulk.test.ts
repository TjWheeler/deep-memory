import { describe, expect, it } from 'vitest';
import { ProviderError, QueryTimeoutError } from '@utaba/deep-memory';
import type {
  BulkImportOptions,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { importBulk, runBounded } from './bulk.js';

const RID = 'repo-bulk';
const CONSTRAINT_VIOLATION = 'Neo.ClientError.Schema.ConstraintValidationFailed';

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return {
    createdBy: 'bulk-test',
    createdByType: 'agent',
    createdAt: now,
    modifiedBy: 'bulk-test',
    modifiedByType: 'agent',
    modifiedAt: now,
  };
}

function entity(id: string): StoredEntity {
  return {
    id,
    slug: `person:${id}`,
    entityType: 'person',
    label: id,
    properties: {},
    provenance: provenance(),
  };
}

function relationship(id: string): StoredRelationship {
  return {
    id,
    relationshipType: 'KNOWS',
    sourceEntityId: 'a',
    targetEntityId: 'b',
    properties: {},
    bidirectional: false,
    provenance: provenance(),
  };
}

function driverError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { name: 'Neo4jError', code });
}

function slugViolation(slug: string): Error & { code: string } {
  return driverError(
    CONSTRAINT_VIOLATION,
    `Node(1) already exists with label \`_Entity\` and properties \`repositoryId\` = '${RID}', \`slug\` = '${slug}'`,
  );
}

interface Row {
  id: string;
}

/**
 * Connection fake: `respond` decides, per call, whether the statement
 * succeeds (returning one record per row id) or throws.
 */
function fakeConnection(respond: (rows: Row[], call: number) => Error | undefined): {
  conn: Neo4jConnection;
  calls: Row[][];
} {
  const calls: Row[][] = [];
  const fake = {
    async executeQuery(_cypher: string, params: { rows: Row[] }) {
      calls.push(params.rows);
      const failure = respond(params.rows, calls.length);
      if (failure !== undefined) throw failure;
      return { records: params.rows.map((row) => ({ get: () => row.id })) };
    },
  };
  return { conn: fake as unknown as Neo4jConnection, calls };
}

/** Neo4j-specific chunking knobs accepted alongside the public options. */
function options(chunkSize: number, concurrency = 1, skipExistenceCheck = true): BulkImportOptions {
  return { skipExistenceCheck, chunkSize, concurrency } as BulkImportOptions;
}

describe('importBulk failure handling', () => {
  it('rethrows a QueryTimeoutError from a chunk without retrying its rows', async () => {
    const timeout = new QueryTimeoutError(30_000);
    const { conn, calls } = fakeConnection(() => timeout);

    await expect(
      importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2'), entity('e3')] }], options(10)),
    ).rejects.toBe(timeout);
    expect(calls).toHaveLength(1);
  });

  it('rethrows a connection failure as a typed ProviderError without retrying its rows', async () => {
    const outage = driverError('ServiceUnavailable', 'Could not perform discovery. No routing servers available.');
    const { conn, calls } = fakeConnection(() => outage);

    const rejection = importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));
    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    await expect(rejection).rejects.toMatchObject({ cause: outage });
    expect(calls).toHaveLength(1);
  });

  it('stops dispatching further chunks after a store failure', async () => {
    const { conn, calls } = fakeConnection(() => new QueryTimeoutError(1));

    await expect(
      importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2'), entity('e3'), entity('e4')] }], options(1, 2)),
    ).rejects.toBeInstanceOf(QueryTimeoutError);
    // The two chunks already in flight settle; the remaining two never start.
    expect(calls).toHaveLength(2);
  });

  it('falls back per row on a constraint violation and records each failing row with its code', async () => {
    const { conn, calls } = fakeConnection((rows) =>
      rows.some((row) => row.id === 'e2') ? slugViolation('person:e2') : undefined,
    );

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entity('e2'), entity('e3')] }],
      options(10),
    );

    expect(calls.map((rows) => rows.map((row) => row.id))).toEqual([
      ['e1', 'e2', 'e3'],
      ['e1'],
      ['e2'],
      ['e3'],
    ]);
    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toEqual([
      {
        item: 'entity:e2',
        code: 'SLUG_CONFLICT',
        error: expect.stringContaining('person:e2'),
      },
    ]);
  });

  it('rethrows a store failure that strikes during the per-row fallback', async () => {
    const timeout = new QueryTimeoutError(30_000);
    const { conn, calls } = fakeConnection((rows, call) => {
      if (call === 1) return slugViolation('person:e1');
      return rows[0]?.id === 'e2' ? timeout : undefined;
    });

    await expect(
      importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2'), entity('e3')] }], options(10)),
    ).rejects.toBe(timeout);
    // Chunk, then e1, then e2 (which times out); e3 is never tried.
    expect(calls).toHaveLength(3);
  });

  it('falls back per row for relationships and records the code of each failing row', async () => {
    const { conn } = fakeConnection((rows) =>
      rows.some((row) => row.id === 'r2')
        ? driverError('Neo.ClientError.Statement.TypeError', 'Property values can only be of primitive types')
        : undefined,
    );

    const result = await importBulk(
      conn,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2')] }],
      options(10),
    );

    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'relationship:r2', code: 'PROVIDER_ERROR', error: expect.stringContaining('TypeError') },
    ]);
  });

  it('rethrows a relationship chunk timeout without retrying its rows', async () => {
    const timeout = new QueryTimeoutError(30_000);
    const { conn, calls } = fakeConnection(() => timeout);

    await expect(
      importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }], options(10)),
    ).rejects.toBe(timeout);
    expect(calls).toHaveLength(1);
  });

  it('records a relationship whose endpoint is missing with ENTITY_NOT_FOUND', async () => {
    const calls: Row[][] = [];
    const fake = {
      async executeQuery(_cypher: string, params: { rows: Row[] }) {
        calls.push(params.rows);
        return { records: params.rows.filter((row) => row.id !== 'r2').map((row) => ({ get: () => row.id })) };
      },
    };

    const result = await importBulk(
      fake as unknown as Neo4jConnection,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2')] }],
      options(10),
    );

    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'relationship:r2', code: 'ENTITY_NOT_FOUND', error: expect.stringContaining('endpoint not found') },
    ]);
  });

  it('records a row whose property key the mapping refuses and imports the rest of its chunk', async () => {
    const { conn, calls } = fakeConnection(() => undefined);

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), { ...entity('e2'), properties: { 'bad-key': 1 } }, entity('e3')] }],
      options(10),
    );

    expect(calls.map((rows) => rows.map((row) => row.id))).toEqual([['e1', 'e3']]);
    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ item: 'entity:e2', code: 'PROVIDER_ERROR' });
  });

  it('records every row of a relationship group whose type the guard refuses', async () => {
    const { conn, calls } = fakeConnection(() => undefined);
    const bad = (id: string): StoredRelationship => ({ ...relationship(id), relationshipType: 'BAD-TYPE' });

    const result = await importBulk(
      conn,
      RID,
      [{ relationships: [bad('r1'), bad('r2'), relationship('r3')] }],
      options(10),
    );

    expect(calls.map((rows) => rows.map((row) => row.id))).toEqual([['r3']]);
    expect(result.relationshipsImported).toBe(1);
    expect(result.errors.map((e) => [e.item, e.code])).toEqual([
      ['relationship:r1', 'PROVIDER_ERROR'],
      ['relationship:r2', 'PROVIDER_ERROR'],
    ]);
  });

  it('falls back per row when a chunk exceeds the transaction memory limit', async () => {
    const { conn, calls } = fakeConnection((rows) =>
      rows.length > 1
        ? driverError('Neo.TransientError.General.TransactionMemoryLimit', 'transaction memory limit exceeded')
        : undefined,
    );

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    expect(calls).toHaveLength(3);
    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toEqual([]);
  });

  it('falls back per row when a chunk meets an exhausted memory pool, and stops if a row meets it too', async () => {
    const pool = driverError('Neo.TransientError.General.MemoryPoolOutOfMemoryError', 'memory pool exhausted');
    const { conn, calls } = fakeConnection(() => pool);

    const rejection = importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    await expect(rejection).rejects.toBeInstanceOf(ProviderError);
    await expect(rejection).rejects.toMatchObject({ cause: pool });
    // The chunk, then the first row; the second row is never tried.
    expect(calls).toHaveLength(2);
  });

  it('records a single row over the per-transaction memory limit as a row error', async () => {
    const { conn } = fakeConnection((rows) =>
      rows.some((row) => row.id === 'e2')
        ? driverError('Neo.TransientError.General.TransactionMemoryLimit', 'transaction memory limit exceeded')
        : undefined,
    );

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    expect(result.entitiesImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'entity:e2', code: 'PROVIDER_ERROR', error: expect.stringContaining('TransactionMemoryLimit') },
    ]);
  });

  it('stops a running per-row fallback once a sibling chunk fails on the store', async () => {
    const calls: string[][] = [];
    const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
    const fake = {
      async executeQuery(_cypher: string, params: { rows: Row[] }) {
        const ids = params.rows.map((row) => row.id);
        calls.push(ids);
        if (ids.length > 1 && ids[0] === 'e1') throw slugViolation('person:e1');
        if (ids.length > 1 && ids[0] === 'e4') {
          await delay(5);
          throw new QueryTimeoutError(30_000);
        }
        await delay(20);
        return { records: [] };
      },
    };

    await expect(
      importBulk(
        fake as unknown as Neo4jConnection,
        RID,
        [{ entities: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'].map((id) => entity(id)) }],
        options(3, 2),
      ),
    ).rejects.toBeInstanceOf(QueryTimeoutError);

    // The first chunk's fallback wrote e1, then saw the sibling's failure and
    // stopped before e2.
    expect(calls).toEqual([
      ['e1', 'e2', 'e3'],
      ['e4', 'e5', 'e6'],
      ['e1'],
    ]);
  });
});

describe('runBounded', () => {
  it('awaits in-flight tasks, starts no new ones, and rejects with the first error', async () => {
    const started: number[] = [];
    let settled = 0;
    const first = new Error('first');

    await expect(
      runBounded([1, 2, 3, 4, 5], 2, async (n) => {
        started.push(n);
        await new Promise((resolve) => setTimeout(resolve, n === 1 ? 1 : 10));
        settled++;
        if (n === 1) throw first;
        return n;
      }),
    ).rejects.toBe(first);

    expect(started).toEqual([1, 2]);
    expect(settled).toBe(2);
  });

  it('returns results in input order when every task succeeds', async () => {
    await expect(runBounded([3, 1, 2], 2, async (n) => n * 10)).resolves.toEqual([30, 10, 20]);
  });
});
