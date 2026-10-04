// Fixed vertex ids for the per-repository system vertices.
//
// Each repository's `_repository` marker and `_vocabulary` vertex live in the
// repository's own partition (`repositoryId` is the partition key) under a
// deterministic id, so every module that reads, guards on, or writes them can
// address them with a partition-scoped `has('repositoryId', rid).hasId(...)`
// lookup instead of a label scan.

/** Id of the `_repository` marker vertex for a repository. */
export function repoVertexId(repositoryId: string): string {
  return `repo:${repositoryId}`;
}

/** Id of the `_vocabulary` vertex for a repository. */
export function vocabVertexId(repositoryId: string): string {
  return `vocab:${repositoryId}`;
}

/**
 * Id of a `_vocabularyChangeLog` vertex, derived from its record's
 * `changeId`. A deterministic id makes the record's write idempotent: a
 * retried save finds the record it already wrote instead of adding a second
 * one. A change id is `change_<ms>_<random>`, so two changes sharing one is
 * improbable rather than impossible; each repository is its own partition,
 * so the id needs no repository component.
 */
export function changeLogVertexId(changeId: string): string {
  return `vocablog:${changeId}`;
}
