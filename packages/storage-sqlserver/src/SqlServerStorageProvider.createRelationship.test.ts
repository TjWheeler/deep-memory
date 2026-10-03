import { describe, expect, it } from 'vitest';
import type sql from 'mssql';
import type { StoredRelationship } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000001';

interface Preconditions {
  repository_exists: number;
  relationship_exists: number;
  source_exists: number;
  target_exists: number;
}

const ALL_PRESENT: Preconditions = {
  repository_exists: 1,
  relationship_exists: 0,
  source_exists: 1,
  target_exists: 1,
};

function relationship(): StoredRelationship {
  const now = new Date().toISOString();
  return {
    id: 'r1',
    relationshipType: 'connects',
    sourceEntityId: 'a',
    targetEntityId: 'b',
    properties: {},
    bidirectional: false,
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

/** Mirror of the `mssql` RequestError surface for a foreign-key conflict. */
function foreignKeyError(): Error & { number: number } {
  return Object.assign(new Error('The INSERT statement conflicted with the FOREIGN KEY constraint'), {
    name: 'RequestError',
    number: 547,
  });
}

/**
 * A provider over a fake pool: each precondition read returns the next entry
 * of `reads`, and the INSERT fails with `insertError` (or succeeds).
 */
function providerWith(reads: Preconditions[], insertError?: Error): {
  provider: SqlServerStorageProvider;
  statements: string[];
} {
  const statements: string[] = [];
  interface FakeRequest {
    input(): FakeRequest;
    query(text: string): Promise<{ recordset: Preconditions[] }>;
  }
  const request: FakeRequest = {
    input(): FakeRequest {
      return request;
    },
    async query(text: string): Promise<{ recordset: Preconditions[] }> {
      statements.push(text);
      if (text.includes('INSERT INTO')) {
        if (insertError !== undefined) throw insertError;
        return { recordset: [] };
      }
      const next = reads.shift();
      return { recordset: next === undefined ? [] : [next] };
    },
  };
  const provider = new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' } });
  (provider as unknown as { pool: Pick<sql.ConnectionPool, 'request'> }).pool = {
    request: () => request as unknown as sql.Request,
  };
  return { provider, statements };
}

describe('SqlServerStorageProvider.createRelationship', () => {
  it('checks repository, id, source and target in that order before the INSERT', async () => {
    const cases: Array<[Partial<Preconditions>, Record<string, unknown>]> = [
      [{ repository_exists: 0, relationship_exists: 1, source_exists: 0 }, { name: 'RepositoryNotFoundError' }],
      [{ relationship_exists: 1, source_exists: 0 }, { name: 'DuplicateRelationshipError', relationshipId: 'r1' }],
      [{ source_exists: 0, target_exists: 0 }, { name: 'EntityNotFoundError', id: 'a' }],
      [{ target_exists: 0 }, { name: 'EntityNotFoundError', id: 'b' }],
    ];
    for (const [read, expected] of cases) {
      const { provider, statements } = providerWith([{ ...ALL_PRESENT, ...read }]);
      await expect(provider.createRelationship(RID, relationship())).rejects.toMatchObject(expected);
      expect(statements.some((s) => s.includes('INSERT INTO'))).toBe(false);
    }
  });

  it('reports a precondition read with no row as ProviderError', async () => {
    const { provider } = providerWith([]);
    await expect(provider.createRelationship(RID, relationship())).rejects.toMatchObject({
      name: 'ProviderError',
    });
  });

  it('names what a foreign-key failure found missing on a second read, repository first', async () => {
    const cases: Array<[Partial<Preconditions>, Record<string, unknown>]> = [
      [{ repository_exists: 0, source_exists: 0 }, { name: 'RepositoryNotFoundError' }],
      [{ source_exists: 0, target_exists: 0 }, { name: 'EntityNotFoundError', id: 'a' }],
      [{ target_exists: 0 }, { name: 'EntityNotFoundError', id: 'b' }],
    ];
    for (const [read, expected] of cases) {
      const { provider, statements } = providerWith([ALL_PRESENT, { ...ALL_PRESENT, ...read }], foreignKeyError());
      await expect(provider.createRelationship(RID, relationship())).rejects.toMatchObject(expected);
      expect(statements).toHaveLength(3);
    }
  });

  it('reports a foreign-key failure as ProviderError with cause when everything still exists', async () => {
    const original = foreignKeyError();
    const { provider } = providerWith([ALL_PRESENT, ALL_PRESENT], original);

    const thrown: unknown = await provider.createRelationship(RID, relationship()).catch((err: unknown) => err);
    expect(thrown).toMatchObject({ name: 'ProviderError', code: 'PROVIDER_ERROR' });
    expect((thrown as Error).cause).toBe(original);
  });

  it('maps a primary-key clash on the INSERT to DuplicateRelationshipError without a second read', async () => {
    const clash = Object.assign(
      new Error("Violation of PRIMARY KEY constraint 'pk_dm_relationships'. Cannot insert duplicate key."),
      { name: 'RequestError', number: 2627 },
    );
    const { provider, statements } = providerWith([ALL_PRESENT], clash);

    await expect(provider.createRelationship(RID, relationship())).rejects.toMatchObject({
      name: 'DuplicateRelationshipError',
      relationshipId: 'r1',
    });
    expect(statements).toHaveLength(2);
  });
});
