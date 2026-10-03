import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  QueryTimeoutError,
  TraversalTimeoutError,
  TraversalValidationError,
} from '@utaba/deep-memory';
import type { MemoryVocabulary, TraversalSpec } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from './Neo4jConnection.js';
import { Neo4jTraversalExecutor } from './Neo4jTraversalExecutor.js';

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
        return { records: [], summary: {} };
      },
    } as unknown as Neo4jConnection;
    return { executor: new Neo4jTraversalExecutor(connection, { profileTraversals: false }), statements };
  }

  const refusedSpecs: Array<[string, TraversalSpec]> = [
    [
      'a projected property',
      { start: { entityType: 'Thing' }, returnMode: 'terminal', projection: { properties: ['label', '_attempt'] } },
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
      { start: { entityType: 'Thing' }, returnMode: 'terminal', projection: { properties: ['label'] } },
      vocabulary,
    );

    expect(statements).toHaveLength(1);
  });
});
