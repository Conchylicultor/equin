/**
 * The keyed check (research/2026-10-18-global-tsc-recheck-follows-contracts.md):
 *   1. the program graph is the builder's own `referencedMap` and
 *      `affectsGlobalScope`, edge for edge, on a fixture with every edge kind;
 *   2. across edits, the walk checks only the files whose key moved — a body
 *      edit the file alone, an API change its importers while their contracts
 *      name it, a chain to its end — and its every result equals a full check
 *      of a fresh program (no divergence), including a cycle, an augmentation,
 *      an added file that shadows a resolution, and an unresolved import that
 *      starts resolving;
 *   3. its type fingerprints are the whole-graph ones (`computeTypeFingerprints`);
 *   4. a store warmed on another tree gives the same answers as a cold one.
 */

import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join, relative, resolve } from "path";
import ts from "typescript";
import { canonical, contractResolver } from "./contract-refs";
import { signatureEmitOptions } from "./emit-options";
import {
  canonicalDeclarations,
  compareResults,
  keyedCheck,
  type FileResultsLookup,
  type KeyedCheck,
  type UnitResults,
} from "./keyed-check";
import { programGraph } from "./program-graph";
import { computeTypeFingerprints } from "./type-fingerprint";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const freshRoot = (): string => {
  // The real path (`/private/tmp` on macOS): the program names files by it.
  const r = realpathSync(mkdtempSync(join(tmpdir(), "keyed-check-")));
  roots.push(r);
  return r;
};

const memoryStore = (): FileResultsLookup => {
  const m = new Map<string, UnitResults>();
  return { read: (k) => m.get(k), record: (k, r) => void m.set(k, r) };
};

const baseOptions = (root: string): ts.CompilerOptions =>
  signatureEmitOptions(
    {
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      lib: ["lib.es2022.d.ts"],
      types: [],
      noUnusedLocals: true,
    },
    root,
  );

/** Write `files` under `root`, deleting the ones `previous` had and `files` does not. */
function writeTree(
  root: string,
  files: Record<string, string>,
  previous: Record<string, string> = {},
): void {
  for (const rel of Object.keys(previous)) {
    if (!(rel in files)) rmSync(join(root, rel), { force: true });
  }
  for (const [rel, text] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
  }
}

const sourceRoots = (root: string, files: Record<string, string>): string[] =>
  Object.keys(files)
    .filter((f) => !f.startsWith("node_modules/"))
    .map((f) => join(root, f));

interface Run {
  keyed: KeyedCheck;
  full: KeyedCheck;
  /** Repo paths the walk checked (its key was not in the store). */
  checked: string[];
}

/** One run on the tree as it is now: the walk over `store`, and a full check beside it. */
function run(
  root: string,
  files: Record<string, string>,
  store: FileResultsLookup,
): Run {
  const options = baseOptions(root);
  const build = (): ts.Program =>
    ts.createProgram({ rootNames: sourceRoots(root, files), options });
  const keyed = keyedCheck({
    root,
    program: build(),
    options,
    engineFp: "engine",
    store,
    mode: "keyed",
  });
  const fresh = build();
  fresh.getSemanticDiagnostics();
  const full = keyedCheck({
    root,
    program: fresh,
    options,
    engineFp: "engine",
    store: memoryStore(),
    mode: "all",
  });
  const checked = keyed.units
    .filter((u) => u.checked)
    .flatMap((u) => u.nodes.map((i) => keyed.graph.paths[i]!))
    .sort();
  return { keyed, full, checked };
}

/** Run `trees` in order over one store; every run must agree with its full check. */
function walk(trees: Record<string, string>[]): string[][] {
  const root = freshRoot();
  const store = memoryStore();
  let previous: Record<string, string> = {};
  return trees.map((files) => {
    writeTree(root, files, previous);
    previous = files;
    const r = run(root, files, store);
    expect(compareResults(r.keyed, r.full)).toEqual([]);
    return r.checked;
  });
}

// ─── 1. The graph is the builder's ──────────────────────────────────────────

/** The builder's `referencedMap` and global flags, read off the buildinfo it writes. */
function builderGraph(
  root: string,
  files: Record<string, string>,
): { refs: Map<string, string[]>; global: Set<string> } {
  const buildInfoPath = join(root, ".cache", "graph.tsbuildinfo");
  const options = {
    ...baseOptions(root),
    incremental: true,
    tsBuildInfoFile: buildInfoPath,
  };
  const builder = ts.createIncrementalProgram({
    rootNames: sourceRoots(root, files),
    options,
  });
  let text: string | undefined;
  builder.emit(undefined, (fileName, data) => {
    if (fileName.endsWith(".tsbuildinfo")) text = data;
  });
  const doc = JSON.parse(text!) as {
    fileNames: string[];
    fileInfos: (string | { affectsGlobalScope?: boolean })[];
    fileIdsList?: number[][];
    referencedMap?: [number, number][];
  };
  const path = (id: number): string =>
    canonical(
      relative(root, resolve(dirname(buildInfoPath), doc.fileNames[id - 1]!))
        .split("\\")
        .join("/"),
    );
  const refs = new Map<string, string[]>();
  for (const [from, list] of doc.referencedMap ?? []) {
    refs.set(path(from), doc.fileIdsList![list - 1]!.map(path).sort());
  }
  const global = new Set<string>();
  doc.fileInfos.forEach((info, i) => {
    if (typeof info === "object" && info.affectsGlobalScope)
      global.add(path(i + 1));
  });
  return { refs, global };
}

test("the program graph is the builder's referencedMap and global scope", () => {
  const root = freshRoot();
  const files: Record<string, string> = {
    "node_modules/@types/fixture-env/index.d.ts":
      "declare var fixtureEnv: string;\n",
    "node_modules/dep/package.json": '{"name":"dep","types":"index.d.ts"}\n',
    "node_modules/dep/index.d.ts": "export interface Dep { d: number }\n",
    "src/a.ts": 'import type { Dep } from "dep";\nexport type A = Dep;\n',
    "src/b.ts":
      '/// <reference path="./ambient.d.ts" />\n/// <reference types="fixture-env" />\nimport { type A } from "./a";\nexport * from "./c";\nexport const lazy = () => import("./c");\nexport const a: A | undefined = undefined;\n',
    "src/c.ts": "export const c = 1;\n",
    "src/ambient.d.ts":
      'declare module "shared-ambient" { export const one: 1; }\n',
    "src/ambient2.d.ts":
      'declare module "shared-ambient" { export const two: 2; }\n',
    "src/uses-ambient.ts":
      'import { one } from "shared-ambient";\nexport const u = one;\n',
    "src/augment.ts":
      'import type { A } from "./a";\ndeclare module "./a" { interface Extra { x: A } }\nexport {};\n',
    "src/global.ts":
      "declare global { interface Window { fixture: 1 } }\nexport {};\n",
    "src/script.ts": "const scriptLocal = 1;\n",
  };
  writeTree(root, files);
  const builder = builderGraph(root, files);
  const program = ts.createProgram({
    rootNames: sourceRoots(root, files),
    options: baseOptions(root),
  });
  const graph = programGraph(root, program);
  const ours = new Map<string, string[]>();
  // The builder names files by tsc's canonical (case-folded) path.
  graph.paths.forEach((p, i) => {
    if (graph.succ[i]!.length > 0) {
      ours.set(
        canonical(p),
        graph.succ[i]!.map((j) => canonical(graph.paths[j]!)).sort(),
      );
    }
  });
  expect(Object.fromEntries(ours)).toEqual(Object.fromEntries(builder.refs));
  // Ours adds module augmentations to tsc's global scope: every importer of
  // the augmented module sees one without naming its file.
  const global = new Set(
    graph.paths.filter((_, i) => graph.global[i]).map(canonical),
  );
  expect([...global].sort()).toEqual(
    [...builder.global, "src/augment.ts"].sort(),
  );
  // Spot-check what the edge kinds are, so the equality above is not vacuous.
  expect(ours.get("src/b.ts")).toEqual(
    expect.arrayContaining([
      "src/a.ts",
      "src/c.ts",
      "src/ambient.d.ts",
      "node_modules/@types/fixture-env/index.d.ts",
    ]),
  );
});

// ─── 2. The walk checks what moved, and agrees with a full check ────────────

const CHAIN: Record<string, string> = {
  "g.ts": "export interface G { x: number }\n",
  "e.ts":
    'import type { G } from "./g";\nexport type T = G;\nexport const make = (): T => ({ x: 1 });\n',
  "d.ts": 'import { make } from "./e";\nexport const value = make();\n',
  "f.ts": 'import { value } from "./d";\nexport const n: number = value.x;\n',
  "k.ts":
    'import type { G } from "./g";\nexport function k(): number { const v: G = { x: 1 }; return v.x; }\n',
  "h.ts": 'import { k } from "./k";\nexport const h = k();\n',
  "lone.ts": "export const lone = 1;\n",
};

test("a cold run checks everything; an unchanged tree checks nothing", () => {
  const [cold, again] = walk([CHAIN, CHAIN]);
  expect(cold).toEqual(Object.keys(CHAIN).sort());
  expect(again).toEqual([]);
});

test("a body edit checks the file alone", () => {
  const [, body] = walk([
    CHAIN,
    {
      ...CHAIN,
      "k.ts":
        'import type { G } from "./g";\nexport function k(): number { const v: G = { x: 2 }; return v.x + 1; }\n',
    },
  ]);
  expect(body).toEqual(["k.ts"]);
});

test("an API change follows the contracts to their end, and stops where they name nothing", () => {
  const [, api] = walk([
    CHAIN,
    { ...CHAIN, "g.ts": "export interface G { x: number; y?: string }\n" },
  ]);
  // e and k import g; d sees it through e's contract, f through d's (two
  // unchanged contracts deep); h sees only k's contract, which names nothing
  // of g.
  expect(api).toEqual(["d.ts", "e.ts", "f.ts", "g.ts", "k.ts"]);
});

test("a type error introduced through a contract is found in the importer", () => {
  const broken = { ...CHAIN, "g.ts": "export interface G { x: string }\n" };
  const root = freshRoot();
  const store = memoryStore();
  writeTree(root, CHAIN);
  run(root, CHAIN, store);
  writeTree(root, broken, CHAIN);
  const r = run(root, broken, store);
  expect(compareResults(r.keyed, r.full)).toEqual([]);
  const diags = [...r.keyed.results.entries()].flatMap(
    ([, res]) => res.diagnostics,
  );
  // f's `const n: number = value.x` is now a string: f is two contracts away.
  expect(
    diags.some((d) => d.startsWith("f.ts:2:") && d.includes("TS2322")),
  ).toBe(true);
});

test("a cycle is checked as one unit", () => {
  const cycle = {
    "p.ts":
      'import { q } from "./q";\nexport const p = (): number => q() + 1;\n',
    "q.ts":
      'import { p } from "./p";\nexport const q = (): number => 1;\nexport const pp = p;\n',
    "r.ts": 'import { q } from "./q";\nexport const r = q();\n',
  };
  const [, body] = walk([
    cycle,
    {
      ...cycle,
      "p.ts":
        'import { q } from "./q";\nexport const p = (): number => q() + 2;\n',
    },
  ]);
  expect(body).toEqual(["p.ts", "q.ts"]);
});

test("an augmentation is global: its edit re-checks everything", () => {
  const files = {
    ...CHAIN,
    "aug.ts":
      'declare module "./g" { interface G { z?: boolean } }\nexport {};\n',
  };
  const [, edited] = walk([
    files,
    {
      ...files,
      "aug.ts":
        'declare module "./g" { interface G { z?: string } }\nexport {};\n',
    },
  ]);
  expect(edited).toEqual(Object.keys(files).sort());
});

test("an added file that shadows a resolution re-checks its importers", () => {
  const files = {
    "lib/index.ts": "export const v: number = 1;\n",
    "use.ts": 'import { v } from "./lib";\nexport const w: number = v;\n',
  };
  const [, shadowed] = walk([
    files,
    { ...files, "lib.ts": 'export const v: string = "s";\n' },
  ]);
  expect(shadowed).toEqual(["lib.ts", "use.ts"]);
});

test("an unresolved import that starts resolving re-checks its importer", () => {
  const files = {
    "use.ts": 'import { v } from "./later";\nexport const w = v;\n',
  };
  const [cold, resolved] = walk([
    files,
    { ...files, "later.ts": "export const v = 1;\n" },
  ]);
  expect(cold).toEqual(["use.ts"]);
  expect(resolved).toEqual(["later.ts", "use.ts"]);
});

test("a name printed through a barrel is an edge to the file declaring it", () => {
  // tsc may print a type through any accessible path — here the barrel that
  // itself imports the file whose contract names it. The edge goes to the
  // declaration (`types.ts`), never to the barrel.
  const root = freshRoot();
  const files = {
    "core/types.ts": "export interface X { a: number }\n",
    "core/agent.ts":
      'import type { X } from "./types";\nexport const agent = (): X => ({ a: 1 });\n',
    "core/index.ts":
      'export * from "./types";\nexport { agent } from "./agent";\n',
  };
  writeTree(root, files);
  const options = baseOptions(root);
  const program = ts.createProgram({
    rootNames: sourceRoots(root, files),
    options,
  });
  const graph = programGraph(root, program);
  const resolver = contractResolver(
    root,
    program,
    options,
    graph.paths,
    graph.global,
  );
  const agent = graph.paths.indexOf("core/agent.ts");
  const refs = resolver.refs(agent, {
    modules: { "./index": ["X"], "./types": ["*"] },
    paths: [],
  });
  expect(refs.map((i) => graph.paths[i]).sort()).toEqual(["core/types.ts"]);
  // A whole-module mention is the module itself.
  const whole = resolver.refs(agent, {
    modules: { "./index": ["*"] },
    paths: [],
  });
  expect(whole.map((i) => graph.paths[i])).toEqual(["core/index.ts"]);
});

test("a signature ignores the order of a type literal's properties and a union's members, never of overloads", () => {
  // The order tsc printed for 11 exemption manifests, checked in two orders.
  const a =
    'declare const d: ({\n    rule: "x";\n    task?: undefined;\n} | {\n    rule: "y";\n    task: string;\n})[];\n';
  const b =
    'declare const d: ({\n    task?: undefined;\n    rule: "x";\n} | {\n    rule: "y";\n    task: string;\n})[];\n';
  expect(canonicalDeclarations(a)).toBe(canonicalDeclarations(b));
  // A union of object types, in either order.
  const u =
    'declare const s: {\n    state: "up";\n} | {\n    state: "down";\n    since: number;\n};\n';
  const v =
    'declare const s: {\n    state: "down";\n    since: number;\n} | {\n    state: "up";\n};\n';
  expect(canonicalDeclarations(u)).toBe(canonicalDeclarations(v));
  const f =
    "declare const o: {\n    f(x: string): 1;\n    f(x: number): 2;\n};\n";
  const g =
    "declare const o: {\n    f(x: number): 2;\n    f(x: string): 1;\n};\n";
  expect(canonicalDeclarations(f)).not.toBe(canonicalDeclarations(g));
});

// ─── 3. Its fingerprints are the whole-graph ones ───────────────────────────

test("the walk's type fingerprints equal the whole-graph computation", () => {
  const root = freshRoot();
  const files = {
    ...CHAIN,
    "p.ts":
      'import { q } from "./q";\nexport const p = (): number => q() + 1;\n',
    "q.ts":
      'import { p } from "./p";\nimport type { T } from "./e";\nexport const q = (): number => 1;\nexport const pp = p;\nexport type QT = T;\n',
  };
  writeTree(root, files);
  const { keyed } = run(root, files, memoryStore());
  const whole = computeTypeFingerprints(
    keyed.graph,
    keyed.shapes,
    keyed.contracts,
    "engine",
  );
  expect(Object.fromEntries(keyed.typeFps)).toEqual(Object.fromEntries(whole));
});

// ─── 4. A store warmed elsewhere ────────────────────────────────────────────

test("a store warmed on another tree gives the full check's answers", () => {
  const root = freshRoot();
  const store = memoryStore();
  const other = {
    ...CHAIN,
    "g.ts": "export interface G { x: number; w: number }\n",
    "e.ts":
      'import type { G } from "./g";\nexport type T = G;\nexport const make = (): T => ({ x: 1, w: 2 });\n',
  };
  writeTree(root, other);
  run(root, other, store);
  writeTree(root, CHAIN, other);
  const r = run(root, CHAIN, store);
  expect(compareResults(r.keyed, r.full)).toEqual([]);
  // Same text, different declarations behind it: g and e moved back, and so
  // did whatever their contracts reach.
  expect(r.checked).toEqual(["d.ts", "e.ts", "f.ts", "g.ts", "k.ts"]);
});
