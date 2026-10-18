// The TYPE fingerprint of each file: a hash of everything the type checker can
// tell a type-aware lint rule about it.
//
// A type-aware rule reads the file's own text plus the checker's types for it.
// Those types are a function of the file plus the DECLARATIONS it can name: the
// contract (emitted `.d.ts`) of each file it imports directly, every file those
// contracts name in turn (a re-export, a type-only import, the `import("./e").T`
// tsc writes for an inferred type — `./contract-refs.ts`), and so on, plus the
// global scope. It never reads another file's source, and never a file only a
// BODY imports. So the key follows two graphs:
//
//   - the SOURCE graph for the first hop — tsc's `referencedMap`, what the file
//     itself imports (module augmentations and ambient modules included);
//   - the CONTRACT graph from there on — for a repo source file, the files its
//     `.d.ts` names; for a declaration input (`node_modules`, an ambient
//     `.d.ts`), its `referencedMap`, which is exactly what it imports.
//
// Each file's shape is its `fileInfos[].signature` (the hash of its `.d.ts`), or
// the version where tsc wrote a placeholder — a bare string entry, an object
// with no `signature`, or `signature: false` — the conservative side, since it
// moves on every edit. Then, over the strongly-connected-component condensation
// of the CONTRACT graph (import cycles are common, and a cycle's members see
// each other):
//
//   cHash(C)  = H( sorted (path, shape) of C's members, sorted cHash(D) for
//                  each component D ≠ C a member of C names )
//   global    = H( sorted (path, shape) of every `affectsGlobalScope` file and
//                  every file whose contract augments a module )
//   typeFp(f) = H( global, sorted cHash of each file f references )
//
// So a body-only edit moves nothing; an exported-type change moves the files
// that import the changed file directly, and the files that import a file whose
// contract NAMES it (transitively) — the chain stops at an importer whose
// contract does not mention it, where the source graph would keep going through
// every body. Never wider than a closure over `referencedMap` (a contract only
// names files its source can reach), never narrower than tsc's own
// re-check (direct referencers plus the re-export chain). An augmentation is
// global because every importer of the augmented module sees it without naming
// the augmenting file. O(V + E).
//
// PURE — buildinfo graph and contract edges in, `rel → typeFp` out — because
// two processes need the same answer: the worker computes it from the buildinfo
// it just wrote, and the check stores it as the signature table a later run's
// prepare decides from. It keys only the typed parts (`../check/lint-groups.ts`,
// the typed engine). See research/2026-10-17-global-lint-keyed-on-what-it-reads.md
// and research/2026-10-18-global-typed-lint-key-stops-at-contracts.md.

import { createHash } from "crypto";
import { relative, resolve } from "path";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Each repo file's type fingerprint (16 hex digits), by repo-relative path —
 * or why the buildinfo could not be read as a program graph.
 *
 * A discriminated result, never an empty map: an empty table would read as
 * "this program has no files", and every lookup into it as a file with no type
 * fingerprint — the absorbed failure that hides a TypeScript upgrade changing
 * the buildinfo layout.
 */
export type TypeFingerprints =
  | { kind: "fps"; fps: Map<string, string> }
  | { kind: "unreadable"; why: string };

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

/** One `.tsbuildinfo`'s program graph, 0-based, paths relative to the repo root. */
export interface BuildInfoGraph {
  /** Each file's repo-relative path (`../…` outside the root). */
  paths: string[];
  /** Each file's signature, or its version where tsc stored a placeholder. */
  shapes: string[];
  /** Whether tsc marked the file `affectsGlobalScope`. */
  global: boolean[];
  /** What each file references (`referencedMap`). */
  succ: number[][];
}

export type BuildInfoGraphResult =
  | { kind: "graph"; graph: BuildInfoGraph }
  | { kind: "unreadable"; why: string };

/** A file the repo owns: not a dependency, not outside the root. */
export function isRepoPath(p: string): boolean {
  return (
    !p.startsWith("../") && p !== ".." && !p.split("/").includes("node_modules")
  );
}

/**
 * Whether a graph node needs its CONTRACT's edges supplied: a repo source file
 * whose emitted `.d.ts` decides what its importers see. A declaration input
 * (`.d.ts`, dependencies included) is its own contract, so its `referencedMap`
 * edges stand; a JSON module names nothing.
 */
export function needsContract(path: string): boolean {
  return (
    isRepoPath(path) && !/\.d\.[mc]?ts$/.test(path) && !path.endsWith(".json")
  );
}

const isFileId = (n: unknown, count: number): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= count;

/**
 * Read one `.tsbuildinfo`'s program graph.
 *
 * `buildInfoDir` is the directory the buildinfo was WRITTEN for (its paths are
 * relative to it), `root` the repo root the returned paths are relative to.
 *
 * The layout is TypeScript's incremental `getBuildInfo` (TS 6): `fileNames[]`;
 * `fileInfos[]` parallel to it; `fileIdsList[][]` of file ids; `referencedMap`
 * as `[fileId, fileIdsListId]` pairs. Both ids are ONE-based (`toFileId`
 * returns `fileNames.length` after the push, `toFilePath(id)` reads
 * `filePaths[id - 1]`). Anything else is `unreadable`, never a guess.
 */
export function readBuildInfoGraph(
  buildInfoText: string,
  buildInfoDir: string,
  root: string,
): BuildInfoGraphResult {
  let doc: unknown;
  try {
    doc = JSON.parse(buildInfoText);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { kind: "unreadable", why: "buildinfo is not valid JSON" };
  }
  if (typeof doc !== "object" || doc === null) {
    return { kind: "unreadable", why: "buildinfo is not an object" };
  }
  const { fileNames, fileInfos, fileIdsList, referencedMap } = doc as Record<
    string,
    unknown
  >;
  if (
    !Array.isArray(fileNames) ||
    !fileNames.every((n) => typeof n === "string")
  ) {
    return {
      kind: "unreadable",
      why: "buildinfo has no fileNames string array",
    };
  }
  const n = fileNames.length;
  if (!Array.isArray(fileInfos) || fileInfos.length !== n) {
    return {
      kind: "unreadable",
      why: "buildinfo fileInfos is not an array parallel to fileNames",
    };
  }

  // Each file's (path, signature-or-version) and whether it affects the
  // global scope.
  const paths: string[] = (fileNames as string[]).map((name) =>
    relative(root, resolve(buildInfoDir, name)).split("\\").join("/"),
  );
  const shapes: string[] = [];
  const global: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const info: unknown = fileInfos[i];
    if (typeof info === "string") {
      // tsc's shorthand: signature equal to version, nothing else to say.
      shapes.push(info);
      global.push(false);
      continue;
    }
    if (typeof info !== "object" || info === null) {
      return {
        kind: "unreadable",
        why: `fileInfos[${i}] is neither a string nor an object`,
      };
    }
    const { version, signature, affectsGlobalScope } = info as Record<
      string,
      unknown
    >;
    if (typeof version !== "string") {
      return {
        kind: "unreadable",
        why: `fileInfos[${i}] has no string version`,
      };
    }
    if (
      signature !== undefined &&
      signature !== false &&
      typeof signature !== "string"
    ) {
      return {
        kind: "unreadable",
        why: `fileInfos[${i}].signature is not a string or false`,
      };
    }
    if (
      affectsGlobalScope !== undefined &&
      typeof affectsGlobalScope !== "boolean"
    ) {
      return {
        kind: "unreadable",
        why: `fileInfos[${i}].affectsGlobalScope is not a boolean`,
      };
    }
    // No signature (tsc omits it when it equals the version) or `false` (never
    // computed): the version, which moves on every edit — the safe side.
    shapes.push(typeof signature === "string" ? signature : version);
    global.push(affectsGlobalScope === true);
  }

  // The reference graph, 0-based. Absent maps are legitimate (a program with no
  // references at all writes neither), but one without the other is not.
  const succ: number[][] = Array.from({ length: n }, () => []);
  if (referencedMap !== undefined) {
    if (!Array.isArray(referencedMap) || !Array.isArray(fileIdsList)) {
      return {
        kind: "unreadable",
        why: "buildinfo referencedMap / fileIdsList are not arrays",
      };
    }
    const lists = fileIdsList as unknown[];
    for (const lst of lists) {
      if (!Array.isArray(lst) || !lst.every((id) => isFileId(id, n))) {
        return {
          kind: "unreadable",
          why: "buildinfo fileIdsList holds a non-file id",
        };
      }
    }
    for (const pair of referencedMap as unknown[]) {
      if (
        !Array.isArray(pair) ||
        pair.length !== 2 ||
        !isFileId(pair[0], n) ||
        !isFileId(pair[1], lists.length)
      ) {
        return {
          kind: "unreadable",
          why: "buildinfo referencedMap holds a malformed pair",
        };
      }
      const from = (pair[0] as number) - 1;
      for (const id of lists[(pair[1] as number) - 1] as number[]) {
        succ[from]!.push(id - 1);
      }
    }
  } else if (fileIdsList !== undefined) {
    return {
      kind: "unreadable",
      why: "buildinfo has fileIdsList but no referencedMap",
    };
  }
  return { kind: "graph", graph: { paths, shapes, global, succ } };
}

/** A repo source file's contract, as graph edges. */
export interface Contract {
  /** The nodes its `.d.ts` names (resolved; dependencies may be left out). */
  refs: readonly number[];
  /** Its `.d.ts` augments a module (`declare module "x"`). */
  augments: boolean;
}

/**
 * Every repo file's type fingerprint.
 *
 * `contracts` must hold an entry for every node `needsContract` names — a
 * missing one is a bug in the caller, not a file to guess about, and throws.
 */
export function computeTypeFingerprints(
  graph: BuildInfoGraph,
  contracts: ReadonlyMap<number, Contract>,
): Map<string, string> {
  const { paths, shapes, global, succ } = graph;
  const n = paths.length;
  const contractSucc: (readonly number[])[] = new Array<number[]>(n);
  const inGlobal = global.slice();
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
    if (c.augments) inGlobal[i] = true;
  }

  const line = (i: number): string => `${paths[i]}\0${shapes[i]}`;
  const globalFp = sha256(
    paths
      .map((_, i) => i)
      .filter((i) => inGlobal[i])
      .map(line)
      .sort()
      .join("\n"),
  );

  const compHash = condensationHashes(n, contractSucc, line);
  const fps = new Map<string, string>();
  for (let i = 0; i < n; i++) {
    const p = paths[i]!;
    if (!isRepoPath(p)) continue;
    const seen = [...new Set(succ[i]!.map((d) => compHash[d]!))].sort();
    fps.set(p, sha256(`${globalFp}\n${seen.join("\n")}`).slice(0, 16));
  }
  return fps;
}

/**
 * Every node's component hash, by node: Tarjan's SCC algorithm, ITERATIVE (an
 * explicit call stack — the repo program has ~14.5k files, and a recursive walk
 * down a long import chain would overflow), hashing each component as it is
 * emitted. Tarjan emits a component only after every component reachable from
 * it, so its successors' hashes are always ready.
 */
function condensationHashes(
  n: number,
  succ: readonly (readonly number[])[],
  line: (i: number) => string,
): string[] {
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const compHashes: string[] = [];
  const nodeHash: string[] = new Array<string>(n);
  const stack: number[] = [];
  const callNode: number[] = [];
  const callEdge: number[] = [];
  let next = 0;

  const visit = (v: number): void => {
    index[v] = low[v] = next++;
    stack.push(v);
    onStack[v] = 1;
    callNode.push(v);
    callEdge.push(0);
  };

  for (let s = 0; s < n; s++) {
    if (index[s] !== -1) continue;
    visit(s);
    while (callNode.length > 0) {
      const top = callNode.length - 1;
      const v = callNode[top]!;
      const edges = succ[v]!;
      const e = callEdge[top]!;
      if (e < edges.length) {
        callEdge[top] = e + 1;
        const w = edges[e]!;
        if (index[w] === -1) visit(w);
        else if (onStack[w]) low[v] = Math.min(low[v]!, index[w]!);
        continue;
      }
      callNode.pop();
      callEdge.pop();
      if (callNode.length > 0) {
        const u = callNode[callNode.length - 1]!;
        low[u] = Math.min(low[u]!, low[v]!);
      }
      if (low[v] !== index[v]) continue;
      // v roots a component: pop it, then hash it from its members and the
      // (already final) hashes of the components it reaches.
      const id = compHashes.length;
      const members: number[] = [];
      let w: number;
      do {
        w = stack.pop()!;
        onStack[w] = 0;
        comp[w] = id;
        members.push(w);
      } while (w !== v);
      const successors = new Set<string>();
      for (const m of members) {
        for (const t of succ[m]!) {
          if (comp[t] !== id) successors.add(compHashes[comp[t]!]!);
        }
      }
      const h = sha256(
        `m\n${members.map(line).sort().join("\n")}\ns\n${[...successors].sort().join("\n")}`,
      );
      compHashes.push(h);
      for (const m of members) nodeHash[m] = h;
    }
  }
  return nodeHash;
}
