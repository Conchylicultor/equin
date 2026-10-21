// Small keys and graph helpers shared by the type check's preparation thread
// and its worker: content hashes, the typed lint result key, what counts as a
// repo file and as a checked source, and an iterative Tarjan.

import { createHash } from "crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The result key of a part of a file's lint result that reads types: a typed
 * rule group's part, or a directive file's whole result (`LINT_GROUP_ALL`).
 * `partFp` is the rules' fingerprint, `typeKey` the file's result key
 * (`./name-walk.ts`) — what its check read.
 * Shortened like a group fingerprint: a store entry holds a handful of these,
 * and 64 bits keeps a collision among them out of reach.
 *
 * Here rather than beside the group fingerprints because the worker computes
 * it: only it knows a file's result key.
 */
export function typedResultKey(partFp: string, typeKey: string): string {
  return sha256(`${partFp}\n${typeKey}`).slice(0, 16);
}

/** A file the repo owns: not a dependency, not outside the root. */
export function isRepoPath(p: string): boolean {
  return (
    !p.startsWith("../") && p !== ".." && !p.split("/").includes("node_modules")
  );
}

/**
 * Whether a graph node is CHECKED and needs its CONTRACT's edges supplied: a
 * repo source file, whose emitted `.d.ts` decides what its importers see. A
 * declaration input (`.d.ts`, dependencies included) is its own contract, so
 * its references stand, and `skipLibCheck` leaves it unchecked; a JSON module
 * names nothing.
 */
export function needsContract(path: string): boolean {
  return (
    isRepoPath(path) && !/\.d\.[mc]?ts$/.test(path) && !path.endsWith(".json")
  );
}

/**
 * Visit the strongly-connected components of the graph `edgesOf` spans over
 * `nodes`, each after every component it reaches — Tarjan's algorithm,
 * ITERATIVE (an explicit call stack: the repo program has ~14.5k files, and a
 * recursive walk down a long import chain would overflow). An edge leaving
 * `nodes` is skipped; `leave(v, w)` is told about it.
 */
export function forEachComponent(
  nodes: readonly number[],
  edgesOf: (v: number) => readonly number[],
  visitComponent: (members: number[]) => void,
  leave: (v: number, w: number) => void = () => {},
): void {
  const inSet = new Set(nodes);
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const callNode: number[] = [];
  const callEdge: number[] = [];
  let next = 0;
  const visit = (v: number): void => {
    index.set(v, next);
    low.set(v, next++);
    stack.push(v);
    onStack.add(v);
    callNode.push(v);
    callEdge.push(0);
  };
  for (const s of nodes) {
    if (index.has(s)) continue;
    visit(s);
    while (callNode.length > 0) {
      const top = callNode.length - 1;
      const v = callNode[top]!;
      const edges = edgesOf(v);
      const e = callEdge[top]!;
      if (e < edges.length) {
        callEdge[top] = e + 1;
        const w = edges[e]!;
        if (!inSet.has(w)) leave(v, w);
        else if (!index.has(w)) visit(w);
        else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v)!, index.get(w)!));
        }
        continue;
      }
      callNode.pop();
      callEdge.pop();
      if (callNode.length > 0) {
        const u = callNode[callNode.length - 1]!;
        low.set(u, Math.min(low.get(u)!, low.get(v)!));
      }
      if (low.get(v) !== index.get(v)) continue;
      const members: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        members.push(w);
      } while (w !== v);
      visitComponent(members);
    }
  }
}
