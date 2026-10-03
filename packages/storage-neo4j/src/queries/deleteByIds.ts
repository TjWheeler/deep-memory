// Bulk delete by ids, answered correctly when the driver re-runs it.
//
// The driver re-runs a managed write transaction after a retryable failure,
// including a commit whose acknowledgement was lost. A delete that reports
// the ids it removed would then find nothing on the re-run and report every
// id its own first run deleted as not found. The transaction function
// therefore remembers what each attempt's statement reported deleting: an id
// an earlier attempt deleted and the current attempt finds absent was deleted
// by this call (the earlier attempt committed). An id no attempt ever found
// is a genuine miss.
//
// When an earlier attempt did not commit, its deletes rolled back and the
// current attempt normally finds and deletes the same ids again. If a
// concurrent delete removed one of those ids between the rolled-back attempt
// and the retry, the id is still reported as deleted: the earlier attempt
// saw it, and it is gone either way, so the caller's view of the store is
// correct even though another call performed the removal.

import type { Neo4jConnection } from '../Neo4jConnection.js';

/**
 * Run a repository-scoped delete statement that returns one `deleted` id per
 * removed record, and split `ids` into the ids this call deleted and the ids
 * it did not find. `cypher` must bind the ids as `$ids`.
 *
 * Empty input → empty result, no round-trip.
 */
export async function deleteByIds(
  conn: Neo4jConnection,
  repositoryId: string,
  cypher: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  if (ids.length === 0) return { deleted: [], notFound: [] };
  const deletedByEarlierAttempts = new Set<string>();
  const deleted = await conn.executeWrite(repositoryId, async (tx, attempt) => {
    const result = await tx.run(cypher, { ids });
    const thisAttempt: string[] = [];
    for (const record of result.records) {
      const id: unknown = record.get('deleted');
      if (typeof id === 'string') thisAttempt.push(id);
    }
    const answer = new Set(thisAttempt);
    if (attempt > 1) {
      for (const id of deletedByEarlierAttempts) answer.add(id);
    }
    for (const id of thisAttempt) deletedByEarlierAttempts.add(id);
    return Array.from(answer);
  });
  const deletedSet = new Set(deleted);
  const notFound = ids.filter((id) => !deletedSet.has(id));
  return { deleted, notFound };
}
