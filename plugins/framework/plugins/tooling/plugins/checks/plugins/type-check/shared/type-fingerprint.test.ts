/**
 * The type fingerprint (research/2026-10-17-global-lint-keyed-on-what-it-reads.md,
 * research/2026-10-18-global-typed-lint-key-stops-at-contracts.md):
 *   1. a body edit (version moves, signature does not) moves no fingerprint;
 *   2. a signature change moves the files that import it directly, and the
 *      files whose direct imports' CONTRACTS name it, transitively — and the
 *      chain stops at a contract that does not name it;
 *   3. a global-scope file's change, or an augmenting file's, moves every file;
 *   4. cycles are one component, and a long chain does not overflow the stack;
 *   5. a placeholder signature (string entry, none, `false`) falls back to the
 *      version;
 *   6. the ids are one-based, paths are relative to the buildinfo's directory,
 *      and only repo files come back;
 *   7. a shape it does not know is `unreadable`, never an empty table, and a
 *      source file with no contract edges throws;
 *   8. the same, end to end, on a buildinfo and declarations real tsc wrote —
 *      re-exports, inferred `import("…")` types three files deep, and a chain
 *      that stops;
 *   9. PURE: the same files give the same fingerprints whatever order the
 *      checker reached them in (an incremental run reaches them in a different
 *      order than a cold one) — the property every cached typed result rests
 *      on, held by the worker's `stableTypeOrdering`.
 */

import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import ts from "typescript";
import {
  contractEdges,
  type ContractRefsLookup,
  type ContractSpecifiers,
} from "./contract-refs";
import { signatureEmitOptions } from "./emit-options";
import {
  computeTypeFingerprints,
  readBuildInfoGraph,
  typedResultKey,
  type Contract,
} from "./type-fingerprint";

const ROOT = "/repo";
const DIR = "/repo/.cache/tsbuildinfo";

interface FixtureFile {
  /** Repo-relative path. */
  path: string;
  version: string;
  /** Omitted: a placeholder (tsc writes a bare string entry). */
  signature?: string | false;
  global?: boolean;
  /** Repo-relative paths this file references. */
  refs?: string[];
  /**
   * Repo-relative paths its contract names (a source file only). Omitted: all
   * of `refs`, the widest a contract can be.
   */
  contract?: string[];
  augments?: boolean;
}

/** A buildinfo in tsc's incremental layout, one-based ids, paths from DIR. */
function buildInfo(files: FixtureFile[]): string {
  const id = new Map(files.map((f, i) => [f.path, i + 1] as const));
  const fileIdsList: number[][] = [];
  const referencedMap: [number, number][] = [];
  for (const f of files) {
    if (!f.refs?.length) continue;
    fileIdsList.push(f.refs.map((r) => id.get(r)!).sort((a, b) => a - b));
    referencedMap.push([id.get(f.path)!, fileIdsList.length]);
  }
  return JSON.stringify({
    fileNames: files.map((f) => `../../${f.path}`),
    fileInfos: files.map((f) =>
      f.signature === undefined && !f.global
        ? f.version
        : {
            version: f.version,
            ...(f.signature !== undefined ? { signature: f.signature } : {}),
            ...(f.global ? { affectsGlobalScope: true } : {}),
          },
    ),
    ...(referencedMap.length ? { fileIdsList, referencedMap } : {}),
    version: "6.0.3",
  });
}

function fps(files: FixtureFile[]): Map<string, string> {
  const r = readBuildInfoGraph(buildInfo(files), DIR, ROOT);
  if (r.kind !== "graph") throw new Error(r.why);
  const id = new Map(files.map((f, i) => [f.path, i] as const));
  const contracts = new Map<number, Contract>();
  files.forEach((f, i) => {
    if (f.path.endsWith(".d.ts") || f.path.startsWith("node_modules/")) return;
    contracts.set(i, {
      refs: (f.contract ?? f.refs ?? []).map((p) => id.get(p)!),
      augments: f.augments === true,
    });
  });
  return computeTypeFingerprints(r.graph, contracts);
}

/** The paths whose fingerprint differs between two tables. */
function moved(a: Map<string, string>, b: Map<string, string>): string[] {
  return [...a.keys()].filter((k) => a.get(k) !== b.get(k)).sort();
}

// c → b → a, d alone, g a global file.
const BASE: FixtureFile[] = [
  { path: "a.ts", version: "va", signature: "sa" },
  { path: "b.ts", version: "vb", signature: "sb", refs: ["a.ts"] },
  { path: "c.ts", version: "vc", signature: "sc", refs: ["b.ts"] },
  { path: "d.ts", version: "vd", signature: "sd" },
  { path: "g.d.ts", version: "vg", global: true },
];
const edit = (
  files: FixtureFile[],
  path: string,
  change: Partial<FixtureFile>,
): FixtureFile[] =>
  files.map((f) => (f.path === path ? { ...f, ...change } : f));

test("a body edit moves no fingerprint", () => {
  expect(moved(fps(BASE), fps(edit(BASE, "a.ts", { version: "va2" })))).toEqual(
    [],
  );
});

test("a signature change moves its importers, and theirs while a contract names it", () => {
  // b's contract names a (the widest case), so c — which imports b — sees a.
  // a itself does not move: its own text is in its result key already.
  expect(
    moved(fps(BASE), fps(edit(BASE, "a.ts", { signature: "sa2" }))),
  ).toEqual(["b.ts", "c.ts"]);
  // Not upward: what a file references does not see the file itself.
  expect(
    moved(fps(BASE), fps(edit(BASE, "c.ts", { signature: "sc2" }))),
  ).toEqual([]);
});

test("the chain stops at an importer whose contract does not name the change", () => {
  // b uses a only in its body: b's `.d.ts` names nothing of a.
  const bodyOnly = edit(BASE, "b.ts", { contract: [] });
  expect(
    moved(fps(bodyOnly), fps(edit(bodyOnly, "a.ts", { signature: "sa2" }))),
  ).toEqual(["b.ts"]);
});

test("a contract chain is followed to its end, not one hop", () => {
  // f → d; d's contract names e; e's contract names g0. A change to g0 reaches
  // f through two contracts that are themselves unchanged.
  const chain: FixtureFile[] = [
    { path: "g0.ts", version: "v", signature: "s" },
    { path: "e.ts", version: "v", signature: "s", refs: ["g0.ts"] },
    { path: "d.ts", version: "v", signature: "s", refs: ["e.ts"] },
    { path: "f.ts", version: "v", signature: "s", refs: ["d.ts"] },
  ];
  expect(
    moved(fps(chain), fps(edit(chain, "g0.ts", { signature: "s2" }))),
  ).toEqual(["d.ts", "e.ts", "f.ts"]);
});

test("a global-scope file's change moves every file", () => {
  expect(
    moved(fps(BASE), fps(edit(BASE, "g.d.ts", { version: "vg2" }))),
  ).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "g.d.ts"]);
});

test("a module augmentation counts as global scope", () => {
  // d augments a module nobody reaches through d: its change still moves all.
  const augmented = edit(BASE, "d.ts", { augments: true });
  expect(
    moved(fps(augmented), fps(edit(augmented, "d.ts", { signature: "sd2" }))),
  ).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "g.d.ts"]);
});

test("a cycle is one component, seen by whoever references it", () => {
  const cycle: FixtureFile[] = [
    { path: "a.ts", version: "va", signature: "sa", refs: ["b.ts"] },
    { path: "b.ts", version: "vb", signature: "sb", refs: ["a.ts"] },
    { path: "c.ts", version: "vc", signature: "sc", refs: ["a.ts"] },
    { path: "d.ts", version: "vd", signature: "sd" },
  ];
  const after = fps(edit(cycle, "b.ts", { signature: "sb2" }));
  expect(moved(fps(cycle), after)).toEqual(["a.ts", "b.ts", "c.ts"]);
});

test("a chain far deeper than the call stack is walked iteratively", () => {
  const n = 20_000;
  const chain: FixtureFile[] = Array.from({ length: n }, (_, i) => ({
    path: `f${i}.ts`,
    version: `v${i}`,
    signature: `s${i}`,
    ...(i > 0 ? { refs: [`f${i - 1}.ts`] } : {}),
  }));
  const before = fps(chain);
  chain[0] = { ...chain[0]!, signature: "s0'" };
  expect(moved(before, fps(chain)).length).toBe(n - 1);
  // Four builds of a 20k-file graph: seconds on a loaded host.
}, 30_000);

test("a placeholder signature falls back to the version", () => {
  for (const placeholder of [undefined, false] as const) {
    const files: FixtureFile[] = [
      { path: "a.ts", version: "va", signature: placeholder },
      { path: "b.ts", version: "vb", signature: "sb", refs: ["a.ts"] },
    ];
    expect(
      moved(fps(files), fps(edit(files, "a.ts", { version: "va2" }))),
    ).toEqual(["b.ts"]);
  }
});

test("ids are one-based, paths resolve from the buildinfo's directory, dependencies are left out", () => {
  // File 2 references file 1: an off-by-one would point it at nothing (or at
  // itself) and the edit below would not move it.
  const files: FixtureFile[] = [
    { path: "node_modules/dep/index.d.ts", version: "v1", signature: "s1" },
    {
      path: "src/x/core/a.ts",
      version: "v2",
      signature: "s2",
      refs: ["node_modules/dep/index.d.ts"],
    },
  ];
  const before = fps(files);
  expect([...before.keys()]).toEqual(["src/x/core/a.ts"]);
  const after = fps(
    edit(files, "node_modules/dep/index.d.ts", { signature: "s1'" }),
  );
  expect(moved(before, after)).toEqual(["src/x/core/a.ts"]);
});

test("a shape it does not know is unreadable, never an empty table", () => {
  const ok = JSON.parse(buildInfo(BASE)) as Record<string, unknown>;
  const cases: Record<string, unknown>[] = [
    { ...ok, fileNames: undefined },
    { ...ok, fileInfos: (ok.fileInfos as unknown[]).slice(1) },
    { ...ok, fileInfos: [42, ...(ok.fileInfos as unknown[]).slice(1)] },
    { ...ok, referencedMap: [[0, 1]] },
    { ...ok, referencedMap: [[1, 99]] },
    { ...ok, fileIdsList: [[0]] },
    { ...ok, referencedMap: undefined },
  ];
  for (const doc of cases) {
    expect(readBuildInfoGraph(JSON.stringify(doc), DIR, ROOT).kind).toBe(
      "unreadable",
    );
  }
  expect(readBuildInfoGraph("{", DIR, ROOT).kind).toBe("unreadable");
});

test("a source file with no contract edges is refused", () => {
  const r = readBuildInfoGraph(buildInfo(BASE), DIR, ROOT);
  if (r.kind !== "graph") throw new Error(r.why);
  expect(() => computeTypeFingerprints(r.graph, new Map())).toThrow(
    "no contract edges",
  );
});

test("the typed result key depends on both the rules and the types", () => {
  const k = typedResultKey("rules", "types");
  expect(k).toHaveLength(16);
  expect(typedResultKey("rules2", "types")).not.toBe(k);
  expect(typedResultKey("rules", "types2")).not.toBe(k);
});

// End to end: the shape the worker really reads, written by the compiler the
// worker really runs, with the worker's own emit options, and contract edges
// read off declarations it really emits.
const realRoot = mkdtempSync(join(tmpdir(), "type-fingerprint-"));
afterAll(() => rmSync(realRoot, { recursive: true, force: true }));
const buildInfoDir = join(realRoot, ".cache");

/** An in-memory contract-refs store, shared across compiles like the real one. */
const memoryStore = (): ContractRefsLookup => {
  const m = new Map<string, ContractSpecifiers>();
  return {
    read: (p, sig) => m.get(`${p}\0${sig}`),
    record: (p, sig, refs) => void m.set(`${p}\0${sig}`, refs),
  };
};

/**
 * Compile `sources` into the buildinfo at `buildInfoPath` — a fresh path by
 * default, so the build starts cold; pass one to build incrementally on top of
 * an earlier compile. `override` replaces worker options (the purity test's
 * control).
 */
function compile(
  sources: Record<string, string>,
  buildInfoPath = join(buildInfoDir, `${Math.random()}.tsbuildinfo`),
  override: ts.CompilerOptions = {},
  store: ContractRefsLookup = memoryStore(),
): Map<string, string> {
  for (const [rel, text] of Object.entries(sources)) {
    const abs = join(realRoot, rel);
    ts.sys.createDirectory(dirname(abs));
    writeFileSync(abs, text);
  }
  let text: string | undefined;
  const options = {
    ...signatureEmitOptions(
      {
        strict: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        lib: ["lib.es2022.d.ts"],
        types: [],
      },
      realRoot,
      buildInfoPath,
    ),
    ...override,
  };
  const builder = ts.createIncrementalProgram({
    rootNames: Object.keys(sources).map((rel) => join(realRoot, rel)),
    options,
  });
  builder.emit(undefined, (fileName, data) => {
    if (fileName.endsWith(".tsbuildinfo")) text = data;
  });
  if (text === undefined) throw new Error("tsc wrote no buildinfo");
  const r = readBuildInfoGraph(text, buildInfoDir, realRoot);
  if (r.kind !== "graph") throw new Error(r.why);
  const { contracts } = contractEdges(
    realRoot,
    builder.getProgram(),
    options,
    r.graph,
    new Map(),
    store,
  );
  return computeTypeFingerprints(r.graph, contracts);
}

test("on a buildinfo tsc wrote: a body edit moves nothing, an API change moves the importer", () => {
  const sources = {
    "a.ts": "export function f(): number { return 1; }\n",
    "b.ts": 'import { f } from "./a";\nexport const g = (): number => f();\n',
    "c.ts": "export const unrelated = 1;\n",
  };
  const before = compile(sources);
  expect([...before.keys()].sort()).toEqual(["a.ts", "b.ts", "c.ts"]);
  const body = compile({
    ...sources,
    "a.ts": "export function f(): number { return 2; }\n",
  });
  expect(moved(before, body)).toEqual([]);
  const api = compile({
    ...sources,
    "a.ts": "export function f(): string { return 'x'; }\n",
  });
  expect(moved(before, api)).toEqual(["b.ts"]);
});

test("on real declarations: the chain follows what contracts name, and stops where they name nothing", () => {
  // g ← e (`export type T = G`) ← d (inferred `import("./e")…`) ← f: three
  // contracts deep. h imports k, which uses g in its body only.
  const sources = {
    "chain/g.ts": "export interface G { x: number }\n",
    "chain/e.ts":
      'import type { G } from "./g";\nexport type T = G;\nexport const make = (): T => ({ x: 1 });\n',
    "chain/d.ts": 'import { make } from "./e";\nexport const value = make();\n',
    "chain/f.ts":
      'import { value } from "./d";\nexport const n: number = value.x;\n',
    "chain/r.ts": 'export * from "./g";\n',
    "chain/s.ts": 'import type { G } from "./r";\nexport type S = G[];\n',
    "chain/k.ts":
      'import type { G } from "./g";\nexport function k(): number { const v: G = { x: 1 }; return v.x; }\n',
    "chain/h.ts": 'import { k } from "./k";\nexport const h = k();\n',
  };
  const store = memoryStore();
  const before = compile(sources, undefined, {}, store);
  const after = compile(
    {
      ...sources,
      "chain/g.ts": "export interface G { x: number; y?: string }\n",
    },
    undefined,
    {},
    store,
  );
  // e, k and r import g; d and f see it through contracts; s through r's
  // re-export. h sees only k's contract, which does not name g.
  expect(moved(before, after)).toEqual([
    "chain/d.ts",
    "chain/e.ts",
    "chain/f.ts",
    "chain/k.ts",
    "chain/r.ts",
    "chain/s.ts",
  ]);
});

// The hazard: tsc prints an inferred union (and the keys of an inferred
// object, e.g. a zod schema's output) in the order its member types were
// CREATED, so a file's `.d.ts` depends on which files the checker reached
// before it. An incremental run checks only the affected files, so it reaches
// a file in a different state than a cold one. Root order changes that same
// state deterministically, which is what makes it testable. The literals are
// ones no lib file declares: those exist before the fixture is checked and
// would fix the order. A file's own signature is not in its own fingerprint
// (its text is in its result key already), so `use.ts` is the reader that
// sees `pick.ts`'s.
const UNION = {
  "first.ts": 'export const first = "qqalpha" as const;\n',
  "pick.ts":
    'export const pick = (n: number) => (n > 0 ? "qqzeta" : "qqalpha");\n',
};
const USE = {
  "use.ts": 'import { pick } from "./pick";\nexport const use = pick;\n',
};

/** UNION's fingerprints, with `first.ts` checked first, and then after `pick.ts`. */
function bothCheckOrders(override: ts.CompilerOptions = {}): {
  firstFirst: Map<string, string>;
  pickFirst: Map<string, string>;
} {
  const reversed = Object.fromEntries(Object.entries(UNION).reverse());
  return {
    firstFirst: compile({ ...UNION, ...USE }, undefined, override),
    pickFirst: compile({ ...reversed, ...USE }, undefined, override),
  };
}

test("pure: the same files have the same fingerprints whatever order the checker reached them in", () => {
  const { firstFirst, pickFirst } = bothCheckOrders();
  expect(moved(firstFirst, pickFirst)).toEqual([]);
});

test("the purity fixture does reproduce the hazard without stable type ordering", () => {
  // The control: if this stops diverging, the test above proves nothing.
  const { firstFirst, pickFirst } = bothCheckOrders({
    stableTypeOrdering: false,
  });
  expect(moved(firstFirst, pickFirst)).toEqual(["use.ts"]);
});
