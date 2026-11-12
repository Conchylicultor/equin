// ============================================================================
// R6: cycle detection over the cross-plugin import graph
// ============================================================================

/** A cycle in the directed graph `edges`, as its node path, or null. */
export function detectCycle(
  edges: { from: string; to: string }[],
): string[] | null {
  const adj = new Map<string, Set<string>>();
  for (const { from, to } of edges) {
    if (!adj.has(from)) adj.set(from, new Set());
    adj.get(from)!.add(to);
  }
  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string>();
  const nodes = new Set<string>();
  for (const { from, to } of edges) {
    nodes.add(from);
    nodes.add(to);
  }

  for (const node of nodes) {
    if (color.get(node) !== undefined) continue;
    const stack: Array<{ node: string; iter: Iterator<string> }> = [
      { node, iter: (adj.get(node) ?? new Set<string>()).values() },
    ];
    color.set(node, GRAY);
    while (stack.length) {
      const top = stack[stack.length - 1]!;
      const step = top.iter.next();
      if (step.done) {
        color.set(top.node, BLACK);
        stack.pop();
        continue;
      }
      const nxt = step.value;
      const col = color.get(nxt) ?? WHITE;
      if (col === GRAY) {
        const path: string[] = [top.node];
        let cur = top.node;
        while (cur !== nxt) {
          const par = parent.get(cur);
          if (par === undefined) break;
          path.push(par);
          cur = par;
        }
        path.push(nxt);
        path.reverse();
        return path;
      }
      if (col === WHITE) {
        color.set(nxt, GRAY);
        parent.set(nxt, top.node);
        stack.push({
          node: nxt,
          iter: (adj.get(nxt) ?? new Set<string>()).values(),
        });
      }
    }
  }
  return null;
}
