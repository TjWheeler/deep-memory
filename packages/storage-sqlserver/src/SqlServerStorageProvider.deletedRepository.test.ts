import { describe, expect, it } from 'vitest';
import type sql from 'mssql';
import type { ImportChunk, StoredEntityUpdate } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000002';

interface FakeResult {
  recordset: unknown[];
  recordsets: unknown[][];
  rowsAffected: number[];
}

/** What the fake answers for one statement; anything else answers no rows. */
type Answer = (text: string) => Partial<FakeResult> | undefined;

/**
 * A provider over a fake pool that answers each statement through `answer`.
 * Statements run inside a transaction share the same answers; the
 * transaction's lifecycle calls are recorded in `transactionCalls`.
 */
function providerWith(answer: Answer): {
  provider: SqlServerStorageProvider;
  statements: string[];
  transactionCalls: string[];
} {
  const statements: string[] = [];
  const transactionCalls: string[] = [];
  interface FakeRequest {
    input(): FakeRequest;
    query(text: string): Promise<FakeResult>;
  }
  const request: FakeRequest = {
    input(): FakeRequest {
      return request;
    },
    async query(text: string): Promise<FakeResult> {
      statements.push(text);
      const result = answer(text) ?? {};
      const recordset = result.recordset ?? result.recordsets?.[0] ?? [];
      return { recordset, recordsets: result.recordsets ?? [recordset], rowsAffected: result.rowsAffected ?? [0] };
    },
  };
  const transaction = {
    async begin(): Promise<void> {
      transactionCalls.push('begin');
    },
    request: () => request as unknown as sql.Request,
    async commit(): Promise<void> {
      transactionCalls.push('commit');
    },
    async rollback(): Promise<void> {
      transactionCalls.push('rollback');
    },
  };
  const provider = new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' } });
  (provider as unknown as { pool: Pick<sql.ConnectionPool, 'request' | 'transaction'> }).pool = {
    request: () => request as unknown as sql.Request,
    transaction: () => transaction as unknown as sql.Transaction,
  };
  return { provider, statements, transactionCalls };
}

/** Answers for the guarded delete batch: whether the repository row exists, and the ids removed. */
function guardedDelete(repositoryExists: boolean, deletedIds: string[]): Answer {
  return (text) =>
    text.includes('DECLARE @deleted TABLE')
      ? { recordsets: [[{ repository_exists: repositoryExists ? 1 : 0 }], deletedIds.map((id) => ({ id }))] }
      : undefined;
}

/**
 * Answers a read batch headed by the repository check: the check row, and
 * then (for an existing repository) `resultSets` as the following result
 * sets, in order.
 */
function guardedRead(
  text: string,
  repositoryExists: boolean,
  ...resultSets: unknown[][]
): Partial<FakeResult> | undefined {
  if (!text.includes('IF NOT EXISTS')) return undefined;
  return repositoryExists
    ? { recordsets: [[{ repository_exists: 1 }], ...resultSets] }
    : { recordsets: [[{ repository_exists: 0 }]] };
}

/** Answers the repository read with a row when `exists`; every delete matches no row. */
function repositoryRow(exists: boolean): Answer {
  return (text) =>
    text.includes('SELECT * FROM') && text.includes('dm_repositories') && exists
      ? { recordset: [{ repository_id: RID, label: 'r', governance_config: '{"mode":"open"}' }] }
      : undefined;
}

function labelUpdate(): StoredEntityUpdate {
  const now = new Date().toISOString();
  return {
    label: 'Renamed',
    provenance: {
      createdBy: 't',
      createdByType: 'agent',
      createdAt: now,
      modifiedBy: 't',
      modifiedByType: 'agent',
      modifiedAt: now,
    },
  };
}

const ENTITY_ROW = {
  entity_id: 'e1',
  entity_type: 'test-type',
  slug: 'test-type:e1',
  label: 'e1',
  summary: null,
  properties: '{}',
  data: null,
  data_format: null,
  created_by: 't',
  created_by_type: 'agent',
  created_at: '2026-01-01T00:00:00.000Z',
  modified_by: 't',
  modified_by_type: 'agent',
  modified_at: '2026-01-01T00:00:00.000Z',
};

describe('SqlServerStorageProvider on a deleted repository', () => {
  it('deleteEntities checks the repository row in the same batch and deletes only while it exists', async () => {
    const { provider, statements } = providerWith(guardedDelete(true, ['e1']));

    await expect(provider.deleteEntities(RID, ['e1', 'missing'])).resolves.toEqual({
      deleted: ['e1'],
      notFound: ['missing'],
    });
    expect(statements).toHaveLength(1);
    const batch = statements[0]!;
    expect(batch).toContain('WITH (HOLDLOCK, ROWLOCK)');
    expect(batch.indexOf('IF @repositories = 1')).toBeLessThan(batch.indexOf('DELETE FROM'));
  });

  it('deleteEntities and deleteRelationships throw RepositoryNotFoundError without a repository row', async () => {
    const { provider } = providerWith(guardedDelete(false, []));

    await expect(provider.deleteEntities(RID, ['e1'])).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    await expect(provider.deleteRelationships(RID, ['r1'])).rejects.toMatchObject({
      name: 'RepositoryNotFoundError',
    });
  });

  it('deleteEntities and deleteRelationships with no ids check the repository row', async () => {
    const missing = providerWith(() => undefined);
    await expect(missing.provider.deleteEntities(RID, [])).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    await expect(missing.provider.deleteRelationships(RID, [])).rejects.toMatchObject({
      name: 'RepositoryNotFoundError',
    });

    const present = providerWith(repositoryRow(true));
    await expect(present.provider.deleteEntities(RID, [])).resolves.toEqual({ deleted: [], notFound: [] });
    await expect(present.provider.deleteRelationships(RID, [])).resolves.toEqual({ deleted: [], notFound: [] });
    expect(present.statements.every((text) => !text.includes('DELETE'))).toBe(true);
  });

  it('deleteEntity and deleteRelationship report a miss by what is missing, repository first', async () => {
    const cases: Array<[boolean, string, string]> = [
      [false, 'RepositoryNotFoundError', 'RepositoryNotFoundError'],
      [true, 'EntityNotFoundError', 'RelationshipNotFoundError'],
    ];
    for (const [repositoryExists, entityError, relationshipError] of cases) {
      const { provider } = providerWith(repositoryRow(repositoryExists));

      await expect(provider.deleteEntity(RID, 'e1')).rejects.toMatchObject({ name: entityError });
      await expect(provider.deleteRelationship(RID, 'r1')).rejects.toMatchObject({ name: relationshipError });
    }
  });

  it('deleteEntities and deleteRelationships treat a batch with no repository check row as a provider failure', async () => {
    const { provider } = providerWith(() => ({ recordsets: [[]] }));

    await expect(provider.deleteEntities(RID, ['e1'])).rejects.toMatchObject({ name: 'ProviderError' });
    await expect(provider.deleteRelationships(RID, ['r1'])).rejects.toMatchObject({ name: 'ProviderError' });
  });

  it('a failed delete batch is a ProviderError carrying the driver error', async () => {
    const failure = Object.assign(new Error('deadlocked'), { name: 'RequestError', number: 1205 });
    const { provider } = providerWith((text) => {
      if (text.includes('DECLARE @deleted TABLE')) throw failure;
      return undefined;
    });

    const thrown: unknown = await provider.deleteRelationships(RID, ['r1']).catch((err: unknown) => err);
    expect(thrown).toMatchObject({ name: 'ProviderError' });
    expect((thrown as Error).cause).toBe(failure);
  });

  it('getVocabulary reads the repository row and the vocabulary in one query', async () => {
    const { provider, statements } = providerWith(() => undefined);

    await expect(provider.getVocabulary(RID)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('dm_repositories');
    expect(statements[0]).toContain('LEFT JOIN');
  });

  it('getRepositoryStats throws RepositoryNotFoundError rather than reporting zero counts', async () => {
    const { provider } = providerWith(() => undefined);

    await expect(provider.getRepositoryStats(RID)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
  });

  it('updateEntity reports a missing repository ahead of a missing entity', async () => {
    const { provider } = providerWith((text) => guardedRead(text, false, []));

    await expect(provider.updateEntity(RID, 'e1', labelUpdate())).rejects.toMatchObject({
      name: 'RepositoryNotFoundError',
    });
  });

  it('updateEntity reports an update that matched no row by what is missing', async () => {
    const cases: Array<[boolean, string]> = [
      [false, 'RepositoryNotFoundError'],
      [true, 'EntityNotFoundError'],
    ];
    for (const [repositoryExists, name] of cases) {
      const { provider } = providerWith((text) => {
        if (text.includes('UPDATE')) return { rowsAffected: [0] };
        if (text.includes('IF NOT EXISTS')) return guardedRead(text, repositoryExists, [ENTITY_ROW]);
        if (text.includes('dm_repositories') && repositoryExists) {
          return { recordset: [{ repository_id: RID, label: 'r', governance_config: '{"mode":"open"}' }] };
        }
        return undefined;
      });

      await expect(provider.updateEntity(RID, 'e1', labelUpdate())).rejects.toMatchObject({ name });
    }
  });

  const guardedReads: Array<[string, (provider: SqlServerStorageProvider) => Promise<unknown>]> = [
    ['getEntity', (p) => p.getEntity(RID, 'e1')],
    ['getEntityBySlug', (p) => p.getEntityBySlug(RID, 'test-type:e1')],
    ['getEntities', (p) => p.getEntities(RID, ['e1'])],
    ['getEntities with no ids', (p) => p.getEntities(RID, [])],
    ['findEntities', (p) => p.findEntities(RID, { searchTerm: 'e', limit: 10, offset: 0 })],
    ['getRelationship', (p) => p.getRelationship(RID, 'r1')],
    ['getEntityRelationships', (p) => p.getEntityRelationships(RID, 'e1')],
    ['getVocabularyChangeLog', (p) => p.getVocabularyChangeLog(RID)],
    ['getTimeline', (p) => p.getTimeline(RID, 'e1', { limit: 10, offset: 0 })],
    [
      'exploreNeighborhood',
      (p) => p.exploreNeighborhood(RID, 'e1', { depth: 1, direction: 'both', limitPerType: 10, offsetPerType: 0 }),
    ],
    ['findPaths', (p) => p.findPaths(RID, 'e1', 'e2', { maxDepth: 2, limit: 10, offset: 0 })],
    [
      'exportAll',
      async (p) => {
        for await (const chunk of p.exportAll(RID)) return chunk;
        return undefined;
      },
    ],
  ];

  it.each(guardedReads)('%s checks the repository in the batch that reads', async (_name, call) => {
    const { provider, statements } = providerWith((text) => guardedRead(text, false, []));

    await expect(call(provider)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('dm_repositories');
  });

  it('reads the result sets after the repository check of an existing repository by position', async () => {
    const { provider } = providerWith((text) =>
      text.includes('COUNT(*) AS cnt')
        ? guardedRead(text, true, [{ cnt: 3 }], [ENTITY_ROW])
        : guardedRead(text, true, [ENTITY_ROW]),
    );

    await expect(provider.getEntity(RID, 'e1')).resolves.toMatchObject({ id: 'e1', entityType: 'test-type' });
    await expect(provider.findEntities(RID, { limit: 1, offset: 0 })).resolves.toMatchObject({
      items: [{ id: 'e1' }],
      total: 3,
      hasMore: true,
      limit: 1,
      offset: 0,
    });
  });

  it.each(guardedReads)('%s treats a batch with no repository check row as a provider failure', async (_name, call) => {
    const { provider } = providerWith(() => ({ recordsets: [[]] }));

    await expect(call(provider)).rejects.toMatchObject({ name: 'ProviderError' });
  });

  const typeDeletes: Array<[string, (provider: SqlServerStorageProvider) => Promise<unknown>]> = [
    ['deleteEntitiesByType', (p) => p.deleteEntitiesByType(RID, 'test-type')],
    ['deleteRelationshipsByType', (p) => p.deleteRelationshipsByType(RID, 'connects')],
  ];

  it.each(typeDeletes)('%s checks the repository in its delete batch', async (_name, call) => {
    const { provider, statements } = providerWith(() => ({
      recordset: [{ repository_exists: 0, deleted_entities: 0, deleted_relationships: 0 }],
    }));

    await expect(call(provider)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('WITH (HOLDLOCK, ROWLOCK)');
  });

  it.each(typeDeletes)('%s treats a batch with no result row as a provider failure', async (_name, call) => {
    const { provider } = providerWith(() => undefined);

    await expect(call(provider)).rejects.toMatchObject({ name: 'ProviderError' });
  });
  const importChunks: ImportChunk[] = [
    {
      entities: [
        {
          id: 'e1',
          entityType: 'test-type',
          slug: 'test-type:e1',
          label: 'e1',
          properties: {},
          provenance: labelUpdate().provenance,
        },
      ],
    },
  ];

  it('importBulk rolls back and raises a ProviderError when the repository check fails, writing nothing', async () => {
    const failure = Object.assign(new Error('connection reset'), { name: 'RequestError' });
    const { provider, statements, transactionCalls } = providerWith((text) => {
      if (text.includes('repository_exists')) throw failure;
      return undefined;
    });

    const thrown: unknown = await provider.importBulk(RID, importChunks).catch((err: unknown) => err);
    expect(thrown).toMatchObject({ name: 'ProviderError' });
    expect((thrown as Error).cause).toBe(failure);
    expect(transactionCalls).toEqual(['begin', 'rollback']);
    expect(statements.some((text) => text.includes('MERGE'))).toBe(false);
  });

  it('importBulk passes its own missing-check-row ProviderError through unchanged', async () => {
    const { provider, transactionCalls } = providerWith(() => ({ recordset: [] }));

    const thrown: unknown = await provider.importBulk(RID, importChunks).catch((err: unknown) => err);
    expect(thrown).toMatchObject({ name: 'ProviderError' });
    expect((thrown as Error).message).toContain('returned no repository check row');
    expect((thrown as Error).cause).toBeUndefined();
    expect(transactionCalls).toEqual(['begin', 'rollback']);
  });

  it('importBulk commits the empty transaction and throws RepositoryNotFoundError without a repository row', async () => {
    const { provider, statements, transactionCalls } = providerWith((text) =>
      text.includes('repository_exists') ? { recordset: [{ repository_exists: 0 }] } : undefined,
    );

    await expect(provider.importBulk(RID, importChunks)).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    expect(transactionCalls).toEqual(['begin', 'commit']);
    expect(statements.some((text) => text.includes('MERGE'))).toBe(false);
  });
});
