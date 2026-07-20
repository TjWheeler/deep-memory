/**
 * The single definition of how a source-filter entry matches a source path.
 *
 * Both the convert and extract runs, and the MCP tools that report which
 * sources they will touch, must agree on this predicate — a mismatch reports a
 * count that differs from what actually runs. A filter entry matches when it
 * equals the full path or is a substring of it (so a bare filename matches its
 * absolute path).
 */
export function matchesSourceFilter(path: string, filter: string[]): boolean {
  return filter.some((f) => path === f || path.includes(f));
}
