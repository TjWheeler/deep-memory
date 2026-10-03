import { describe, expect, it } from 'vitest';
import { DeepMemoryError, RepositoryNotFoundError } from '@utaba/deep-memory';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { getVocabularyChangeLog } from './vocabulary.js';

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
