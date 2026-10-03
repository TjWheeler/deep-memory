import { describe, expect, it } from 'vitest';
import { EntityNotFoundError, ProviderError, RelationshipNotFoundError, RepositoryNotFoundError } from '@utaba/deep-memory';
import type { Neo4jConnection, ScopedTransaction } from '../Neo4jConnection.js';
import { deleteByIds } from './deleteByIds.js';
import { deleteEntities, deleteEntity } from './entity.js';
import { deleteRelationship, deleteRelationships } from './relationship.js';
import { REPOSITORY_MARKER_EXISTS_QUERY } from './repositoryDrain.js';

const RID = 'repo-delete-retry';
const DELETE_QUERY = 'OPTIONAL MATCH (repo:_Repository {repositoryId: $rid}) RETURN repo IS NOT NULL AS repositoryExists, [] AS deleted';

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
 * makes the copy the store. Each statement answers the one row the delete
 * statements return: whether the repository marker exists (nothing is
 * deleted when it does not) and the ids it deleted. A marker read outside a
 * transaction answers whether the marker exists.
 */
function storeConnection(storedIds: string[], firstAttempt: FirstAttempt, markerExists: () => boolean = () => true) {
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
        const repositoryExists = markerExists();
        const removed = repositoryExists ? ids.filter((id) => working.delete(id)) : [];
        const row: Record<string, unknown> = { repositoryExists, deleted: removed };
        return { records: [{ get: (key: string) => row[key] }] };
      },
    } as unknown as ScopedTransaction;
    return { answer: await txFn(tx, attempt), working };
  };

  const markerReads: string[] = [];
  const fake = {
    async executeQuery(cypher: string, _params: Record<string, unknown>, options: { repositoryId: string }) {
      expect(options.repositoryId).toBe(RID);
      markerReads.push(cypher);
      const row: Record<string, unknown> = { repositoryExists: markerExists() };
      return { records: [{ get: (key: string) => row[key] }] };
    },
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
    markerReads,
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

  it('reads only the repository marker for empty input', async () => {
    const { conn, transactions, markerReads } = storeConnection(['a'], 'acknowledged');

    await expect(deleteByIds(conn, RID, DELETE_QUERY, [])).resolves.toEqual({ deleted: [], notFound: [] });
    expect(transactions()).toBe(0);
    expect(markerReads).toEqual([REPOSITORY_MARKER_EXISTS_QUERY]);
  });

  it('throws RepositoryNotFoundError for empty input when the repository marker is absent', async () => {
    const { conn, transactions } = storeConnection(['a'], 'acknowledged', () => false);

    await expect(deleteByIds(conn, RID, DELETE_QUERY, [])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(transactions()).toBe(0);
  });

  it('throws ProviderError, not RepositoryNotFoundError, when the statement returns no row', async () => {
    const conn = {
      executeWrite: async <T>(_rid: string, txFn: (tx: ScopedTransaction, attempt: number) => Promise<T>) =>
        txFn({ run: async () => ({ records: [] }) } as unknown as ScopedTransaction, 1),
    } as unknown as Neo4jConnection;

    await expect(deleteByIds(conn, RID, DELETE_QUERY, ['a'])).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws RepositoryNotFoundError and deletes nothing when the repository marker is absent', async () => {
    const { conn, stored } = storeConnection(['a', 'b'], 'acknowledged', () => false);

    await expect(deleteByIds(conn, RID, DELETE_QUERY, ['a', 'missing'])).rejects.toBeInstanceOf(
      RepositoryNotFoundError,
    );
    expect(stored()).toEqual(['a', 'b']);
  });

  it('throws RepositoryNotFoundError when the marker is gone by the re-run of a committed attempt', async () => {
    let statements = 0;
    const { conn, stored } = storeConnection(['a', 'keep'], 'committed-ack-lost', () => {
      statements += 1;
      return statements === 1;
    });

    await expect(deleteByIds(conn, RID, DELETE_QUERY, ['a'])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stored()).toEqual(['keep']);
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

  it('deleteEntity reports a missing repository ahead of a missing entity', async () => {
    const { conn } = storeConnection(['keep'], 'acknowledged', () => false);

    await expect(deleteEntity(conn, RID, 'missing')).rejects.toBeInstanceOf(RepositoryNotFoundError);
  });

  it('deleteRelationship throws RepositoryNotFoundError without a marker, and deletes nothing', async () => {
    const { conn, stored } = storeConnection(['r1'], 'acknowledged', () => false);

    await expect(deleteRelationship(conn, RID, 'r1')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(deleteRelationship(conn, RID, 'missing')).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stored()).toEqual(['r1']);
  });

  it('deleteRelationship answers success when the re-run finds its own committed delete', async () => {
    const { conn, stored } = storeConnection(['r1', 'keep'], 'committed-ack-lost');

    await expect(deleteRelationship(conn, RID, 'r1')).resolves.toBeUndefined();
    expect(stored()).toEqual(['keep']);
  });

  it('deleteRelationship throws RelationshipNotFoundError for an id no attempt found', async () => {
    const { conn, stored } = storeConnection(['keep'], 'committed-ack-lost');

    await expect(deleteRelationship(conn, RID, 'missing')).rejects.toBeInstanceOf(RelationshipNotFoundError);
    expect(stored()).toEqual(['keep']);
  });

  it('deleteRelationship throws RelationshipNotFoundError when the same id is deleted twice', async () => {
    const { conn, stored } = storeConnection(['r1', 'keep'], 'acknowledged');

    await expect(deleteRelationship(conn, RID, 'r1')).resolves.toBeUndefined();
    await expect(deleteRelationship(conn, RID, 'r1')).rejects.toBeInstanceOf(RelationshipNotFoundError);
    expect(stored()).toEqual(['keep']);
  });

  it('deleteEntities and deleteRelationships throw RepositoryNotFoundError without a marker', async () => {
    const { conn, stored } = storeConnection(['e1', 'r1'], 'acknowledged', () => false);

    await expect(deleteEntities(conn, RID, ['e1'])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    await expect(deleteRelationships(conn, RID, ['r1'])).rejects.toBeInstanceOf(RepositoryNotFoundError);
    expect(stored()).toEqual(['e1', 'r1']);
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
