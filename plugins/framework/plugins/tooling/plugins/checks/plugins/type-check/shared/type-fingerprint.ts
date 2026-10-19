// The TYPE fingerprint of each file: a hash of everything the type checker can
// tell about it — what decides its tsc diagnostics, its emitted `.d.ts`, and
// what a type-aware lint rule reads.
//
// The checker's view of a file is a function of the file plus the
// DECLARATIONS it can name: the contract (emitted `.d.ts`) of each file it
// imports directly, every file those contracts name in turn (a re-export, a
// type-only import, the `import("./e").T` tsc writes for an inferred type —
// `./contract-refs.ts`), and so on, plus the global scope and the engine (the
// compiler, its options, the dependencies). It never reads another file's
// source, and never a file only a BODY imports. So the key follows two graphs:
//
//   - the SOURCE graph for the first hop — what the file itself references
//     (`./program-graph.ts`: imports, module augmentations, ambient modules);
//   - the CONTRACT graph from there on — for a repo source file, the files
//     declaring what its `.d.ts` names; for a declaration input
//     (`node_modules`, an ambient `.d.ts`), what it references, which is
//     exactly what it imports.
//
// Each file's SHAPE is its signature (the hash of its `.d.ts`) for a repo
// source file, its version (the hash of its text) for a declaration input.
// Then, over the strongly-connected-component condensation of the CONTRACT
// graph (import cycles are common, and a cycle's members see each other):
//
//   cHash(C)  = H( sorted (path, shape) of C's members, sorted cHash(D) for
//                  each component D ≠ C a member of C names )
//   global    = H( engine, sorted (path, VERSION) of every global file )
//   typeFp(f) = H( global, sorted cHash of each file f references )
//
// A global file is one that affects the global scope (a script, a `declare
// global`) or augments a module (`declare module "x"` — every importer of `x`
// sees it without naming the augmenting file). Its VERSION goes into the global
// hash, not its signature: the global hash is needed before any file is
// checked (`./keyed-check.ts`), and a repo source file's signature is known
// only after it is. A body edit to one of the ~13 global source files therefore
// re-checks everything — measured, 13 of 781 main commits in 30 days.
//
// So a body-only edit moves nothing; an exported-type change moves the files
// that import the changed file directly, and the files that import a file whose
// contract NAMES it (transitively) — the chain stops at an importer whose
// contract does not mention it, where the source graph would keep going through
// every body. Never wider than a closure over the source graph (a contract only
// names files its source can reach). O(V + E).
//
// PURE — graph and contract edges in, hashes out. `./keyed-check.ts` computes
// the same hashes one source component at a time, as each file's shape becomes
// known; `computeTypeFingerprints` is the whole-graph form its tests check it
// against. See research/2026-10-17-global-lint-keyed-on-what-it-reads.md,
// research/2026-10-18-global-typed-lint-key-stops-at-contracts.md and
// research/2026-10-18-global-tsc-recheck-follows-contracts.md.

import { createHash } from "crypto";

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * The result key of a part of a file's lint result that reads types: a typed
 * rule group's part, or a directive file's whole result (`LINT_GROUP_ALL`).
 * `partFp` is the rules' fingerprint, `typeFp` the file's type fingerprint.
 * Shortened like a group fingerprint: a store entry holds a handful of these,
 * and 64 bits keeps a collision among them out of reach.
 *
 * Here rather than beside the group fingerprints because the worker computes
 * it too, for a part prepare could not decide (no signature table yet).
 */
export function typedResultKey(partFp: string, typeFp: string): string {
  return sha256(`${partFp}\n${typeFp}`).slice(0, 16);
}

/** One program's file graph, 0-based, paths relative to the repo root. */
export interface ProgramGraph {
  /** Each file's repo-relative path (`../…` outside the root). */
  paths: string[];
  /** The hash of each file's text. */
  versions: string[];
  /** Whether the file is global (`isGlobalFile` in `./program-graph.ts`). */
  global: boolean[];
  /** What each file references. */
  succ: number[][];
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

/** A repo source file's contract, as graph edges. */
export interface Contract {
  /** The nodes its `.d.ts` names (resolved; dependencies left out). */
  refs: readonly number[];
}

/** The global hash: the engine, and every global file's version. */
export function globalHash(graph: ProgramGraph, engineFp: string): string {
  const lines: string[] = [];
  graph.paths.forEach((p, i) => {
    if (graph.global[i]) lines.push(`${p}\0${graph.versions[i]}`);
  });
  return sha256(`engine\n${engineFp}\nglobal\n${lines.sort().join("\n")}`);
}

/**
 * The type fingerprint of a file whose references `refs` all have a component
 * hash. 16 hex digits: a key part, never compared beyond one file's versions.
 */
export function typeFpOf(
  globalFp: string,
  refs: readonly number[],
  compHash: readonly (string | undefined)[],
): string {
  const seen = new Set<string>();
  for (const d of refs) {
    const h = compHash[d];
    if (h === undefined) {
      throw new Error(
        `type fingerprint: node ${d} is referenced before its component is hashed`,
      );
    }
    seen.add(h);
  }
  return sha256(`${globalFp}\n${[...seen].sort().join("\n")}`).slice(0, 16);
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

/**
 * Hash the contract components of `nodes` into `compHash`, each from its
 * members' `(path, shape)` lines (`line(i)`) and the (already final) hashes of
 * the components it names. An edge leaving `nodes` must point at a node
 * already hashed: anything else means the caller's order is wrong, and throws.
 */
export function hashComponents(
  nodes: readonly number[],
  contractSucc: readonly (readonly number[] | undefined)[],
  line: (i: number) => string,
  compHash: (string | undefined)[],
): void {
  const edgesOf = (v: number): readonly number[] => {
    const e = contractSucc[v];
    if (e === undefined) {
      throw new Error(`type fingerprint: node ${v} has no contract edges`);
    }
    return e;
  };
  forEachComponent(
    nodes,
    edgesOf,
    (members) => {
      const own = new Set(members);
      const successors = new Set<string>();
      for (const m of members) {
        for (const t of edgesOf(m)) {
          if (!own.has(t)) successors.add(compHash[t]!);
        }
      }
      const h = sha256(
        `m\n${members.map(line).sort().join("\n")}\ns\n${[...successors].sort().join("\n")}`,
      );
      for (const m of members) compHash[m] = h;
    },
    (v, w) => {
      if (compHash[w] === undefined) {
        throw new Error(
          `type fingerprint: the contract of ${line(v).split("\0")[0]} names ${line(w).split("\0")[0]}, which is neither in its component nor hashed before it`,
        );
      }
    },
  );
}

/**
 * Every repo file's type fingerprint, from the whole graph at once: each
 * file's shape (`shapes[i]`) and every repo source file's contract.
 *
 * `contracts` must hold an entry for every node `needsContract` names — a
 * missing one is a bug in the caller, not a file to guess about, and throws.
 */
export function computeTypeFingerprints(
  graph: ProgramGraph,
  shapes: readonly string[],
  contracts: ReadonlyMap<number, Contract>,
  engineFp: string,
): Map<string, string> {
  const { paths, succ } = graph;
  const n = paths.length;
  const contractSucc: (readonly number[])[] = new Array<number[]>(n);
  for (let i = 0; i < n; i++) {
    if (!needsContract(paths[i]!)) {
      contractSucc[i] = succ[i]!;
      continue;
    }
    const c = contracts.get(i);
    if (c === undefined) {
      throw new Error(
        `type fingerprint: ${paths[i]} is a source file with no contract edges`,
      );
    }
    contractSucc[i] = c.refs;
  }
  const compHash: (string | undefined)[] = new Array<string | undefined>(n);
  hashComponents(
    paths.map((_, i) => i),
    contractSucc,
    (i) => `${paths[i]}\0${shapes[i]}`,
    compHash,
  );
  const globalFp = globalHash(graph, engineFp);
  const fps = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const p = paths[i]!;
    if (isRepoPath(p)) fps.set(p, typeFpOf(globalFp, succ[i]!, compHash));
  }
  return fps;
}
