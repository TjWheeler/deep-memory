// A fake connection for unit tests of the batched delete statements, which
// run one auto-commit statement per batch through
// `Neo4jConnection.executeImplicitInTransactions`. Test support only: the
// package build excludes `*.test-support.ts`.

import type { Neo4jConnection } from '../Neo4jConnection.js';

/** One statement's answer in a batched delete: its row (or none), its update counters, or a failure. */
export interface BatchAnswer {
  row?: Record<string, unknown>;
  counters?: Record<string, number>;
  error?: unknown;
}

/** A statement the fake connection received. */
export interface BatchCall {
  cypher: string;
  params: Record<string, unknown>;
}

/**
 * A connection answering each auto-commit statement with the next of
 * `answers`, and recording the statements. A statement for any repository
 * other than `repositoryId`, or one more than `answers` holds, fails.
 */
export function batchConnection(
  repositoryId: string,
  answers: BatchAnswer[],
): { conn: Neo4jConnection; calls: BatchCall[] } {
  const calls: BatchCall[] = [];
  const fake = {
    async executeImplicitInTransactions(cypher: string, params: Record<string, unknown>, options: { repositoryId: string }) {
      if (options.repositoryId !== repositoryId) {
        throw new Error(`statement for repository ${options.repositoryId}, expected ${repositoryId}`);
      }
      const answer = answers[calls.length];
      calls.push({ cypher, params });
      if (answer === undefined) throw new Error('more statements than the test expected');
      if (answer.error !== undefined) throw answer.error;
      const row = answer.row;
      return {
        records: row === undefined ? [] : [{ get: (key: string) => row[key] }],
        summary: { counters: { updates: () => answer.counters ?? {} } },
      };
    },
  };
  return { conn: fake as unknown as Neo4jConnection, calls };
}
