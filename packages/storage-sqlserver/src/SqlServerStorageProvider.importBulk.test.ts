// Unit tests for how importBulk treats a relationship id: the statements it
// sends in upsert and insert mode, and how a refused row rolls the import
// back. The provider runs over a fake pool that answers each statement.

import { describe, expect, it } from 'vitest';
import type sql from 'mssql';
import type { ImportChunk, StoredRelationship } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000003';

interface FakeResult {
  recordset: unknown[];
  recordsets: unknown[][];
  rowsAffected: number[];
}

/** What the fake answers for one statement; anything else answers no rows. */
type Answer = (text: string) => Partial<FakeResult> | undefined;

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
      const recordset = result.recordset ?? [];
      return { recordset, recordsets: [recordset], rowsAffected: [0] };
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

function relationship(id: string, type: string, source: string, target: string): StoredRelationship {
  const now = new Date().toISOString();
  return {
    id,
    relationshipType: type,
    sourceEntityId: source,
    targetEntityId: target,
    properties: {},
    bidirectional: false,
    provenance: { createdBy: 't', createdByType: 'agent', createdAt: now, modifiedBy: 't', modifiedByType: 'agent', modifiedAt: now },
  };
}

const chunks: ImportChunk[] = [{ relationships: [relationship('r1', 'links', 'e1', 'e2')] }];

/** An existing repository, and the MERGE reporting `written` rows. */
function upsertWriting(written: number | undefined): Answer {
  return (text) => {
    if (text.includes('repository_exists')) return { recordset: [{ repository_exists: 1 }] };
    if (text.includes('MERGE')) return { recordset: written === undefined ? [] : [{ written }] };
    return undefined;
  };
}

/** A SQL Server primary-key violation on `dm_relationships`, as `mssql` reports it. */
const RELATIONSHIP_PK_VIOLATION = Object.assign(
  new Error("Violation of PRIMARY KEY constraint 'pk_dm_relationships'. Cannot insert duplicate key in object 'dbo.dm_relationships'."),
  { name: 'RequestError', number: 2627 },
);

describe('SqlServerStorageProvider importBulk relationship ids', () => {
  it('upserts only the same edge and never rewrites a stored type or endpoints', async () => {
    const { provider, statements, transactionCalls } = providerWith(upsertWriting(1));

    const result = await provider.importBulk(RID, chunks);

    expect(result).toEqual({ entitiesImported: 0, relationshipsImported: 1, errors: [] });
    expect(transactionCalls).toEqual(['begin', 'commit']);
    const merge = statements.find((text) => text.includes('MERGE'));
    expect(merge).toBeDefined();
    const [matched, update] = (merge ?? '').split('THEN UPDATE SET');
    expect(matched).toContain('target.[relationship_type] COLLATE Latin1_General_100_BIN2 = @relType');
    expect(matched).toContain('DATALENGTH(target.[relationship_type]) = DATALENGTH(@relType)');
    expect(matched).toContain('target.[source_entity_id] = @sourceId');
    expect(matched).toContain('target.[target_entity_id] = @targetId');
    const updateSet = (update ?? '').split('WHEN NOT MATCHED')[0] ?? '';
    expect(updateSet).not.toMatch(/\[relationship_type\]|\[source_entity_id\]|\[target_entity_id\]/);
    expect(merge).toContain('SELECT @@ROWCOUNT AS written');
  });

  it('refuses a stored id on another edge by rolling the import back with RELATIONSHIP_ALREADY_EXISTS as the cause', async () => {
    const { provider, transactionCalls } = providerWith(upsertWriting(0));

    const thrown: unknown = await provider.importBulk(RID, chunks).catch((err: unknown) => err);

    expect(thrown).toMatchObject({ name: 'ImportError', code: 'IMPORT_ERROR' });
    expect((thrown as Error).message).toContain('relationship:r1 failed');
    expect((thrown as Error).cause).toMatchObject({
      name: 'DuplicateRelationshipError',
      code: 'RELATIONSHIP_ALREADY_EXISTS',
      relationshipId: 'r1',
    });
    expect(transactionCalls).toEqual(['begin', 'rollback']);
  });

  it('reports a MERGE that returns no row count as a ProviderError, not a refusal', async () => {
    const { provider, transactionCalls } = providerWith(upsertWriting(undefined));

    const thrown: unknown = await provider.importBulk(RID, chunks).catch((err: unknown) => err);

    expect(thrown).toMatchObject({ name: 'ProviderError' });
    expect(transactionCalls).toEqual(['begin', 'rollback']);
  });

  it('inserts without looking for the id in insert mode', async () => {
    const { provider, statements, transactionCalls } = providerWith((text) =>
      text.includes('repository_exists') ? { recordset: [{ repository_exists: 1 }] } : undefined,
    );

    const result = await provider.importBulk(RID, chunks, { skipExistenceCheck: true });

    expect(result.relationshipsImported).toBe(1);
    expect(transactionCalls).toEqual(['begin', 'commit']);
    const writes = statements.filter((text) => text.includes('dm_relationships'));
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('INSERT INTO');
    expect(writes[0]).not.toContain('MERGE');
  });

  it('refuses an id the primary key already holds in insert mode with RELATIONSHIP_ALREADY_EXISTS as the cause', async () => {
    const { provider, transactionCalls } = providerWith((text) => {
      if (text.includes('repository_exists')) return { recordset: [{ repository_exists: 1 }] };
      if (text.includes('dm_relationships')) throw RELATIONSHIP_PK_VIOLATION;
      return undefined;
    });

    const thrown: unknown = await provider.importBulk(RID, chunks, { skipExistenceCheck: true }).catch((err: unknown) => err);

    expect(thrown).toMatchObject({ name: 'ImportError', code: 'IMPORT_ERROR' });
    expect((thrown as Error).cause).toMatchObject({ code: 'RELATIONSHIP_ALREADY_EXISTS', relationshipId: 'r1' });
    expect(transactionCalls).toEqual(['begin', 'rollback']);
  });
});
