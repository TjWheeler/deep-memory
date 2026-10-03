import { describe, expect, it } from 'vitest';
import { DeepMemoryError, RepositoryNotFoundError, createEmptyVocabulary } from '@utaba/deep-memory';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { getRepositoryStats } from './repository.js';
import { REPOSITORY_MARKER_EXISTS_QUERY } from './repositoryDrain.js';

const RID = 'repo-stats';

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

describe('getRepositoryStats', () => {
  it('reports a missing repository ahead of a failed count', async () => {
    const conn = answeringConnection((cypher) => {
      if (cypher === REPOSITORY_MARKER_EXISTS_QUERY) return { repositoryExists: false };
      throw DRIVER_FAILURE;
    });

    await expect(getRepositoryStats(conn, RID, createEmptyVocabulary('test'))).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('raises a failed count as a typed error once the marker is found', async () => {
    const conn = answeringConnection((cypher) => {
      if (cypher === REPOSITORY_MARKER_EXISTS_QUERY) return { repositoryExists: true };
      throw DRIVER_FAILURE;
    });

    const thrown: unknown = await getRepositoryStats(conn, RID, createEmptyVocabulary('test')).catch((err: unknown) => err);
    expect(thrown).toBeInstanceOf(DeepMemoryError);
    expect((thrown as Error).cause).toBe(DRIVER_FAILURE);
  });
});
