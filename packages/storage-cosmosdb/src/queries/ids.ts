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
