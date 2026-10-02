import { describe, expect, it } from 'vitest';
import {
  ProviderError,
  QueryTimeoutError,
  TraversalTimeoutError,
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
