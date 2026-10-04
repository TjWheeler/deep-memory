import { describe, expect, it } from 'vitest';
import {
  DeepMemoryError,
  ProviderError,
  RepositoryNotFoundError,
  VocabularyVersionConflictError,
} from '@utaba/deep-memory';
import type { MemoryVocabulary, VocabularyChangeRecord } from '@utaba/deep-memory/types';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { changeRecordToProperties } from '../mapping.js';
import {
  getVocabulary,
  getVocabularyChangeLog,
  saveVocabulary,
  VOCABULARY_CHANGE_LOG_PAGE_QUERY,
  VOCABULARY_SAVE_OUTCOME_QUERY,
  VOCABULARY_SAVE_QUERY,
} from './vocabulary.js';

const RID = 'repo-change-log';

/** A driver error the mapping does not recognise. */
const DRIVER_FAILURE = Object.assign(new Error('database unavailable'), { code: 'Neo.DatabaseError.General.UnknownError' });

/** A connection whose statements answer one row each through `answer`, or reject with what it throws. */
function answeringConnection(answer: (cypher: string) => Record<string, unknown> | undefined): Neo4jConnection {
  return {
    executeQuery: async (cypher: string) => {
      const row = answer(cypher);
      return { records: row === undefined ? [] : [{ get: (key: string) => row[key] }] };
    },
  } as unknown as Neo4jConnection;
}

/** The change-log count statement, which also reads the repository marker. */
const isCount = (cypher: string): boolean => cypher.includes('repositoryExists');

describe('getVocabularyChangeLog', () => {
  it('reports a missing repository ahead of a failed page', async () => {
    const conn = answeringConnection((cypher) => {
      if (isCount(cypher)) return { repositoryExists: false, total: 0n };
      throw DRIVER_FAILURE;
    });

    await expect(getVocabularyChangeLog(conn, RID)).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('raises a failed page as a typed error once the marker is found', async () => {
    const conn = answeringConnection((cypher) => {
      if (isCount(cypher)) return { repositoryExists: true, total: 0n };
      throw DRIVER_FAILURE;
    });

    const thrown: unknown = await getVocabularyChangeLog(conn, RID).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(DRIVER_FAILURE);
  });
});

describe('saveVocabulary', () => {
  const VOCABULARY: MemoryVocabulary = {
    version: '1.1.0',
    lastModified: '2026-01-01T00:00:00.000Z',
    modifiedBy: 'tester',
    entityTypes: [],
    relationshipTypes: [],
  };
  const RECORD: VocabularyChangeRecord = {
    changeId: 'change-1',
    changeType: 'entity_type_added',
    typeName: 'person',
    newVersion: '1.1.0',
    proposedBy: 'tester',
    proposedAt: '2026-01-01T00:00:00.000Z',
    reason: 'needed',
  };

  /** A connection answering the write with `written` and the outcome read with `outcome`; records the calls. */
  function saveConnection(written: bigint, outcome?: Record<string, unknown>) {
    const calls: Array<{ cypher: string; params: Record<string, unknown> }> = [];
    const conn = {
      executeQuery: async (cypher: string, params: Record<string, unknown>) => {
        calls.push({ cypher, params });
        const row = cypher === VOCABULARY_SAVE_QUERY ? { written } : outcome;
        return { records: row === undefined ? [] : [{ get: (key: string) => row[key] }] };
      },
    } as unknown as Neo4jConnection;
    return { conn, calls };
  }

  it('sends the change record with the compare-and-set, as its stored properties', async () => {
    const { conn, calls } = saveConnection(1n);
    await saveVocabulary(conn, RID, VOCABULARY, '1.0.0', RECORD);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.cypher).toBe(VOCABULARY_SAVE_QUERY);
    expect(calls[0]?.params['change']).toEqual(changeRecordToProperties(RECORD));
    expect(calls[0]?.params['expectedVersion']).toBe('1.0.0');
    expect(calls[0]?.params['newVersion']).toBe('1.1.0');
  });

  it('sends a null change when no record is given', async () => {
    const { conn, calls } = saveConnection(1n);
    await saveVocabulary(conn, RID, VOCABULARY, '1.0.0');
    expect(calls[0]?.params['change']).toBeNull();
  });

  it('writes the record only on the path that writes the vocabulary, and merges it on its key', () => {
    expect(VOCABULARY_SAVE_QUERY).toContain('CASE WHEN ok AND $change IS NOT NULL THEN [1] ELSE [] END');
    expect(VOCABULARY_SAVE_QUERY).toContain(
      'MERGE (c:_VocabularyChangeLog {repositoryId: $rid, changeId: $change.changeId})',
    );
    // The marker is locked, then matched again, before the vocabulary is touched.
    expect(VOCABULARY_SAVE_QUERY.indexOf('SET repo._lock')).toBeLessThan(VOCABULARY_SAVE_QUERY.indexOf('_Vocabulary'));
  });

  it('throws RepositoryNotFoundError when the marker is gone, even with the vocabulary node left behind', async () => {
    const { conn } = saveConnection(0n, {
      repositoryExists: false,
      vocabularyExists: true,
      version: '1.0.0',
      json: JSON.stringify({ ...VOCABULARY, version: '1.0.0' }),
    });
    await expect(saveVocabulary(conn, RID, VOCABULARY, '1.0.0', RECORD)).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
  });

  it('throws RepositoryNotFoundError when the vocabulary node is gone', async () => {
    const { conn } = saveConnection(0n, { repositoryExists: true, vocabularyExists: false, version: null, json: null });
    await expect(saveVocabulary(conn, RID, VOCABULARY, '1.0.0')).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('reports success when a re-run finds its own committed write', async () => {
    const { conn, calls } = saveConnection(0n, {
      repositoryExists: true,
      vocabularyExists: true,
      version: '1.1.0',
      json: JSON.stringify(VOCABULARY),
    });
    await expect(saveVocabulary(conn, RID, VOCABULARY, '1.0.0', RECORD)).resolves.toBeUndefined();
    expect(calls.map((c) => c.cypher)).toEqual([VOCABULARY_SAVE_QUERY, VOCABULARY_SAVE_OUTCOME_QUERY]);
  });

  it('throws VocabularyVersionConflictError carrying the stored version', async () => {
    const { conn } = saveConnection(0n, {
      repositoryExists: true,
      vocabularyExists: true,
      version: '1.0.5',
      json: JSON.stringify({ ...VOCABULARY, version: '1.0.5' }),
    });
    await expect(saveVocabulary(conn, RID, VOCABULARY, '1.0.0', RECORD)).rejects.toBeInstanceOf(
      VocabularyVersionConflictError,
    );
  });

  it('reports an outcome read with no row as ProviderError', async () => {
    const { conn } = saveConnection(0n);
    await expect(saveVocabulary(conn, RID, VOCABULARY, '1.0.0')).rejects.toBeInstanceOf(ProviderError);
  });
});

describe('vocabulary statements on a failing driver', () => {
  const VOCABULARY: MemoryVocabulary = {
    version: '1.1.0',
    lastModified: '2026-01-01T00:00:00.000Z',
    modifiedBy: 'tester',
    entityTypes: [],
    relationshipTypes: [],
  };
  /** The server's refusal of a lock on a node another transaction deleted while the statement waited. */
  const DELETED_NODE = Object.assign(new Error('node deleted'), { code: 'Neo.ClientError.Statement.EntityNotFound' });

  /** A connection whose statements fail with `failure(cypher)`, or answer `written: 0` when it returns nothing. */
  function failingConnection(failure: (cypher: string) => unknown): Neo4jConnection {
    return {
      executeQuery: async (cypher: string) => {
        const error = failure(cypher);
        if (error !== undefined) throw error;
        const row: Record<string, unknown> = { written: 0n };
        return { records: [{ get: (key: string) => row[key] }] };
      },
    } as unknown as Neo4jConnection;
  }

  it('saveVocabulary reports a lock refused on a deleted marker as RepositoryNotFoundError', async () => {
    const conn = failingConnection((cypher) => (cypher === VOCABULARY_SAVE_QUERY ? DELETED_NODE : undefined));
    const thrown: unknown = await saveVocabulary(conn, RID, VOCABULARY, '1.0.0').catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(RepositoryNotFoundError);
  });

  it('saveVocabulary raises a failed write as a typed error naming the operation', async () => {
    const conn = failingConnection((cypher) => (cypher === VOCABULARY_SAVE_QUERY ? DRIVER_FAILURE : undefined));
    const thrown: unknown = await saveVocabulary(conn, RID, VOCABULARY, '1.0.0').catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect(thrown).not.toBeInstanceOf(RepositoryNotFoundError);
    expect((thrown as Error).cause).toBe(DRIVER_FAILURE);
    expect((thrown as Error).message).toContain('saveVocabulary');
  });

  it('saveVocabulary raises a failed outcome read as a typed error', async () => {
    const conn = failingConnection((cypher) => (cypher === VOCABULARY_SAVE_OUTCOME_QUERY ? DRIVER_FAILURE : undefined));
    const thrown: unknown = await saveVocabulary(conn, RID, VOCABULARY, '1.0.0').catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(DRIVER_FAILURE);
  });

  it('getVocabulary raises a failed read as a typed error naming the operation', async () => {
    const conn = failingConnection(() => DRIVER_FAILURE);
    const thrown: unknown = await getVocabulary(conn, RID).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(DRIVER_FAILURE);
    expect((thrown as Error).message).toContain('getVocabulary');
  });
});

describe('vocabulary change-log page', () => {
  it('orders newest first, breaking ties on the change id', () => {
    expect(VOCABULARY_CHANGE_LOG_PAGE_QUERY).toContain('ORDER BY e.proposedAt DESC, e.changeId DESC');
  });
});
