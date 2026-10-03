import { describe, expect, it } from 'vitest';
import type sql from 'mssql';
import type { StoredEntityUpdate } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000002';

interface FakeResult {
  recordset: unknown[];
  recordsets: unknown[][];
  rowsAffected: number[];
}

/** What the fake answers for one statement; anything else answers no rows. */
type Answer = (text: string) => Partial<FakeResult> | undefined;

/** A provider over a fake pool that answers each statement through `answer`. */
function providerWith(answer: Answer): { provider: SqlServerStorageProvider; statements: string[] } {
  const statements: string[] = [];
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
  const provider = new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' } });
  (provider as unknown as { pool: Pick<sql.ConnectionPool, 'request'> }).pool = {
    request: () => request as unknown as sql.Request,
  };
  return { provider, statements };
}

/** Answers for the guarded delete batch: whether the repository row exists, and the ids removed. */
function guardedDelete(repositoryExists: boolean, deletedIds: string[]): Answer {
  return (text) =>
    text.includes('DECLARE @deleted TABLE')
      ? { recordsets: [[{ repository_exists: repositoryExists ? 1 : 0 }], deletedIds.map((id) => ({ id }))] }
      : undefined;
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
    const { provider } = providerWith(() => undefined);

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
        if (text.includes('dm_entities')) return { recordset: [ENTITY_ROW] };
        if (text.includes('dm_repositories') && repositoryExists) {
          return { recordset: [{ repository_id: RID, label: 'r', governance_config: '{"mode":"open"}' }] };
        }
        return undefined;
      });

      await expect(provider.updateEntity(RID, 'e1', labelUpdate())).rejects.toMatchObject({ name });
    }
  });
});
