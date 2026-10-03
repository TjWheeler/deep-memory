// Repository-marker write lock shared by every statement that creates data in
// a repository.
//
// `deleteRepository` deletes the `_Repository` marker first, in its own
// statement, and then drains the repository's data across many
// transactions. A create statement that only reads the marker takes no lock
// on it, so it can match the marker, lose it to the delete, and commit after
// the drain has passed — leaving data behind in a repository that no longer
// exists. Each create statement therefore opens with one of the fragments
// below:
//
//   1. Write-lock the marker (`SET repo._lock = true REMOVE repo._lock` nets
//      out to no change but takes the node's exclusive lock, held to commit).
//      Deleting the marker needs the same lock, so a create and a delete of
//      the repository serialise: the delete waits for an in-flight create to
//      commit and then drains what it wrote, or the create waits for the
//      delete.
//   2. Re-match the marker after the lock is granted. When the create waited
//      on a delete, the lock is granted on a node that is already gone, and
//      Neo4j raises no error for that: a later clause has to look again. The
//      updating clause ends a query part, so the planner plans the re-match
//      (and every read that follows the fragment) after the lock step, and it
//      reads the latest committed state. `live` is bound only when the marker
//      the statement locked still exists.
//
// The lock also serialises concurrent creates in one repository for the
// length of each statement, which is what makes a check-then-create in the
// rest of the statement (the relationship id check) race-free.
//
// Every fragment binds `live` to the locked, still-present marker and leaves
// it in scope for the statement that follows.

/**
 * Lock the marker and continue only while it exists: a missing or deleted
 * marker yields no row, so nothing after the fragment runs.
 */
export const LOCK_REPOSITORY_MARKER = `
MATCH (repo:_Repository {repositoryId: $rid})
SET repo._lock = true
REMOVE repo._lock
WITH repo
MATCH (live:_Repository {repositoryId: $rid}) WHERE live = repo
`;

/**
 * Lock the marker when it exists and always continue with one row, `live`
 * being null when the marker is missing or was deleted while the statement
 * waited for the lock. For statements that report the missing repository as
 * one of several outcomes. (`SET` and `REMOVE` on a null node are no-ops.)
 */
export const LOCK_REPOSITORY_MARKER_OPTIONAL = `
OPTIONAL MATCH (repo:_Repository {repositoryId: $rid})
SET repo._lock = true
REMOVE repo._lock
WITH repo
OPTIONAL MATCH (live:_Repository {repositoryId: $rid}) WHERE live = repo
`;
