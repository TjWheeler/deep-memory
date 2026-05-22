// Usage-sink tests for SqlServerStorageProvider.
//
// These tests don't need a live SQL Server — they verify that the
// constructor-returns-Proxy wrapping emits one OperationUsage record per
// tracked method call (including on failure), that untracked members are
// passed through, and that a throwing sink does not abort the operation.
// We trigger the error path by calling tracked methods before initialize()
// so getPool() throws, which exercises the Proxy's catch branch.

import { describe, it, expect, vi } from 'vitest';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

function makeProvider(reportUsage?: (u: unknown) => void) {
  return new SqlServerStorageProvider({
    // A bogus config — no methods that need a real pool will be invoked
    // successfully in these tests.
    connection: { server: 'nowhere', database: 'nope' } as unknown as import('mssql').config,
    ...(reportUsage ? { reportUsage } : {}),
  });
}

describe('SqlServerStorageProvider usage sink', () => {
  it('emits one usage record per tracked method call with correct shape (error path)', async () => {
    const sink = vi.fn();
    const provider = makeProvider(sink);

    const repoId = '00000000-0000-4000-8000-000000000000';
    await expect(provider.getRepository(repoId)).rejects.toThrow();

    expect(sink).toHaveBeenCalledTimes(1);
    const usage = sink.mock.calls[0]![0] as Record<string, unknown>;
    expect(usage['provider']).toBe('sqlserver');
    expect(usage['operation']).toBe('getRepository');
    expect(usage['unit']).toBe('ms');
    expect(usage['repositoryId']).toBe(repoId);
    expect(typeof usage['value']).toBe('number');
    expect(usage['timestamp']).toBeInstanceOf(Date);
  });

  it('extracts repositoryId from createRepository config object', async () => {
    const sink = vi.fn();
    const provider = makeProvider(sink);

    const repoId = '11111111-1111-4111-8111-111111111111';
    await expect(
      provider.createRepository({
        repositoryId: repoId,
        name: 'x',
        vocabulary: { entityTypes: {}, relationshipTypes: {} },
      } as unknown as import('@utaba/deep-memory/types').StorageRepositoryConfig),
    ).rejects.toThrow();

    expect(sink).toHaveBeenCalledTimes(1);
    expect((sink.mock.calls[0]![0] as Record<string, unknown>)['repositoryId']).toBe(repoId);
  });

  it('omits repositoryId for non-repository-scoped operations', async () => {
    const sink = vi.fn();
    const provider = makeProvider(sink);

    await expect(provider.listRepositories()).rejects.toThrow();

    expect(sink).toHaveBeenCalledTimes(1);
    const usage = sink.mock.calls[0]![0] as Record<string, unknown>;
    expect(usage['operation']).toBe('listRepositories');
    expect(usage['repositoryId']).toBeUndefined();
  });

  it('emits no usage records when no sink is configured', async () => {
    const provider = makeProvider();
    // Verify the call still throws (tracked methods still work, just without
    // the Proxy wrapping). The important assertion is no construction-time
    // crash and no sink to check.
    await expect(provider.getRepository('00000000-0000-4000-8000-000000000000')).rejects.toThrow();
  });

  it('a throwing sink does not abort the operation', async () => {
    const provider = makeProvider(() => {
      throw new Error('sink boom');
    });

    // The underlying call throws because the pool isn't initialized. The
    // sink also throws. The caller should see the ORIGINAL error, not the
    // sink error — the sink is isolated.
    await expect(provider.getRepository('00000000-0000-4000-8000-000000000000'))
      .rejects.toThrow(/not initialized/);
  });
});
