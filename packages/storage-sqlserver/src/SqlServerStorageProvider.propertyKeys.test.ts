// Unit tests for the property-key check on direct provider writes: a key that
// is not an identifier, or that names a system field, is refused before any
// row is written. An update checks only the keys it sets, so a stored key
// carried over unchanged is not refused. The provider runs over a fake pool
// that records every statement and transaction call.

import { describe, expect, it } from 'vitest';
import type sql from 'mssql';
import { ImportError, InvalidInputError, RepositoryNotFoundError } from '@utaba/deep-memory';
import type { ImportChunk, StoredEntity, StoredRelationship } from '@utaba/deep-memory/types';
import { SqlServerStorageProvider } from './SqlServerStorageProvider.js';

const RID = '50000000-0000-4000-a000-000000000004';

interface FakeResult {
  recordset: unknown[];
  recordsets: unknown[][];
  rowsAffected: number[];
}

/**
 * A provider over a fake pool that records every statement. Statements answer
 * no rows unless an option says otherwise: `repositoryExists` answers
 * `importBulk`'s repository check, and `storedProperties` makes entity `e1`
 * exist with those properties, so `updateEntity` reads it and its UPDATE
 * lands. `inputs` holds the last value bound under each parameter name.
 */
function recordingProvider(
  options: { repositoryExists?: boolean; storedProperties?: Record<string, unknown> } = {},
): { provider: SqlServerStorageProvider; calls: string[]; inputs: Map<string, unknown> } {
  const calls: string[] = [];
  const inputs = new Map<string, unknown>();
  interface FakeRequest {
    input(name: string, ...typeAndValue: unknown[]): FakeRequest;
    query(text: string): Promise<FakeResult>;
  }
  const request: FakeRequest = {
    input(name: string, ...typeAndValue: unknown[]): FakeRequest {
      inputs.set(name, typeAndValue[typeAndValue.length - 1]);
      return request;
    },
    async query(text: string): Promise<FakeResult> {
      calls.push(text);
      const stored = options.storedProperties;
      if (stored !== undefined && text.includes('UPDATE') && text.includes('[dm_entities]')) {
        return { recordset: [], recordsets: [[]], rowsAffected: [1] };
      }
      if (stored !== undefined && text.includes('AS repository_exists') && text.includes('[dm_entities]')) {
        const row = {
          entity_id: 'e1',
          slug: 'test-type:e1',
          entity_type: 'test-type',
          label: 'e1',
          properties: JSON.stringify(stored),
          created_by: 't',
          created_by_type: 'agent',
          created_at: '2026-01-01T00:00:00.000Z',
          modified_by: 't',
          modified_by_type: 'agent',
          modified_at: '2026-01-01T00:00:00.000Z',
        };
        return { recordset: [{ repository_exists: 1 }], recordsets: [[{ repository_exists: 1 }], [row]], rowsAffected: [1, 1] };
      }
      if (options.repositoryExists !== undefined && text.includes('AS repository_exists')) {
        const recordset = [{ repository_exists: options.repositoryExists ? 1 : 0 }];
        return { recordset, recordsets: [recordset], rowsAffected: [1] };
      }
      return { recordset: [], recordsets: [[]], rowsAffected: [0] };
    },
  };
  const transaction = {
    async begin(): Promise<void> {
      calls.push('begin');
    },
    request: () => request as unknown as sql.Request,
    async commit(): Promise<void> {
      calls.push('commit');
    },
    async rollback(): Promise<void> {
      calls.push('rollback');
    },
  };
  const provider = new SqlServerStorageProvider({ connection: { server: 'unused', database: 'unused' } });
  (provider as unknown as { pool: Pick<sql.ConnectionPool, 'request' | 'transaction'> }).pool = {
    request: () => request as unknown as sql.Request,
    transaction: () => transaction as unknown as sql.Transaction,
  };
  return { provider, calls, inputs };
}

/** Whether any recorded statement is an entity UPDATE. */
function wroteEntity(calls: readonly string[]): boolean {
  return calls.some((text) => text.includes('UPDATE') && text.includes('[dm_entities]'));
}

function provenance(): StoredEntity['provenance'] {
  const now = new Date().toISOString();
  return { createdBy: 't', createdByType: 'agent', createdAt: now, modifiedBy: 't', modifiedByType: 'agent', modifiedAt: now };
}

function entity(id: string, properties: StoredEntity['properties']): StoredEntity {
  return {
    id,
    slug: `test-type:${id}`,
    entityType: 'test-type',
    label: id,
    properties,
    provenance: provenance(),
  };
}

function relationship(id: string, properties: StoredRelationship['properties']): StoredRelationship {
  return {
    id,
    relationshipType: 'connects',
    sourceEntityId: 'e1',
    targetEntityId: 'e2',
    properties,
    bidirectional: false,
    provenance: provenance(),
  };
}

async function refusal(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('expected the call to be refused');
    },
    (err: unknown) => err,
  );
}

describe('SqlServerStorageProvider property keys on direct writes', () => {
  it.each(['start-date', 'label', 'createdInConversation'])(
    'createEntity refuses the key "%s" without issuing SQL',
    async (key) => {
      const { provider, calls } = recordingProvider();

      const thrown = await refusal(provider.createEntity(RID, entity('e1', { [key]: 'x' })));

      expect(thrown).toBeInstanceOf(InvalidInputError);
      expect((thrown as InvalidInputError).field).toBe(`properties.${key}`);
      expect(calls).toEqual([]);
    },
  );

  it.each(['start-date', 'slug'])('updateEntity refuses setting the key "%s" without writing', async (key) => {
    const { provider, calls } = recordingProvider({ storedProperties: { key: 'value' } });

    const thrown = await refusal(
      provider.updateEntity(RID, 'e1', { properties: { key: 'value', [key]: 'x' }, provenance: provenance() }),
    );

    expect(thrown).toBeInstanceOf(InvalidInputError);
    expect((thrown as InvalidInputError).code).toBe('INVALID_INPUT');
    expect((thrown as InvalidInputError).field).toBe(`properties.${key}`);
    expect(wroteEntity(calls)).toBe(false);
  });

  it('updateEntity carries over an unchanged stored key the rules refuse while another key changes', async () => {
    const { provider, inputs } = recordingProvider({ storedProperties: { 'start-date': '2020', ok: 1 } });

    const updated = await provider.updateEntity(RID, 'e1', {
      properties: { 'start-date': '2020', ok: 2 },
      provenance: provenance(),
    });

    expect(updated.properties).toEqual({ 'start-date': '2020', ok: 2 });
    expect(JSON.parse(inputs.get('properties') as string)).toEqual({ 'start-date': '2020', ok: 2 });
  });

  it('updateEntity removes a stored key the rules refuse', async () => {
    const { provider, inputs } = recordingProvider({ storedProperties: { 'start-date': '2020', ok: 1 } });

    const updated = await provider.updateEntity(RID, 'e1', { properties: { ok: 1 }, provenance: provenance() });

    expect(updated.properties).toEqual({ ok: 1 });
    expect(JSON.parse(inputs.get('properties') as string)).toEqual({ ok: 1 });
  });

  it('updateEntity refuses a new value for a stored key the rules refuse', async () => {
    const { provider, calls } = recordingProvider({ storedProperties: { 'start-date': '2020' } });

    const thrown = await refusal(
      provider.updateEntity(RID, 'e1', { properties: { 'start-date': '2021' }, provenance: provenance() }),
    );

    expect(thrown).toBeInstanceOf(InvalidInputError);
    expect((thrown as InvalidInputError).field).toBe('properties.start-date');
    expect(wroteEntity(calls)).toBe(false);
  });

  it('updateEntity without properties does not check property keys', async () => {
    const { provider, calls } = recordingProvider();

    // The fake answers no rows, so the read finds nothing; what matters is
    // that the call reached SQL Server rather than being refused up front.
    await refusal(provider.updateEntity(RID, 'e1', { label: 'renamed', provenance: provenance() }));

    expect(calls.length).toBeGreaterThan(0);
  });

  it.each(['start-date', 'label'])('createRelationship refuses the key "%s" without issuing SQL', async (key) => {
    const { provider, calls } = recordingProvider();

    const thrown = await refusal(provider.createRelationship(RID, relationship('r1', { [key]: 'x' })));

    expect(thrown).toBeInstanceOf(InvalidInputError);
    expect((thrown as InvalidInputError).field).toBe(`properties.${key}`);
    expect(calls).toEqual([]);
  });

  it('createRelationship accepts "summary", which is reserved only on entities', async () => {
    const { provider, calls } = recordingProvider();

    // The fake reports no repository, so the call fails past the key check.
    const thrown = await refusal(provider.createRelationship(RID, relationship('r1', { summary: 'x' })));

    expect(thrown).not.toBeInstanceOf(InvalidInputError);
    expect(calls.length).toBeGreaterThan(0);
  });

  it('importBulk refuses an entity row with an unwritable key, naming the row, before writing any row', async () => {
    const { provider, calls } = recordingProvider({ repositoryExists: true });
    const data: ImportChunk[] = [
      { entities: [entity('e1', { ok: 1 }), entity('e2', { 'start-date': 'x' })] },
    ];

    const thrown = await refusal(provider.importBulk(RID, data));

    expect(thrown).toBeInstanceOf(ImportError);
    expect((thrown as ImportError).message).toContain('entity:e2 failed');
    const cause = (thrown as ImportError).cause;
    expect(cause).toBeInstanceOf(InvalidInputError);
    expect((cause as InvalidInputError).field).toBe('properties.start-date');
    expectOnlyRepositoryCheck(calls);
  });

  it('importBulk refuses a relationship row with a reserved key in a later chunk before writing any row', async () => {
    const { provider, calls } = recordingProvider({ repositoryExists: true });
    const data: ImportChunk[] = [
      { entities: [entity('e1', {}), entity('e2', {})] },
      { relationships: [relationship('r1', { createdBy: 'someone' })] },
    ];

    const thrown = await refusal(provider.importBulk(RID, data));

    expect(thrown).toBeInstanceOf(ImportError);
    expect((thrown as ImportError).message).toContain('relationship:r1 failed');
    const cause = (thrown as ImportError).cause;
    expect(cause).toBeInstanceOf(InvalidInputError);
    expect((cause as InvalidInputError).field).toBe('properties.createdBy');
    expectOnlyRepositoryCheck(calls);
  });

  it('importBulk answers RepositoryNotFoundError for a missing repository even when a row is refusable', async () => {
    const { provider, calls } = recordingProvider({ repositoryExists: false });
    const data: ImportChunk[] = [{ entities: [entity('e1', { 'start-date': 'x' })] }];

    const thrown = await refusal(provider.importBulk(RID, data));

    expect(thrown).toBeInstanceOf(RepositoryNotFoundError);
    expect(calls[0]).toBe('begin');
    expect(calls[1]).toContain('AS repository_exists');
    expect(calls.slice(2)).toEqual(['commit']);
  });
});

/** The import began, checked the repository, and rolled back without writing a row. */
function expectOnlyRepositoryCheck(calls: readonly string[]): void {
  expect(calls).toHaveLength(3);
  expect(calls[0]).toBe('begin');
  expect(calls[1]).toContain('AS repository_exists');
  expect(calls[2]).toBe('rollback');
}
