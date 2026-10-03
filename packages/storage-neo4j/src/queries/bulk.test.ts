import { describe, expect, it } from 'vitest';
import { ProviderError, QueryTimeoutError } from '@utaba/deep-memory';
import type {
  BulkImportOptions,
  StoredEntity,
  StoredRelationship,
} from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { importBulk, runBounded } from './bulk.js';
import { LOCK_REPOSITORY_MARKER } from './repositoryLock.js';

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

type RowOutcome = 'written' | 'endpoint-missing' | 'id-exists';

/** A driver record exposing `fields` through `get`. */
function record(fields: Record<string, unknown>): { get: (key: string) => unknown } {
  return { get: (key: string) => fields[key] };
}

/**
 * The records a template returns when the repository marker exists: the
 * entity templates report how many rows they wrote, the relationship
 * templates one outcome per row.
 */
function successRecords(
  cypher: string,
  rows: Row[],
  outcomeOf: (row: Row) => RowOutcome = () => 'written',
): Array<{ get: (key: string) => unknown }> {
  if (cypher.includes('AS outcome')) {
    return rows.map((row) => record({ id: row.id, outcome: outcomeOf(row) }));
  }
  return [record({ written: BigInt(rows.length) })];
}

/**
 * The answer to an insert import's write-token reads in a fake that never
 * committed a refused write: no chunk id carries the chunk's token, and no
 * row's id carries a token. `undefined` for any other statement.
 */
function noOwnWriteRecords(cypher: string): Array<{ get: (key: string) => unknown }> | undefined {
  if (cypher.includes('AS carrying')) return [record({ carrying: 0n })];
  if (cypher.includes('AS writeAttempt')) return [];
  return undefined;
}

/**
 * Connection fake: `respond` decides, per call, whether the statement
 * succeeds (returning the template's success records) or throws. Write-token
 * reads after a refusal find no write of this import's own.
 */
function fakeConnection(respond: (rows: Row[], call: number) => Error | undefined): {
  conn: Neo4jConnection;
  calls: Row[][];
} {
  const calls: Row[][] = [];
  const fake = {
    async executeQuery(cypher: string, params: { rows: Row[] }) {
      const tokenRead = noOwnWriteRecords(cypher);
      if (tokenRead !== undefined) return { records: tokenRead };
      calls.push(params.rows);
      const failure = respond(params.rows, calls.length);
      if (failure !== undefined) throw failure;
      return { records: successRecords(cypher, params.rows) };
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
    const fake = {
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        return {
          records: successRecords(cypher, params.rows, (row) => (row.id === 'r2' ? 'endpoint-missing' : 'written')),
        };
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

  it('records an upserted relationship whose id is already in use with RELATIONSHIP_ALREADY_EXISTS', async () => {
    const fake = {
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        return {
          records: successRecords(cypher, params.rows, (row) => (row.id === 'r1' ? 'id-exists' : 'written')),
        };
      },
    };

    const result = await importBulk(
      fake as unknown as Neo4jConnection,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2')] }],
      options(10, 1, false),
    );

    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([
      {
        item: 'relationship:r1',
        code: 'RELATIONSHIP_ALREADY_EXISTS',
        error: expect.stringContaining('"r1" already exists'),
      },
    ]);
  });

  it('sends an upsert chunk its row ids for the id check, and an insert chunk none', async () => {
    const sent: Array<{ skip: boolean; ids: unknown }> = [];
    for (const skip of [false, true]) {
      const fake = {
        async executeQuery(cypher: string, params: { rows: Row[]; ids?: unknown }) {
          sent.push({ skip, ids: params.ids });
          return { records: successRecords(cypher, params.rows) };
        },
      };
      await importBulk(
        fake as unknown as Neo4jConnection,
        RID,
        [{ relationships: [relationship('r1'), relationship('r2')] }],
        options(10, 1, skip),
      );
    }

    expect(sent).toEqual([
      { skip: false, ids: ['r1', 'r2'] },
      { skip: true, ids: undefined },
    ]);
  });

  it('checks ids in the upsert template only, anchored on the repository entities index', async () => {
    const cyphers = new Map<boolean, string>();
    for (const skip of [false, true]) {
      const fake = {
        async executeQuery(cypher: string, params: { rows: Row[] }) {
          if (cypher.includes('AS outcome')) cyphers.set(skip, cypher);
          return { records: successRecords(cypher, params.rows) };
        },
      };
      await importBulk(fake as unknown as Neo4jConnection, RID, [{ relationships: [relationship('r1')] }], options(10, 1, skip));
    }

    const upsert = cyphers.get(false)!;
    expect(upsert).toContain(
      'OPTIONAL MATCH (e:_Entity {repositoryId: $rid})-[held {repositoryId: $rid}]->()\n' +
        'WHERE e.id IS NOT NULL AND held.id IN $ids',
    );
    expect(upsert).toContain('MERGE (s)-[r:KNOWS {repositoryId: $rid, id: row.id}]->(t)');
    expect(upsert).not.toContain('$writeAttempt');
    const insert = cyphers.get(true)!;
    expect(insert).not.toContain('held');
    expect(insert).not.toContain('$ids');
    expect(insert).toContain('MERGE (s)-[r:KNOWS {repositoryId: $rid, id: row.id, _attempt: $writeAttempt}]->(t)\n  ON CREATE SET');
  });

  it('refuses an id repeated within one insert call: the first occurrence is written, later ones are row errors', async () => {
    const calls: string[][] = [];
    const fake = {
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        calls.push(params.rows.map((row) => row.id));
        return { records: successRecords(cypher, params.rows) };
      },
    };

    const result = await importBulk(
      fake as unknown as Neo4jConnection,
      RID,
      [
        { relationships: [relationship('r1'), relationship('r2')] },
        { relationships: [relationship('r1'), relationship('r3'), relationship('r1')] },
      ],
      options(2),
    );

    // No waves in insert mode: each chunk goes to the store once, without the repeats.
    expect(calls).toEqual([['r1', 'r2'], ['r3']]);
    expect(result.relationshipsImported).toBe(3);
    expect(result.errors).toEqual([
      expect.objectContaining({ item: 'relationship:r1', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
      expect.objectContaining({ item: 'relationship:r1', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
    ]);
  });

  it('writes an upsert chunk that repeats an id in waves, so the repeat meets the first write', async () => {
    const written = new Set<string>();
    const calls: string[][] = [];
    const fake = {
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        calls.push(params.rows.map((row) => row.id));
        // The store refuses the repeat, as it does when its type or endpoints differ.
        const records = successRecords(cypher, params.rows, (row) => (written.has(row.id) ? 'id-exists' : 'written'));
        for (const row of params.rows) written.add(row.id);
        return { records };
      },
    };

    const result = await importBulk(
      fake as unknown as Neo4jConnection,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2'), relationship('r1')] }],
      options(10, 1, false),
    );

    expect(calls).toEqual([['r1', 'r2'], ['r1']]);
    expect(result.relationshipsImported).toBe(2);
    expect(result.errors).toEqual([
      expect.objectContaining({ item: 'relationship:r1', code: 'RELATIONSHIP_ALREADY_EXISTS' }),
    ]);
  });

  it('applies a repeated id in a later upsert wave through MERGE, updating the first write in place', async () => {
    const calls: Array<{ ids: string[]; merges: boolean }> = [];
    const fake = {
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        calls.push({ ids: params.rows.map((row) => row.id), merges: cypher.includes('MERGE (s)-[r:KNOWS') });
        // Same type and endpoints as the edge the first wave wrote: the store accepts it.
        return { records: successRecords(cypher, params.rows) };
      },
    };

    const result = await importBulk(
      fake as unknown as Neo4jConnection,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2'), relationship('r1')] }],
      options(10, 1, false),
    );

    expect(calls).toEqual([
      { ids: ['r1', 'r2'], merges: true },
      { ids: ['r1'], merges: true },
    ]);
    expect(result.relationshipsImported).toBe(3);
    expect(result.errors).toEqual([]);
  });

  it('reports a relationship row with an unrecognised outcome as ProviderError', async () => {
    const fake = {
      async executeQuery(_cypher: string, params: { rows: Row[] }) {
        return { records: params.rows.map((row) => record({ id: row.id, outcome: 'something-else' })) };
      },
    };

    await expect(
      importBulk(fake as unknown as Neo4jConnection, RID, [{ relationships: [relationship('r1')] }], options(10)),
    ).rejects.toBeInstanceOf(ProviderError);
  });

  it('stops with RepositoryNotFoundError when an entity chunk finds no repository marker', async () => {
    const calls: Row[][] = [];
    const fake = {
      async executeQuery(_cypher: string, params: { rows: Row[] }) {
        calls.push(params.rows);
        return { records: [record({ written: 0n })] };
      },
    };

    await expect(
      importBulk(fake as unknown as Neo4jConnection, RID, [{ entities: [entity('e1'), entity('e2')] }], options(1)),
    ).rejects.toMatchObject({ name: 'RepositoryNotFoundError', code: 'REPOSITORY_NOT_FOUND' });
    expect(calls).toHaveLength(1);
  });

  it('stops with RepositoryNotFoundError when a relationship chunk finds no repository marker', async () => {
    const fake = {
      async executeQuery() {
        return { records: [] };
      },
    };

    await expect(
      importBulk(
        fake as unknown as Neo4jConnection,
        RID,
        [{ relationships: [relationship('r1')] }],
        options(10),
      ),
    ).rejects.toMatchObject({ name: 'RepositoryNotFoundError', code: 'REPOSITORY_NOT_FOUND' });
  });

  it('opens every import template with the repository-marker lock', async () => {
    const cyphers: string[] = [];
    const fake = {
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        cyphers.push(cypher);
        return { records: successRecords(cypher, params.rows) };
      },
    };
    for (const skipExistenceCheck of [true, false]) {
      await importBulk(
        fake as unknown as Neo4jConnection,
        RID,
        [{ entities: [entity('e1')], relationships: [relationship('r1')] }],
        options(10, 1, skipExistenceCheck),
      );
    }

    expect(cyphers).toHaveLength(4);
    for (const cypher of cyphers) {
      expect(cypher.trimStart().startsWith(LOCK_REPOSITORY_MARKER.trim())).toBe(true);
    }
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
      async executeQuery(cypher: string, params: { rows: Row[] }) {
        const tokenRead = noOwnWriteRecords(cypher);
        if (tokenRead !== undefined) return { records: tokenRead };
        const ids = params.rows.map((row) => row.id);
        calls.push(ids);
        if (ids.length > 1 && ids[0] === 'e1') throw slugViolation('person:e1');
        if (ids.length > 1 && ids[0] === 'e4') {
          await delay(5);
          throw new QueryTimeoutError(30_000);
        }
        await delay(20);
        return { records: successRecords(cypher, params.rows) };
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

describe('importBulk insert mode under a driver re-run', () => {
  interface EntityParams {
    id: string;
    slug: string;
  }

  interface StoredEdge {
    id: string;
    token: string;
  }

  interface InsertStoreState {
    nodes: Map<string, { slug: string; token: string | null }>;
    edges: StoredEdge[];
    missingEndpoints: Set<string>;
  }

  function idViolation(id: string): Error & { code: string } {
    return driverError(
      CONSTRAINT_VIOLATION,
      `Node(1) already exists with label \`_Entity\` and properties \`repositoryId\` = '${RID}', \`id\` = '${id}'`,
    );
  }

  function entityWithSlug(id: string, slug: string): StoredEntity {
    return { ...entity(id), slug };
  }

  /**
   * A store fake for insert imports. An entity statement writes its rows
   * atomically, enforcing the id and slug constraints across the store and
   * the statement's own rows; a relationship statement MERGEs each row on
   * its id and write token. `ackLost(call)` makes the driver commit that
   * statement, lose the acknowledgement and run it again, answering with the
   * second run; `failAfterCommit(call)` makes the re-run fail with that
   * error instead (a re-run refused for a reason of its own), and
   * `afterCommit(call, store)` changes the store between the two runs (a
   * concurrent delete). `slugFirst` reports a row's slug violation before
   * its id violation, as the server may check either constraint first. A
   * relationship row whose id is in `missingEndpoints` finds an endpoint
   * gone and writes nothing.
   */
  function insertStore(options: {
    seed?: Array<[string, { slug: string; token: string | null }]>;
    ackLost?: (call: number) => boolean;
    failAfterCommit?: (call: number) => Error | undefined;
    failBeforeCommit?: (call: number) => Error | undefined;
    afterCommit?: (call: number, store: InsertStoreState) => void;
    slugFirst?: boolean;
  }) {
    const nodes = new Map<string, { slug: string; token: string | null }>(options.seed ?? []);
    const edges: StoredEdge[] = [];
    const missingEndpoints = new Set<string>();
    const writes: Array<{ ids: string[]; token: unknown }> = [];
    const tokenReads: string[][] = [];

    const writeEntities = (rows: EntityParams[], token: string) => {
      const working = new Map(nodes);
      for (const row of rows) {
        const idTaken = working.has(row.id);
        const slugTaken = Array.from(working.values()).some((n) => n.slug === row.slug);
        if (options.slugFirst === true && slugTaken) throw slugViolation(row.slug);
        if (idTaken) throw idViolation(row.id);
        if (slugTaken) throw slugViolation(row.slug);
        working.set(row.id, { slug: row.slug, token });
      }
      for (const [id, node] of working) nodes.set(id, node);
      return [record({ written: BigInt(rows.length) })];
    };

    const writeEdges = (rows: Row[], token: string) =>
      rows.map((row) => {
        if (missingEndpoints.has(row.id)) return record({ id: row.id, outcome: 'endpoint-missing' });
        if (!edges.some((edge) => edge.id === row.id && edge.token === token)) edges.push({ id: row.id, token });
        return record({ id: row.id, outcome: 'written' });
      });

    let call = 0;
    const fake = {
      async executeQuery(cypher: string, params: Record<string, unknown>) {
        if (cypher.includes('AS carrying')) {
          // The statement matches each stored node once, however often its id repeats.
          const ids = new Set(params['ids'] as string[]);
          const carrying = Array.from(ids).filter((id) => nodes.get(id)?.token === params['writeAttempt']).length;
          return { records: [record({ carrying: BigInt(carrying) })] };
        }
        if (cypher.includes('AS writeAttempt')) {
          const ids = params['ids'] as string[];
          tokenReads.push(ids);
          return {
            records: ids.flatMap((id) => {
              const node = nodes.get(id);
              return node === undefined ? [] : [record({ id, writeAttempt: node.token })];
            }),
          };
        }
        call += 1;
        const thisCall = call;
        const token = params['writeAttempt'] as string;
        const rows = params['rows'] as Array<EntityParams & Row>;
        writes.push({ ids: rows.map((row) => row.id), token });
        const run = () => (cypher.includes('AS outcome') ? writeEdges(rows, token) : writeEntities(rows, token));
        const before = options.failBeforeCommit?.(thisCall);
        if (before !== undefined) throw before;
        if (options.ackLost?.(thisCall) === true) {
          run();
          options.afterCommit?.(thisCall, { nodes, edges, missingEndpoints });
          const after = options.failAfterCommit?.(thisCall);
          if (after !== undefined) throw after;
        }
        return { records: run() };
      },
    };
    return { conn: fake as unknown as Neo4jConnection, nodes, edges, writes, tokenReads };
  }

  it('lands a relationship chunk once when the driver re-runs its committed statement', async () => {
    const { conn, edges, writes } = insertStore({ ackLost: (call) => call === 1 });

    const result = await importBulk(
      conn,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2'), relationship('r3')] }],
      options(10),
    );

    expect(result).toEqual({ entitiesImported: 0, relationshipsImported: 3, errors: [] });
    expect(edges.map((edge) => edge.id).sort()).toEqual(['r1', 'r2', 'r3']);
    expect(writes).toHaveLength(1);
  });

  it('reuses the chunk token in the relationship fallback, so rows the chunk committed are not written twice', async () => {
    const refused = driverError('Neo.ClientError.Statement.TypeError', 'refused on re-run');
    const { conn, edges, writes } = insertStore({
      ackLost: (call) => call === 1,
      failAfterCommit: (call) => (call === 1 ? refused : undefined),
    });

    const result = await importBulk(
      conn,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2')] }],
      options(10),
    );

    expect(result).toEqual({ entitiesImported: 0, relationshipsImported: 2, errors: [] });
    expect(edges.map((edge) => edge.id).sort()).toEqual(['r1', 'r2']);
    expect(writes.map((write) => write.ids)).toEqual([['r1', 'r2'], ['r1'], ['r2']]);
    expect(new Set(writes.map((write) => write.token)).size).toBe(1);
  });

  it('reports an entity chunk the re-run finds committed as imported, without a per-row fallback', async () => {
    const { conn, nodes, writes } = insertStore({ ackLost: (call) => call === 1 });

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entity('e2'), entity('e3')] }],
      options(10),
    );

    expect(result).toEqual({ entitiesImported: 3, relationshipsImported: 0, errors: [] });
    expect(nodes.size).toBe(3);
    expect(writes).toHaveLength(1);
  });

  it('counts a fallback row the driver re-ran after committing it as imported', async () => {
    const { conn, nodes, writes } = insertStore({
      seed: [['x', { slug: 'person:e2', token: 'another-call' }]],
      // Call 1 is the chunk (refused for e2's slug); call 2 is e1 on its own.
      ackLost: (call) => call === 2,
    });

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entity('e2'), entity('e3')] }],
      options(10),
    );

    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toEqual([expect.objectContaining({ item: 'entity:e2', code: 'SLUG_CONFLICT' })]);
    expect(Array.from(nodes.keys()).sort()).toEqual(['e1', 'e3', 'x']);
    // Every fallback row carries a token of its own, distinct from the chunk's.
    expect(new Set(writes.map((write) => write.token)).size).toBe(4);
  });

  it('counts a fallback row the chunk statement committed as imported', async () => {
    // The chunk commits, its acknowledgement is lost, and the re-run fails
    // for a reason that is not a uniqueness clash, so the rows go one by one.
    const refused = driverError('Neo.ClientError.Statement.TypeError', 'refused on re-run');
    const { conn, nodes } = insertStore({
      ackLost: (call) => call === 1,
      failAfterCommit: (call) => (call === 1 ? refused : undefined),
    });

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    expect(result).toEqual({ entitiesImported: 2, relationshipsImported: 0, errors: [] });
    expect(nodes.size).toBe(2);
  });

  it('still records an entity id another call wrote as ENTITY_ALREADY_EXISTS', async () => {
    const { conn } = insertStore({ seed: [['e1', { slug: 'person:other', token: 'another-call' }]] });

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    expect(result.entitiesImported).toBe(1);
    expect(result.errors).toEqual([expect.objectContaining({ item: 'entity:e1', code: 'ENTITY_ALREADY_EXISTS' })]);
  });

  it('still records an entity id stored without a token as ENTITY_ALREADY_EXISTS', async () => {
    const { conn } = insertStore({ seed: [['e1', { slug: 'person:other', token: null }]] });

    const result = await importBulk(conn, RID, [{ entities: [entity('e1')] }], options(10));

    expect(result.entitiesImported).toBe(0);
    expect(result.errors).toEqual([expect.objectContaining({ item: 'entity:e1', code: 'ENTITY_ALREADY_EXISTS' })]);
  });

  it('reports an entity id repeated within one chunk once, even when its first row was re-run', async () => {
    const { conn, nodes } = insertStore({
      // Call 1 is the chunk (refused for the repeat); call 2 is the first e1.
      ackLost: (call) => call === 2,
    });

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entityWithSlug('e1', 'person:e1-again'), entity('e2')] }],
      options(10),
    );

    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toEqual([expect.objectContaining({ item: 'entity:e1', code: 'ENTITY_ALREADY_EXISTS' })]);
    expect(nodes.get('e1')?.slug).toBe('person:e1');
  });

  it('reports an entity id repeated across chunks once', async () => {
    const { conn, nodes } = insertStore({});

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entityWithSlug('e1', 'person:e1-again')] }],
      options(1),
    );

    expect(result.entitiesImported).toBe(1);
    expect(result.errors).toEqual([expect.objectContaining({ item: 'entity:e1', code: 'ENTITY_ALREADY_EXISTS' })]);
    expect(nodes.size).toBe(1);
  });

  it('counts a fallback row whose re-run reports its slug before its id as imported, from its own token', async () => {
    const { conn, nodes, tokenReads } = insertStore({
      seed: [['x', { slug: 'person:e2', token: 'another-call' }]],
      // Call 1 is the chunk (refused for e2's slug); call 2 is e1 on its own.
      ackLost: (call) => call === 2,
      slugFirst: true,
    });

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entity('e2'), entity('e3')] }],
      options(10),
    );

    expect(result.entitiesImported).toBe(2);
    expect(result.errors).toEqual([expect.objectContaining({ item: 'entity:e2', code: 'SLUG_CONFLICT' })]);
    expect(Array.from(nodes.keys()).sort()).toEqual(['e1', 'e3', 'x']);
    // Both refused rows' tokens are read back together, once.
    expect(tokenReads).toEqual([['e1', 'e2']]);
  });

  it('counts fallback rows whose re-run reports their slug before their id as imported, from the chunk token', async () => {
    const refused = driverError('Neo.ClientError.Statement.TypeError', 'refused on re-run');
    const { conn, nodes, writes, tokenReads } = insertStore({
      ackLost: (call) => call === 1,
      failAfterCommit: (call) => (call === 1 ? refused : undefined),
      slugFirst: true,
    });

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    expect(result).toEqual({ entitiesImported: 2, relationshipsImported: 0, errors: [] });
    expect(nodes.size).toBe(2);
    // The chunk token is what the fallback rows find stored.
    expect(Array.from(nodes.values()).every((node) => node.token === writes[0]?.token)).toBe(true);
    expect(tokenReads).toEqual([['e1', 'e2']]);
  });

  it('re-writes a chunk row a concurrent delete removed, and counts the committed rest as imported', async () => {
    const { conn, nodes, writes, tokenReads } = insertStore({
      ackLost: (call) => call === 1,
      afterCommit: (call, store) => {
        if (call === 1) store.nodes.delete('e2');
      },
    });

    const result = await importBulk(
      conn,
      RID,
      [{ entities: [entity('e1'), entity('e2'), entity('e3')] }],
      options(10),
    );

    expect(result).toEqual({ entitiesImported: 3, relationshipsImported: 0, errors: [] });
    expect(writes.map((write) => write.ids)).toEqual([['e1', 'e2', 'e3'], ['e1'], ['e2'], ['e3']]);
    const chunkToken = writes[0]?.token;
    expect(nodes.get('e1')?.token).toBe(chunkToken);
    expect(nodes.get('e3')?.token).toBe(chunkToken);
    // e2 was written again by its own fallback row.
    expect(nodes.get('e2')?.token).toBe(writes[2]?.token);
    expect(tokenReads).toEqual([['e1', 'e3']]);
  });

  it('matches committed relationship rows in the deleted-endpoint fallback and reports the deleted endpoint', async () => {
    const { conn, edges, writes } = insertStore({
      ackLost: (call) => call === 1,
      // Between the two runs a concurrent delete removes r2's endpoint and r2 with it.
      afterCommit: (call, store) => {
        if (call !== 1) return;
        store.missingEndpoints.add('r2');
        store.edges.splice(store.edges.findIndex((edge) => edge.id === 'r2'), 1);
      },
      failAfterCommit: (call) =>
        call === 1 ? driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction') : undefined,
    });

    const result = await importBulk(
      conn,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2'), relationship('r3')] }],
      options(10),
    );

    expect(result.relationshipsImported).toBe(2);
    expect(result.errors).toEqual([
      { item: 'relationship:r2', code: 'ENTITY_NOT_FOUND', error: expect.stringContaining('endpoint not found') },
    ]);
    expect(writes.map((write) => write.ids)).toEqual([['r1', 'r2', 'r3'], ['r1'], ['r2'], ['r3']]);
    expect(edges.map((edge) => edge.id).sort()).toEqual(['r1', 'r3']);
  });

  it('reads no tokens back for an upsert import', async () => {
    const { conn, tokenReads, writes } = insertStore({
      failBeforeCommit: (call) => (call === 1 ? idViolation('e1') : undefined),
    });

    await importBulk(conn, RID, [{ entities: [entity('e1')] }], options(10, 1, false));

    expect(tokenReads).toEqual([]);
    expect(writes.every((write) => write.token === undefined)).toBe(true);
  });
});

const DELETED_NODE = 'Neo.ClientError.Statement.EntityNotFound';

/**
 * Connection fake for a node deleted by a concurrent transaction. Import
 * statements go to `respond`, which throws a deleted-node error or returns
 * the statement's records; the repository-marker read answers `markerExists`
 * (or throws it, when it is an error). `markerReads` counts those reads.
 */
function deletedNodeConnection(
  respond: (cypher: string, rows: Row[], call: number) => Array<{ get: (key: string) => unknown }> | Error,
  markerExists: boolean | Error = true,
): { conn: Neo4jConnection; calls: Row[][]; markerReads: () => number } {
  const calls: Row[][] = [];
  let markerReads = 0;
  const fake = {
    async executeQuery(cypher: string, params: { rows?: Row[] }) {
      if (cypher.includes('AS repositoryExists')) {
        markerReads++;
        if (markerExists instanceof Error) throw markerExists;
        return { records: [record({ repositoryExists: markerExists })] };
      }
      const rows = params.rows ?? [];
      calls.push(rows);
      const response = respond(cypher, rows, calls.length);
      if (response instanceof Error) throw response;
      return { records: response };
    },
  };
  return { conn: fake as unknown as Neo4jConnection, calls, markerReads: () => markerReads };
}

describe('importBulk on a node deleted while a statement waited', () => {
  it('re-runs a refused relationship chunk per row and records a deleted endpoint with ENTITY_NOT_FOUND', async () => {
    const { conn, calls, markerReads } = deletedNodeConnection((cypher, rows, call) =>
      call === 1
        ? driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction')
        : successRecords(cypher, rows, (row) => (row.id === 'r2' ? 'endpoint-missing' : 'written')),
    );

    const result = await importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }], options(10));

    expect(calls.map((rows) => rows.map((row) => row.id))).toEqual([['r1', 'r2'], ['r1'], ['r2']]);
    expect(markerReads()).toBe(0);
    expect(result.relationshipsImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'relationship:r2', code: 'ENTITY_NOT_FOUND', error: expect.stringContaining('endpoint not found') },
    ]);
  });

  it('stops with RepositoryNotFoundError when the per-row re-run finds the marker gone', async () => {
    const { conn, calls } = deletedNodeConnection((_cypher, _rows, call) =>
      call === 1 ? driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction') : [],
    );

    await expect(
      importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }], options(10)),
    ).rejects.toMatchObject({ name: 'RepositoryNotFoundError', code: 'REPOSITORY_NOT_FOUND', repositoryId: RID });
    expect(calls).toHaveLength(2);
  });

  it('records a relationship row still refused on its own with ENTITY_NOT_FOUND while the marker exists', async () => {
    const { conn, markerReads } = deletedNodeConnection((cypher, rows) =>
      rows.some((row) => row.id === 'r2')
        ? driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction')
        : successRecords(cypher, rows),
    );

    const result = await importBulk(
      conn,
      RID,
      [{ relationships: [relationship('r1'), relationship('r2'), relationship('r3')] }],
      options(10),
    );

    expect(markerReads()).toBe(1);
    expect(result.relationshipsImported).toBe(2);
    expect(result.errors).toEqual([
      {
        item: 'relationship:r2',
        code: 'ENTITY_NOT_FOUND',
        error: expect.stringContaining('deleted by a concurrent transaction'),
      },
    ]);
  });

  it('records an entity row still refused on its own with ENTITY_NOT_FOUND while the marker exists', async () => {
    const { conn } = deletedNodeConnection((cypher, rows) =>
      rows.some((row) => row.id === 'e2')
        ? driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction')
        : successRecords(cypher, rows),
    );

    const result = await importBulk(conn, RID, [{ entities: [entity('e1'), entity('e2')] }], options(10));

    expect(result.entitiesImported).toBe(1);
    expect(result.errors).toEqual([
      { item: 'entity:e2', code: 'ENTITY_NOT_FOUND', error: expect.stringContaining('concurrent transaction') },
    ]);
  });

  it('stops with RepositoryNotFoundError when a row is refused and the marker is gone', async () => {
    const { conn, calls } = deletedNodeConnection(
      (cypher, rows) =>
        rows.some((row) => row.id === 'r1')
          ? driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction')
          : successRecords(cypher, rows),
      false,
    );

    await expect(
      importBulk(conn, RID, [{ relationships: [relationship('r1'), relationship('r2')] }], options(10)),
    ).rejects.toMatchObject({ name: 'RepositoryNotFoundError', code: 'REPOSITORY_NOT_FOUND' });
    // The chunk, then r1 alone; r2 is never attempted.
    expect(calls).toHaveLength(2);
  });

  it('maps a driver failure of the marker read to a typed error and stops', async () => {
    const readFailure = driverError('ServiceUnavailable', 'connection reset');
    const { conn } = deletedNodeConnection(
      () => driverError(DELETED_NODE, 'Node with id 7 has been deleted in this transaction'),
      readFailure,
    );

    const thrown: unknown = await importBulk(
      conn,
      RID,
      [{ relationships: [relationship('r1')] }],
      options(10),
    ).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(ProviderError);
    expect((thrown as Error).cause).toBe(readFailure);
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
