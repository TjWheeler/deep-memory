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
//
// The statement also reports whether the repository marker exists, and
// deletes nothing when it does not. A repository that is gone, or whose
// delete is under way (marker removed, data still draining), answers
// `RepositoryNotFoundError` rather than reporting its ids as not found. The
// repository outcome takes precedence over the per-id outcome, as it does on
// the create paths. When the marker disappears between a committed attempt
// and its re-run, the call answers `RepositoryNotFoundError`: the repository
// is being deleted, which removes what the first attempt did not.

import { ProviderError, RepositoryNotFoundError } from '@utaba/deep-memory';
import type { Neo4jConnection } from '../Neo4jConnection.js';
import { REPOSITORY_MARKER_EXISTS_QUERY } from './repositoryDrain.js';

/**
 * Run a repository-scoped delete statement and split `ids` into the ids this
 * call deleted and the ids it did not find. `cypher` must bind the ids as
 * `$ids` and return exactly one row: `repositoryExists` (whether the
 * `_Repository` marker exists; nothing is deleted when it does not) and
 * `deleted` (the list of ids it removed).
 *
 * Empty input deletes nothing but still checks the repository, with one
 * read of the marker (a seek of its unique constraint index), so an empty
 * list answers a deleted repository the same way a non-empty one does.
 *
 * @throws RepositoryNotFoundError when the repository marker is absent.
 * @throws ProviderError when the statement returns no row.
 */
export async function deleteByIds(
  conn: Neo4jConnection,
  repositoryId: string,
  cypher: string,
  ids: string[],
): Promise<{ deleted: string[]; notFound: string[] }> {
  if (ids.length === 0) {
    const marker = await conn.executeQuery(REPOSITORY_MARKER_EXISTS_QUERY, {}, { repositoryId, routing: 'READ' });
    const markerRecord = marker.records[0];
    if (markerRecord === undefined) throw new ProviderError('Neo4j repository marker read returned no row.');
    if (markerRecord.get('repositoryExists') !== true) throw new RepositoryNotFoundError(repositoryId);
    return { deleted: [], notFound: [] };
  }
  const deletedByEarlierAttempts = new Set<string>();
  const outcome = await conn.executeWrite(repositoryId, async (tx, attempt) => {
    const result = await tx.run(cypher, { ids });
    const record = result.records[0];
    if (record === undefined) throw new ProviderError('Neo4j delete by ids returned no row.');
    if (record.get('repositoryExists') !== true) return { repositoryExists: false, deleted: [] };
    const reported: unknown = record.get('deleted');
    const thisAttempt = Array.isArray(reported)
      ? reported.filter((id): id is string => typeof id === 'string')
      : [];
    const answer = new Set(thisAttempt);
    if (attempt > 1) {
      for (const id of deletedByEarlierAttempts) answer.add(id);
    }
    for (const id of thisAttempt) deletedByEarlierAttempts.add(id);
    return { repositoryExists: true, deleted: Array.from(answer) };
  });
  if (!outcome.repositoryExists) throw new RepositoryNotFoundError(repositoryId);
  const deletedSet = new Set(outcome.deleted);
  const notFound = ids.filter((id) => !deletedSet.has(id));
  return { deleted: outcome.deleted, notFound };
}
