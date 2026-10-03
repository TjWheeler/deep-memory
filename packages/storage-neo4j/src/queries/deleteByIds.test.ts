import { describe, expect, it } from 'vitest';
import { EntityNotFoundError } from '@utaba/deep-memory';
import type { Neo4jConnection, ScopedTransaction } from '../Neo4jConnection.js';
import { deleteByIds } from './deleteByIds.js';
import { deleteEntities, deleteEntity } from './entity.js';
import { deleteRelationships } from './relationship.js';

const RID = 'repo-delete-retry';
const DELETE_QUERY = 'MATCH (n:_Entity {repositoryId: $rid}) WHERE n.id IN $ids DETACH DELETE n RETURN n.id AS deleted';

/** How the fake driver treats the first attempt of the transaction. */
type FirstAttempt =
  /** The only attempt; it commits and the client hears back. */
  | 'acknowledged'
  /** It commits, the acknowledgement is lost, and the driver runs it again. */
  | 'committed-ack-lost'
  /** It fails before commit, rolls back, and the driver runs it again. */
  | 'rolled-back';

/**
 * A connection fake holding a set of stored ids. Each attempt of the
 * transaction function deletes from a working copy of the store; a commit
 * makes the copy the store.
 */
function storeConnection(storedIds: string[], firstAttempt: FirstAttempt) {
  let store = new Set(storedIds);
  const statements: string[] = [];
  let transactions = 0;

  const runAttempt = async <T>(
    txFn: (tx: ScopedTransaction, attempt: number) => Promise<T>,
    attempt: number,
  ): Promise<{ answer: T; working: Set<string> }> => {
    const working = new Set(store);
    const tx = {
      run: async (cypher: string, params: Record<string, unknown>) => {
        statements.push(cypher);
        const ids = params['ids'] as string[];
        const removed = ids.filter((id) => working.delete(id));
        return { records: removed.map((id) => ({ get: (key: string) => (key === 'deleted' ? id : undefined) })) };
      },
    } as unknown as ScopedTransaction;
    return { answer: await txFn(tx, attempt), working };
  };

  const fake = {
    async executeWrite<T>(
      repositoryId: string,
      txFn: (tx: ScopedTransaction, attempt: number) => Promise<T>,
    ): Promise<T> {
      expect(repositoryId).toBe(RID);
      transactions += 1;
      const first = await runAttempt(txFn, 1);
      if (firstAttempt === 'acknowledged') {
        store = first.working;
        return first.answer;
      }
      if (firstAttempt === 'committed-ack-lost') store = first.working;
      const second = await runAttempt(txFn, 2);
      store = second.working;
      return second.answer;
    },
  };
  return {
    conn: fake as unknown as Neo4jConnection,
    stored: () => Array.from(store).sort(),
    statements,
    transactions: () => transactions,
  };
}

describe('deleteByIds under a driver re-run', () => {
  it('reports the ids a committed first attempt deleted as deleted, not notFound', async () => {
    const { conn, stored } = storeConnection(['a', 'b', 'keep'], 'committed-ack-lost');

    const result = await deleteByIds(conn, RID, DELETE_QUERY, ['a', 'b', 'missing']);

    expect(result.deleted.sort()).toEqual(['a', 'b']);
    expect(result.notFound).toEqual(['missing']);
    expect(stored()).toEqual(['keep']);
  });

  it('answers the same when the first attempt rolled back', async () => {
    const { conn, stored } = storeConnection(['a', 'b', 'keep'], 'rolled-back');

    const result = await deleteByIds(conn, RID, DELETE_QUERY, ['a', 'b', 'missing']);

    expect(result.deleted.sort()).toEqual(['a', 'b']);
    expect(result.notFound).toEqual(['missing']);
    expect(stored()).toEqual(['keep']);
  });

  it('reports an id no attempt found as notFound even after a re-run', async () => {
    const { conn } = storeConnection(['keep'], 'committed-ack-lost');

    const result = await deleteByIds(conn, RID, DELETE_QUERY, ['missing-1', 'missing-2']);

    expect(result).toEqual({ deleted: [], notFound: ['missing-1', 'missing-2'] });
  });

  it('answers a single acknowledged attempt from its own result', async () => {
    const { conn, stored } = storeConnection(['a', 'keep'], 'acknowledged');

    const result = await deleteByIds(conn, RID, DELETE_QUERY, ['a', 'missing']);

    expect(result).toEqual({ deleted: ['a'], notFound: ['missing'] });
    expect(stored()).toEqual(['keep']);
  });

  it('makes no round-trip for empty input', async () => {
    const { conn, transactions } = storeConnection(['a'], 'acknowledged');

    await expect(deleteByIds(conn, RID, DELETE_QUERY, [])).resolves.toEqual({ deleted: [], notFound: [] });
    expect(transactions()).toBe(0);
  });
});

describe('deletes run through the attempt-aware path', () => {
  it('deleteEntity answers success when the re-run finds its own committed delete', async () => {
    const { conn, stored, statements } = storeConnection(['e1', 'keep'], 'committed-ack-lost');

    await expect(deleteEntity(conn, RID, 'e1')).resolves.toBeUndefined();

    expect(stored()).toEqual(['keep']);
    expect(statements).toHaveLength(2);
    expect(statements.every((cypher) => cypher.includes('DETACH DELETE n') && cypher.includes('$rid'))).toBe(true);
  });

  it('deleteEntity still throws EntityNotFoundError for an id no attempt found', async () => {
    const { conn } = storeConnection(['keep'], 'committed-ack-lost');

    await expect(deleteEntity(conn, RID, 'missing')).rejects.toBeInstanceOf(EntityNotFoundError);
  });


  it('deleteEntities reports a committed first attempt as deleted', async () => {
    const { conn, stored, statements } = storeConnection(['e1', 'e2'], 'committed-ack-lost');

    const result = await deleteEntities(conn, RID, ['e1', 'e2', 'e3']);

    expect(result.deleted.sort()).toEqual(['e1', 'e2']);
    expect(result.notFound).toEqual(['e3']);
    expect(stored()).toEqual([]);
    expect(statements.every((cypher) => cypher.includes('DETACH DELETE n') && cypher.includes('$rid'))).toBe(true);
  });

  it('deleteRelationships reports a committed first attempt as deleted', async () => {
    const { conn, stored, statements } = storeConnection(['r1', 'r2'], 'committed-ack-lost');

    const result = await deleteRelationships(conn, RID, ['r1', 'r2', 'r3']);

    expect(result.deleted.sort()).toEqual(['r1', 'r2']);
    expect(result.notFound).toEqual(['r3']);
    expect(stored()).toEqual([]);
    expect(statements.every((cypher) => cypher.includes('DELETE r') && cypher.includes('$rid'))).toBe(true);
  });
});
