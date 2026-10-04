import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  QueryTimeoutError,
  RepositoryNotFoundError,
  TraversalTimeoutError,
  TraversalValidationError,
} from '@utaba/deep-memory';
import type { MemoryVocabulary, TraversalSpec } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from './Neo4jConnection.js';
import { guardWithRepositoryMarker, Neo4jTraversalExecutor } from './Neo4jTraversalExecutor.js';

const vocabulary: MemoryVocabulary = {
  version: '1.0.0',
  lastModified: '',
  modifiedBy: '',
  entityTypes: [],
  relationshipTypes: [],
};

const spec: TraversalSpec = {
  start: { entityId: 'entity-1' },
  steps: [{ direction: 'both' }],
  returnMode: 'terminal',
};

interface FakeRecord {
  keys: string[];
  get(key: string): unknown;
}

function fakeRecord(values: Record<string, unknown>): FakeRecord {
  return { keys: Object.keys(values), get: (key: string) => values[key] ?? null };
}

/** The single row a guarded traversal returns when it produced no rows of its own. */
function markerRow(repositoryExists: boolean): FakeRecord {
  return fakeRecord({ 'dm-repository-exists': repositoryExists, 'dm-traversal-row': null });
}

function executorAnswering(records: FakeRecord[]): { executor: Neo4jTraversalExecutor; statements: string[] } {
  const statements: string[] = [];
  const connection = {
    executeQuery: async (cypher: string) => {
      statements.push(cypher);
      return { records, summary: {} };
    },
  } as unknown as Neo4jConnection;
  return { executor: new Neo4jTraversalExecutor(connection, { profileTraversals: false }), statements };
}

function executorRejectingWith(error: unknown): Neo4jTraversalExecutor {
  const connection = {
    executeQuery: async () => {
      throw error;
    },
  } as unknown as Neo4jConnection;
  return new Neo4jTraversalExecutor(connection, { profileTraversals: false });
}

async function rejectionOf(executor: Neo4jTraversalExecutor): Promise<unknown> {
  return executor.execute('repo-a', spec, vocabulary).catch((err: unknown) => err);
}

describe('Neo4jTraversalExecutor error mapping', () => {
  it('maps a server-side timeout to TraversalTimeoutError with the driver error as cause', async () => {
    const driverError = { name: 'Neo4jError', gqlStatus: '25N14', code: 'Neo.ClientError.Transaction.TransactionTimedOut' };
    const rejection = await rejectionOf(
      executorRejectingWith(new QueryTimeoutError(1200, { cause: driverError })),
    );

    expect(rejection).toBeInstanceOf(TraversalTimeoutError);
    expect((rejection as TraversalTimeoutError).code).toBe('TRAVERSAL_TIMEOUT');
    expect((rejection as TraversalTimeoutError).timeoutMs).toBe(1200);
    expect((rejection as TraversalTimeoutError).cause).toBe(driverError);
  });

  it('wraps other driver errors in ProviderError and keeps them as cause', async () => {
    const driverError = { name: 'Neo4jError', code: 'Neo.TransientError.General.DatabaseUnavailable', message: 'down' };
    const rejection = await rejectionOf(executorRejectingWith(driverError));

    expect(rejection).toBeInstanceOf(ProviderError);
    expect((rejection as ProviderError).cause).toBe(driverError);
  });

  it('rethrows typed errors unchanged', async () => {
    const typed = new ProviderError('scope assertion failed');
    const rejection = await rejectionOf(executorRejectingWith(typed));

    expect(rejection).toBe(typed);
  });
});

describe('Neo4jTraversalExecutor bookkeeping-property guard', () => {
  function recordingExecutor(): { executor: Neo4jTraversalExecutor; statements: string[] } {
    const statements: string[] = [];
    const connection = {
      executeQuery: async (cypher: string) => {
        statements.push(cypher);
        return { records: [markerRow(true)], summary: {} };
      },
    } as unknown as Neo4jConnection;
    return { executor: new Neo4jTraversalExecutor(connection, { profileTraversals: false }), statements };
  }

  const refusedSpecs: Array<[string, TraversalSpec]> = [
    [
      'a projected property',
      { start: { entityType: 'Thing' }, returnMode: 'terminal', projection: { properties: ['city', '_attempt'] } },
    ],
    [
      'a start filter key',
      { start: { filter: [{ key: '_attempt', operator: 'isNotNull' }] }, returnMode: 'terminal' },
    ],
    [
      'a step entity filter key',
      {
        start: { entityId: 'entity-1' },
        steps: [{ direction: 'out', entityFilter: [{ key: '_attempt', operator: 'eq', value: 'x' }] }],
        returnMode: 'terminal',
      },
    ],
    [
      'a step relationship filter key',
      {
        start: { entityId: 'entity-1' },
        steps: [{ direction: 'out', relationshipFilter: [{ key: '_attempt', operator: 'isNotNull' }] }],
        returnMode: 'all',
      },
    ],
    [
      'a repeat stop-condition key',
      {
        start: { entityId: 'entity-1' },
        steps: [{ direction: 'out', repeat: { maxDepth: 2, until: [{ key: '_attempt', operator: 'isNull' }] } }],
        returnMode: 'terminal',
      },
    ],
  ];

  for (const [where, refused] of refusedSpecs) {
    it(`refuses the write-token property as ${where} before any round-trip`, async () => {
      const { executor, statements } = recordingExecutor();

      const rejection = await executor.execute('repo-a', refused, vocabulary).catch((err: unknown) => err);

      expect(rejection).toBeInstanceOf(TraversalValidationError);
      expect((rejection as TraversalValidationError).errors.join(' ')).toContain('_attempt');
      expect(statements).toHaveLength(0);
    });
  }

  it('lets a spec that names no bookkeeping property through to the server', async () => {
    const { executor, statements } = recordingExecutor();

    await executor.execute(
      'repo-a',
      { start: { entityType: 'Thing' }, returnMode: 'terminal', projection: { properties: ['city'] } },
      vocabulary,
    );

    expect(statements).toHaveLength(1);
  });
});

describe('Neo4jTraversalExecutor repository marker check', () => {
  it('reads the marker in the traversal statement, ahead of the compiled match', async () => {
    const { executor, statements } = executorAnswering([markerRow(true)]);

    await executor.execute('repo-a', spec, vocabulary);

    expect(statements).toHaveLength(1);
    const statement = statements[0] ?? '';
    expect(statement.startsWith('OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})')).toBe(true);
    expect(statement).toContain('OPTIONAL CALL (`dm-repository-exists`)');
    expect(statement).toContain('(n0:_Entity {repositoryId: $rid})');
    expect(statement).toContain('true AS `dm-traversal-row`');
    expect(statement.endsWith('RETURN *')).toBe(true);
  });

  it('throws RepositoryNotFoundError when the statement reports the marker absent', async () => {
    const { executor } = executorAnswering([markerRow(false)]);

    const rejection = await executor.execute('repo-a', spec, vocabulary).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(RepositoryNotFoundError);
  });

  it('reports a statement that returned no row as a provider fault', async () => {
    const { executor } = executorAnswering([]);

    const rejection = await executor.execute('repo-a', spec, vocabulary).catch((err: unknown) => err);

    expect(rejection).toBeInstanceOf(ProviderError);
  });

  it('drops the placeholder row of a traversal that matched nothing, even for an all-null projection', async () => {
    const { executor } = executorAnswering([markerRow(true)]);

    const raw = await executor.execute(
      'repo-a',
      { start: { entityType: 'Thing' }, returnMode: 'terminal', projection: { properties: ['city'] } },
      vocabulary,
    );

    expect(raw.aggregations).toEqual([]);
  });

  it('keeps every traversal row, including one whose projected values are null', async () => {
    const { executor } = executorAnswering([
      fakeRecord({ 'dm-repository-exists': true, 'dm-traversal-row': true, city: null }),
      fakeRecord({ 'dm-repository-exists': true, 'dm-traversal-row': true, city: 'b' }),
    ]);

    const raw = await executor.execute(
      'repo-a',
      { start: { entityType: 'Thing' }, returnMode: 'terminal', projection: { properties: ['city'] } },
      vocabulary,
    );

    expect(raw.aggregations).toEqual([{ values: { city: null } }, { values: { city: 'b' } }]);
  });

  it('refuses a compiled query whose RETURN / LIMIT tail it does not recognise', () => {
    expect(() => guardWithRepositoryMarker('MATCH (n0:_Entity {repositoryId: $rid}) RETURN n0')).toThrow(ProviderError);
  });

  it('refuses a compiled query whose LIMIT comes before its RETURN', () => {
    expect(() =>
      guardWithRepositoryMarker('MATCH (n0:_Entity {repositoryId: $rid})\nWITH n0\nLIMIT $p0\nRETURN n0'),
    ).toThrow(ProviderError);
  });

  it('refuses a compiled query with an ORDER BY line between RETURN and LIMIT', () => {
    expect(() =>
      guardWithRepositoryMarker('MATCH (n0:_Entity {repositoryId: $rid})\nRETURN n0\nORDER BY n0.id\nLIMIT $p0'),
    ).toThrow(ProviderError);
  });

  it('places the traversal row column before the SKIP / LIMIT slice', () => {
    const guarded = guardWithRepositoryMarker('MATCH (n0:_Entity {repositoryId: $rid})\nRETURN n0\nSKIP $p0\nLIMIT $p1');
    expect(guarded).toContain('RETURN n0, true AS `dm-traversal-row`\nSKIP $p0\nLIMIT $p1\n}');
  });
});
