import { describe, expect, it, vi } from 'vitest';
import { Neo4jStorageProvider } from './Neo4jStorageProvider.js';
import type { Neo4jConnection } from './Neo4jConnection.js';

// `executeNativeQuery` is the cross-repository escape hatch. It MUST route
// through `Neo4jConnection.executeSystemQuery({ crossRepository: true })` so
// the call lands on the D3b allowlist path — bypassing `executeQuery` (which
// would inject `$rid` and assert scope) is the whole point. These tests pin
// that contract.

interface ExecuteSystemQueryCall {
  cypher: string;
  params: Record<string, unknown>;
  options: { crossRepository: true; routing?: string };
}

function buildProviderWithStub(records: Array<Record<string, unknown>> = []): {
  provider: Neo4jStorageProvider;
  executeSystemQuery: ReturnType<typeof vi.fn>;
  executeQuery: ReturnType<typeof vi.fn>;
} {
  const provider = new Neo4jStorageProvider({
    uri: 'bolt://localhost:7687',
    username: 'neo4j',
    password: 'unused-by-this-test',
  });

  const executeSystemQuery = vi.fn(
    async (
      _cypher: string,
      _params: Record<string, unknown>,
      _options: { crossRepository: true },
    ) => ({
      records: records.map((row) => ({ toObject: (): Record<string, unknown> => row })),
      summary: {},
      keys: Object.keys(records[0] ?? {}),
    }),
  );
  const executeQuery = vi.fn(async () => {
    throw new Error(
      'executeNativeQuery must not route through executeQuery — the scoped path injects $rid.',
    );
  });

  const stub: Partial<Neo4jConnection> = {
    executeSystemQuery: executeSystemQuery as unknown as Neo4jConnection['executeSystemQuery'],
    executeQuery: executeQuery as unknown as Neo4jConnection['executeQuery'],
    close: vi.fn(async () => undefined),
  };
  (provider as unknown as { connection: Partial<Neo4jConnection> }).connection = stub;

  return { provider, executeSystemQuery, executeQuery };
}

describe('Neo4jStorageProvider.executeNativeQuery', () => {
  it('routes through executeSystemQuery with crossRepository: true', async () => {
    const { provider, executeSystemQuery, executeQuery } = buildProviderWithStub([
      { name: 'Alice' },
    ]);

    await provider.executeNativeQuery('repo-x', 'MATCH (n) RETURN n.name AS name LIMIT 1', {
      foo: 'bar',
    });

    expect(executeSystemQuery).toHaveBeenCalledTimes(1);
    const call = executeSystemQuery.mock.calls[0] as unknown as [
      ExecuteSystemQueryCall['cypher'],
      ExecuteSystemQueryCall['params'],
      ExecuteSystemQueryCall['options'],
    ];
    expect(call[0]).toBe('MATCH (n) RETURN n.name AS name LIMIT 1');
    expect(call[1]).toEqual({ foo: 'bar' });
    expect(call[2]).toEqual({ crossRepository: true });
    expect(executeQuery).not.toHaveBeenCalled();
  });

  it('does not inject the repositoryId into the params object', async () => {
    const { provider, executeSystemQuery } = buildProviderWithStub();

    await provider.executeNativeQuery('repo-x', 'MATCH (n) RETURN n', { p: 1 });

    const params = executeSystemQuery.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(params).toEqual({ p: 1 });
    expect(params).not.toHaveProperty('rid');
    expect(params).not.toHaveProperty('repositoryId');
  });

  it('passes an empty params object when the caller omits params', async () => {
    const { provider, executeSystemQuery } = buildProviderWithStub();

    await provider.executeNativeQuery('repo-x', 'RETURN 1 AS one');

    expect(executeSystemQuery.mock.calls[0]?.[1]).toEqual({});
  });

  it('maps each driver record through toObject() before returning', async () => {
    const { provider } = buildProviderWithStub([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);

    const rows = await provider.executeNativeQuery('repo-x', 'MATCH (n) RETURN n');

    expect(rows).toEqual([
      { name: 'Alice', age: 30 },
      { name: 'Bob', age: 25 },
    ]);
  });

  it('returns an empty array when the query produces no rows', async () => {
    const { provider } = buildProviderWithStub([]);
    const rows = await provider.executeNativeQuery('repo-x', 'MATCH (n) WHERE false RETURN n');
    expect(rows).toEqual([]);
  });
});
