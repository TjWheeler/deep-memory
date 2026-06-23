/**
 * Tarjan's strongly-connected-components algorithm — pure, deterministic, no dependencies.
 *
 * Used by rebuild.ts to find import cycles in the Module→Module IMPORTS graph. The project forbids
 * circular dependencies (CLAUDE.md: "If a dynamic import looks like it solves a circular dep, fix
 * the circularity instead"), so any SCC of size > 1 is a real defect, not a modelling artefact.
 *
 * Determinism (required by the delta-reconciliation contract — the same source must yield the same
 * graph) is guaranteed by visiting nodes in the caller-provided order and each node's out-neighbours
 * in sorted order, and by sorting every emitted component. The classic recursive formulation is used:
 * the module import graph is shallow (≈200 files, import chains a few dozen deep at most), well within
 * the call-stack budget.
 */

/**
 * Compute the strongly-connected components of a directed graph.
 *
 * @param nodes      every node id, in the (deterministic) order to start DFS from.
 * @param adjacency  node id → its out-neighbour node ids (missing entry = no out-edges).
 * @returns          one array of node ids per SCC; each component and the algorithm overall are
 *                   deterministic for a given input. A component of length 1 is a node not on any
 *                   cycle (self-loops are not produced by the module graph); length > 1 is a cycle.
 */
export function stronglyConnectedComponents(nodes: string[], adjacency: Map<string, string[]>): string[][] {
  let counter = 0;
  const index = new Map<string, number>(); // DFS discovery order
  const lowlink = new Map<string, number>(); // lowest index reachable
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];

  const connect = (v: string): void => {
    index.set(v, counter);
    lowlink.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of (adjacency.get(v) ?? []).slice().sort()) {
      if (!index.has(w)) {
        connect(w);
        lowlink.set(v, Math.min(lowlink.get(v)!, lowlink.get(w)!));
      } else if (onStack.has(w)) {
        lowlink.set(v, Math.min(lowlink.get(v)!, index.get(w)!));
      }
    }

    if (lowlink.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);
      components.push(component.sort());
    }
  };

  for (const v of nodes) {
    if (!index.has(v)) connect(v);
  }
  return components;
}
