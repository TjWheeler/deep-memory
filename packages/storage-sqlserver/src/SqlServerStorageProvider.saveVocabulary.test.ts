import { describe, expect, it } from 'vitest';
import type sql from 'mssql';
import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000003';

type InputValue = string | null;

interface FakeResult {
  recordset: unknown[];
  recordsets: unknown[][];
  rowsAffected: number[];
}

/** One request sent to the fake pool: its bound inputs and its statement text. */
interface SentRequest {
  inputs: Map<string, InputValue>;
  text: string;
}

/**
 * A provider over a fake pool. Each request records its inputs and text in
 * `sent`, and is answered by `answer` with the result sets it returns, or
 * fails with the error `answer` throws.
 */
function providerWith(answer: (request: SentRequest) => unknown[][]): {
  provider: SqlServerStorageProvider;
  sent: SentRequest[];
} {
  const sent: SentRequest[] = [];
  interface FakeRequest {
    input(name: string, type: unknown, value: InputValue): FakeRequest;
    query(text: string): Promise<FakeResult>;
  }
  function newRequest(): FakeRequest {
    const inputs = new Map<string, InputValue>();
    const request: FakeRequest = {
      input(name: string, _type: unknown, value: InputValue): FakeRequest {
        inputs.set(name, value);
        return request;
      },
      async query(text: string): Promise<FakeResult> {
        const entry = { inputs, text };
        sent.push(entry);
        const recordsets = answer(entry);
        return { recordset: recordsets[0] ?? [], recordsets, rowsAffected: [0] };
      },
    };
    return request;
  }
  const provider = new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' } });
  (provider as unknown as { pool: Pick<sql.ConnectionPool, 'request'> }).pool = {
    request: () => newRequest() as unknown as sql.Request,
  };
  return { provider, sent };
}

function vocabulary(version: string): MemoryVocabulary {
  return {
    version,
    lastModified: '2026-01-01T00:00:00.000Z',
    modifiedBy: 'test',
    entityTypes: [],
    relationshipTypes: [],
  };
}

const FULL_RECORD: VocabularyChangeRecord = {
  changeId: 'change_1',
  changeType: 'entity_type_removed',
  typeName: 'project',
  previousVersion: '1.0.0',
  newVersion: '2.0.0',
  proposedBy: 'agent-x',
  proposedAt: '2026-01-01T00:00:00.000Z',
  approvedBy: 'admin',
  approvedAt: '2026-01-01T00:00:01.000Z',
  reason: 'No longer needed',
};

/** The batch's result row when the compare-and-set matched. */
const SAVED = [[{ repository_exists: 1, updated: 1, vocabulary_exists: 0, stored_version: null }]];

/** Pairs each column of the change-log INSERT with the value bound to the parameter it is given. */
function insertedRow(request: SentRequest): Record<string, InputValue | undefined> {
  const match = /INSERT INTO \[dbo\]\.\[dm_vocabulary_change_log\]\s*\(([^)]*)\)\s*VALUES\s*\(([^)]*)\)/.exec(
    request.text,
  );
  if (match === null) throw new Error('No change-log INSERT in the batch');
  const columns = (match[1] ?? '').split(',').map((c) => c.trim().replace(/^\[|\]$/g, ''));
  const params = (match[2] ?? '').split(',').map((p) => p.trim().replace(/^@/, ''));
  expect(columns).toHaveLength(params.length);
  const row: Record<string, InputValue | undefined> = {};
  columns.forEach((column, i) => {
    const param = params[i] ?? '';
    row[column] = param === 'id' ? RID : request.inputs.get(param);
  });
  return row;
}

describe('SqlServerStorageProvider.saveVocabulary', () => {
  it('inserts the change record in the compare-and-set transaction, only when the update matched', async () => {
    const { provider, sent } = providerWith(() => SAVED);

    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD);

    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;
    const order = [
      'SET XACT_ABORT ON',
      'BEGIN TRANSACTION',
      'FROM [dbo].[dm_repositories] WITH (HOLDLOCK, ROWLOCK)',
      'IF @repositories = 1',
      'UPDATE [dbo].[dm_vocabularies]',
      'SET @updated = @@ROWCOUNT',
      'IF @updated > 0',
      'INSERT INTO [dbo].[dm_vocabulary_change_log]',
      'IF @updated = 0',
      'COMMIT TRANSACTION',
      'SELECT @repositories AS repository_exists',
    ].map((fragment) => text.indexOf(fragment));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('matches the expected version exactly: case-sensitive and trailing spaces significant', async () => {
    const { provider, sent } = providerWith(() => SAVED);

    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0');

    const where = /UPDATE \[dbo\]\.\[dm_vocabularies\][\s\S]*?;/.exec(sent[0]!.text)?.[0] ?? '';
    expect(where).toContain(
      "JSON_VALUE([vocabulary], '$.version') COLLATE Latin1_General_100_BIN2 = @expectedVersion",
    );
    expect(where).toContain(
      "DATALENGTH(JSON_VALUE([vocabulary], '$.version')) = DATALENGTH(@expectedVersion)",
    );
    expect(sent[0]!.inputs.get('expectedVersion')).toBe('1.0.0');
  });

  it('pages the change log newest first, with changeId breaking ties between equal stamps', async () => {
    const reader = providerWith(() => [[{ repository_exists: 1 }], [{ cnt: 0 }], []]);

    await reader.provider.getVocabularyChangeLog(RID);

    expect(reader.sent[0]!.text).toContain('ORDER BY [proposed_at] DESC, [change_id] DESC');
  });

  it('writes every record field to its column, and the change-log read maps the row back to the record', async () => {
    const { provider, sent } = providerWith(() => SAVED);
    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD);
    const row = insertedRow(sent[0]!);

    expect(row).toEqual({
      change_id: 'change_1',
      repository_id: RID,
      change_type: 'entity_type_removed',
      type_name: 'project',
      previous_version: '1.0.0',
      new_version: '2.0.0',
      proposed_by: 'agent-x',
      proposed_at: '2026-01-01T00:00:00.000Z',
      approved_by: 'admin',
      approved_at: '2026-01-01T00:00:01.000Z',
      reason: 'No longer needed',
    });

    const reader = providerWith(() => [[{ repository_exists: 1 }], [{ cnt: 1 }], [row]]);
    const log = await reader.provider.getVocabularyChangeLog(RID);
    expect(log.items).toEqual([FULL_RECORD]);
  });

  it('binds the absent optional fields as NULL', async () => {
    const { provider, sent } = providerWith(() => SAVED);
    const { previousVersion: _p, approvedBy: _b, approvedAt: _a, ...required } = FULL_RECORD;

    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', required);

    const row = insertedRow(sent[0]!);
    expect(row['previous_version']).toBeNull();
    expect(row['approved_by']).toBeNull();
    expect(row['approved_at']).toBeNull();
  });

  it('without a change record, writes no change-log row', async () => {
    const { provider, sent } = providerWith(() => SAVED);

    await provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0');

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).not.toContain('dm_vocabulary_change_log');
    expect(sent[0]!.inputs.has('changeId')).toBe(false);
  });

  it('reports a stale version as VocabularyVersionConflictError from the same round trip', async () => {
    const { provider, sent } = providerWith(() => [
      [{ repository_exists: 1, updated: 0, vocabulary_exists: 1, stored_version: '3.0.0' }],
    ]);

    await expect(
      provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD),
    ).rejects.toMatchObject({
      name: 'VocabularyVersionConflictError',
      expectedVersion: '1.0.0',
      actualVersion: '3.0.0',
    });
    expect(sent).toHaveLength(1);
  });

  it('reports a missing repository as RepositoryNotFoundError from the same round trip', async () => {
    const { provider, sent } = providerWith(() => [
      [{ repository_exists: 0, updated: 0, vocabulary_exists: 0, stored_version: null }],
    ]);

    await expect(
      provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD),
    ).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
    expect(sent).toHaveLength(1);
  });

  it('reports a repository without a vocabulary row as RepositoryNotFoundError', async () => {
    const { provider } = providerWith(() => [
      [{ repository_exists: 1, updated: 0, vocabulary_exists: 0, stored_version: null }],
    ]);

    await expect(
      provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD),
    ).rejects.toMatchObject({ name: 'RepositoryNotFoundError' });
  });

  it('reports a stored vocabulary with no readable version as ProviderError, not a conflict', async () => {
    const { provider } = providerWith(() => [
      [{ repository_exists: 1, updated: 0, vocabulary_exists: 1, stored_version: null }],
    ]);

    await expect(
      provider.saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD),
    ).rejects.toMatchObject({ name: 'ProviderError' });
  });

  it('reports a failed batch as ProviderError with the driver error as cause', async () => {
    const failure = Object.assign(new Error('String or binary data would be truncated'), {
      name: 'RequestError',
      number: 2628,
    });
    const { provider, sent } = providerWith(() => {
      throw failure;
    });

    const thrown: unknown = await provider
      .saveVocabulary(RID, vocabulary('2.0.0'), '1.0.0', FULL_RECORD)
      .catch((err: unknown) => err);

    expect(thrown).toMatchObject({ name: 'ProviderError', code: 'PROVIDER_ERROR' });
    expect((thrown as Error).cause).toBe(failure);
    expect(sent).toHaveLength(1);
  });
});
