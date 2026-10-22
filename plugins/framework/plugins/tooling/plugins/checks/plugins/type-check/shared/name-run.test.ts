/**
 * The two-program type check (research/2026-10-21-global-type-check-two-programs.md),
 * on fixture trees: runs in sequence over one store, every one compared with a
 * full check of a fresh whole program (no divergence allowed), and the files
 * each run checked:
 *
 *   1. a cold run checks everything, an unchanged tree nothing, a body edit
 *      the file alone (program 2 empty);
 *   2. an API change follows the names that use it — through contracts, a
 *      re-export chain, an inferred export (inference edges), a written type
 *      naming an outside type — and stops where nothing uses what moved;
 *   3. inside an import cycle keys are per file (a body edit stops at the
 *      file); an augmentation is global (everything);
 *   4. resolutions, keyed on the TREE (the check's view, never the disk): an
 *      added file that shadows one, a file added beside a directory index, a
 *      probed directory that starts to exist, an import that starts
 *      resolving — and a file on disk but not in the tree, which moves
 *      nothing; a version is the git blob sha, and bytes that no longer
 *      match it fail the run;
 *   5. a store warmed on another tree; root order does not move a key;
 *   6. typed lint: a file is linted in the program that holds it, and a valid
 *      file whose typed part is stale joins program 2 as source;
 *   7. a missed prediction (forced, by a store blind to inference edges):
 *      thrown, or answered by one whole program and reported.
 */

import { afterAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import ts from "typescript";
import { signatureEmitOptions } from "./emit-options";
import { compareResults, fullCheck } from "./full-check";
import { forEachComponent, typedResultKey } from "./keys";
import { createSourceFileCache } from "./name-host";
import { contractNames, nameKey } from "./name-records";
import {
  PredictionMissed,
  runNameCheck,
  type LintHook,
  type NameRunOutput,
} from "./name-run";
import { memoryNameStore, type NameStore } from "./name-store";
import { gitBlobSha, repoViewOver, type RepoView } from "./repo-view";
import { canonicalDeclarations } from "./tsc-engine";

// Each case builds several programs over lib.es2022 — seconds on a loaded host,
// past bun's 5 s default.
setDefaultTimeout(60_000);

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});
const freshRoot = (): string => {
  // The real path (`/private/tmp` on macOS): the program names files by it.
  const r = realpathSync(mkdtempSync(join(tmpdir(), "name-run-")));
  roots.push(r);
  return r;
};

const optionsFor = (root: string, extra: ts.CompilerOptions = {}) =>
  signatureEmitOptions(
    {
      strict: true,
      skipLibCheck: true,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      moduleDetection: ts.ModuleDetectionKind.Force,
      lib: ["lib.es2022.d.ts"],
      types: [],
      noUnusedLocals: true,
      ...extra,
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

/** A fake tree hash: SHA-1 length, so versions are git's SHA-1 blob shas. */
const TREE = "0".repeat(40);

/**
 * The tree a fixture is: exactly `files` (its `node_modules/` aside — outside
 * the repo, the disk answers), each versioned by its git blob sha. What else is
 * on disk is not in it.
 */
const viewOf = (root: string, files: Record<string, string>): RepoView =>
  repoViewOver(
    root,
    TREE,
    new Map(
      Object.entries(files)
        .filter(([f]) => !f.startsWith("node_modules/"))
        .map(([f, text]) => [f, gitBlobSha(Buffer.from(text), TREE)]),
    ),
  );

/** One run on the tree as it is now, beside a full check. */
async function run(
  root: string,
  files: Record<string, string>,
  store: NameStore,
  opts: {
    lint?: LintHook;
    extra?: ts.CompilerOptions;
    order?: "reverse";
    onMiss?: "throw" | "whole";
  } = {},
): Promise<NameRunOutput> {
  const options = optionsFor(root, opts.extra);
  let list = Object.keys(files)
    .filter((f) => !f.startsWith("node_modules/"))
    .sort();
  if (opts.order === "reverse") list = list.reverse();
  const view = viewOf(root, files);
  const out = await runNameCheck({
    view,
    options,
    roots: list,
    engine: "fixture",
    store,
    cache: createSourceFileCache(),
    ...(opts.lint ? { lint: opts.lint } : {}),
    onMiss: opts.onMiss ?? "throw",
  });
  const full = fullCheck(view, options, list);
  expect(compareResults(out.results, full.results)).toEqual([]);
  return out;
}

/** Run `trees` in order over one store; the files each run checked. */
async function walk(trees: Record<string, string>[]): Promise<string[][]> {
  const root = freshRoot();
  const store = memoryNameStore();
  let previous: Record<string, string> = {};
  const out: string[][] = [];
  for (const files of trees) {
    writeTree(root, files, previous);
    previous = files;
    out.push((await run(root, files, store)).checked);
  }
  return out;
}

// ─── 1. What moved, and nothing else ────────────────────────────────────────

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

test("a cold run checks everything; an unchanged tree checks nothing", async () => {
  const [cold, again] = await walk([CHAIN, CHAIN]);
  expect(cold).toEqual(Object.keys(CHAIN).sort());
  expect(again).toEqual([]);
});

test("a body edit checks the file alone, in program 1 — program 2 is empty", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  writeTree(root, CHAIN);
  await run(root, CHAIN, store);
  const edited = {
    ...CHAIN,
    "k.ts":
      'import type { G } from "./g";\nexport function k(): number { const v: G = { x: 2 }; return v.x + 1; }\n',
  };
  writeTree(root, edited, CHAIN);
  const out = await run(root, edited, store);
  expect(out.checked).toEqual(["k.ts"]);
  expect(out.report.p1?.checked).toBe(1);
  expect(out.report.p2).toBeNull();
});

test("an API change follows the names that use it, through contracts, and stops where nothing does", async () => {
  const [, api] = await walk([
    CHAIN,
    { ...CHAIN, "g.ts": "export interface G { x: number; y?: string }\n" },
  ]);
  // e and k use G; e's T names G, so d (inferred from make(): T) and f (uses
  // value, inferred through d) follow. h uses only k's `k(): number`, which
  // names nothing of g.
  expect(api).toEqual(["d.ts", "e.ts", "f.ts", "g.ts", "k.ts"]);
});

test("a type error introduced through two contracts is found in the importer", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  writeTree(root, CHAIN);
  await run(root, CHAIN, store);
  const broken = { ...CHAIN, "g.ts": "export interface G { x: string }\n" };
  writeTree(root, broken, CHAIN);
  const out = await run(root, broken, store);
  // f's `const n: number = value.x` is now a string: f is two contracts away.
  expect(
    out.results
      .get("f.ts")!
      .diagnostics.some((d) => d.startsWith("f.ts:2:") && d.includes("TS2322")),
  ).toBe(true);
});

const REEXPORT: Record<string, string> = {
  "a.ts": "export interface A { x: number }\nexport interface Other { o: 1 }\n",
  "b.ts": 'export { A } from "./a";\n',
  "c.ts": 'export * from "./b";\nexport const local = 1;\n',
  "u.ts": 'import type { A } from "./c";\nexport const v: A = { x: 1 };\n',
  "w.ts": 'import { local } from "./c";\nexport const z: number = local;\n',
  "o.ts":
    'import type { Other } from "./a";\nexport const o: Other = { o: 1 };\n',
};

test("a re-export chain: a type change reaches its user through two barrels, and only it", async () => {
  const [, edited] = await walk([
    REEXPORT,
    {
      ...REEXPORT,
      "a.ts":
        "export interface A { x: string }\nexport interface Other { o: 1 }\n",
    },
  ]);
  expect(edited).toEqual(["a.ts", "b.ts", "c.ts", "u.ts"]);
});

const STALE_READ: Record<string, string> = {
  "dep.ts": "export interface D { v: number }\n",
  "x.ts":
    'import type { D } from "./dep";\nexport type Stable = string;\nexport type Uses = D;\n',
  "y.ts": 'import type { Stable } from "./x";\nexport type Y = Stable;\n',
  "z.ts": 'import type { Y } from "./y";\nexport const z: Y = "a";\n',
};

test("a file that read a re-checked file's .d.ts in program 1 is re-checked; its users of names that stood are not", async () => {
  const [, edited] = await walk([
    STALE_READ,
    {
      ...STALE_READ,
      "dep.ts": "export interface D { v: string }\n",
      "y.ts":
        'import type { Stable } from "./x";\n// edited\nexport type Y = Stable;\n',
    },
  ]);
  // y (program 1) was served x's previous .d.ts while x's key moved: y joins
  // program 2. x's Stable names nothing that moved, so y's Y stands and z,
  // which uses only Y, keeps its result.
  expect(edited).toEqual(["dep.ts", "x.ts", "y.ts"]);
});

const INFERRED: Record<string, string> = {
  "f.ts": "export function foo() {\n  return 1;\n}\n",
  "g.ts": 'import { foo } from "./f";\nexport const x = foo();\n',
  "h.ts": 'import { x } from "./g";\nexport const y: number = x;\n',
};

test("an inferred export: its users are reached through an inference edge", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  writeTree(root, INFERRED);
  await run(root, INFERRED, store);
  const edited = {
    ...INFERRED,
    "f.ts": 'export function foo() {\n  return "s";\n}\n',
  };
  writeTree(root, edited, INFERRED);
  const out = await run(root, edited, store);
  // g's `x` has no written type: it moves with foo, and h with it.
  expect(out.checked).toEqual(["f.ts", "g.ts", "h.ts"]);
  expect(out.results.get("h.ts")!.diagnostics.length).toBe(1);
});

/**
 * `store` with every result's inference edges dropped: the prediction can no
 * longer see that `x = foo()` moves with `foo` — a miss, made on purpose.
 */
function blindStore(): NameStore {
  const store = memoryNameStore();
  return {
    ...store,
    readDetail: (r) => {
      const d = store.readDetail(r);
      return d === undefined ? undefined : { ...d, i: {} };
    },
  };
}

test("a missed prediction throws under onMiss: throw", async () => {
  const root = freshRoot();
  const store = blindStore();
  writeTree(root, INFERRED);
  await run(root, INFERRED, store);
  const edited = {
    ...INFERRED,
    "f.ts": 'export function foo() {\n  return "s";\n}\n',
  };
  writeTree(root, edited, INFERRED);
  let thrown: unknown;
  try {
    await run(root, edited, store);
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PredictionMissed);
  // g's x moved, and h — kept valid on a use of it — no longer has its
  // variant's key: the final self-check says so too.
  expect((thrown as PredictionMissed).missed).toEqual([
    { file: "g.ts", name: "x" },
    { file: "h.ts", name: "(result key)" },
  ]);
});

test("a missed prediction under onMiss: whole answers from one whole program, and says so", async () => {
  const root = freshRoot();
  const store = blindStore();
  writeTree(root, INFERRED);
  await run(root, INFERRED, store);
  const edited = {
    ...INFERRED,
    "f.ts": 'export function foo() {\n  return "s";\n}\n',
  };
  writeTree(root, edited, INFERRED);
  const linted: string[] = [];
  let discarded = 0;
  const lint: LintHook = {
    wants: (p) => p === "f.ts" || p === "h.ts",
    run(_program, files) {
      for (const { path } of files) linted.push(path);
      return Promise.resolve();
    },
    discard() {
      discarded++;
      linted.length = 0;
    },
  };
  // `run` compares with a full check: h's error (y: number = x, now a
  // string), which the missed prediction would have left out, is there.
  const out = await run(root, edited, store, { lint, onMiss: "whole" });
  expect(out.report.missed).toEqual([
    { file: "g.ts", name: "x" },
    { file: "h.ts", name: "(result key)" },
  ]);
  expect(out.checked).toEqual(["f.ts", "g.ts", "h.ts"]);
  expect(out.report.p2).toBeNull();
  expect(out.results.get("h.ts")!.diagnostics.length).toBe(1);
  // What the abandoned attempt linted was discarded, and linted again.
  expect(discarded).toBe(1);
  expect(linted.sort()).toEqual(["f.ts", "h.ts"]);
  // The store was rewritten: the next run on the same tree checks nothing.
  const again = await run(root, edited, store);
  expect(again.checked).toEqual([]);
});

const WRITTEN: Record<string, string> = {
  "r.ts": "export interface R { a: number }\n",
  "s.ts":
    'import type { R } from "./r";\nexport function f(r: R): number {\n  return 0;\n}\n',
  "t.ts": 'import { f } from "./s";\nexport const n: number = f({ a: 1 });\n',
};

test("a written type naming an outside type: its text does not move, its users do", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  writeTree(root, WRITTEN);
  await run(root, WRITTEN, store);
  const edited = { ...WRITTEN, "r.ts": "export interface R { a: string }\n" };
  writeTree(root, edited, WRITTEN);
  const out = await run(root, edited, store);
  expect(out.checked).toEqual(["r.ts", "s.ts", "t.ts"]);
  expect(out.results.get("t.ts")!.diagnostics.length).toBe(1);
});

test("a name a barrel brings through a star appears: its user, an error before, is re-checked", async () => {
  const files = {
    "a.ts": "export const one = 1;\n",
    "barrel.ts": 'export * from "./a";\n',
    "use.ts": 'import { two } from "./barrel";\nexport const t = two;\n',
    "other.ts":
      'import { one } from "./barrel";\nexport const o: number = one;\n',
  };
  const [, added] = await walk([
    files,
    { ...files, "a.ts": "export const one = 1;\nexport const two = 2;\n" },
  ]);
  expect(added).toContain("use.ts");
  expect(added).not.toContain("other.ts");
});

// ─── 2. Cycles and globals ──────────────────────────────────────────────────

test("inside an import cycle, a body edit checks the file alone, an API change what uses it", async () => {
  const cycle = {
    "p.ts":
      'import { q } from "./q";\nexport const p = (): number => q() + 1;\n',
    "q.ts":
      'import { p } from "./p";\nexport const q = (): number => 1;\nexport const pp = p;\n',
    "r.ts": 'import { q } from "./q";\nexport const r = q();\n',
  };
  const [, body] = await walk([
    cycle,
    {
      ...cycle,
      "p.ts":
        'import { q } from "./q";\nexport const p = (): number => q() + 2;\n',
    },
  ]);
  expect(body).toEqual(["p.ts"]);
  const [, , api] = await walk([
    cycle,
    cycle,
    {
      ...cycle,
      "p.ts":
        'import { q } from "./q";\nexport const p = (): string => String(q());\n',
    },
  ]);
  // q re-exports p as `pp` (it uses p's name); r uses only q's `q`.
  expect(api).toEqual(["p.ts", "q.ts"]);
});

test("an augmentation is global: its edit checks everything, in one program", async () => {
  const files = {
    ...CHAIN,
    "aug.ts":
      'declare module "./g" { interface G { z?: boolean } }\nexport {};\n',
  };
  const root = freshRoot();
  const store = memoryNameStore();
  writeTree(root, files);
  await run(root, files, store);
  const edited = {
    ...files,
    "aug.ts":
      'declare module "./g" { interface G { z?: string } }\nexport {};\n',
  };
  writeTree(root, edited, files);
  const out = await run(root, edited, store);
  expect(out.checked).toEqual(Object.keys(files).sort());
  expect(out.report.p2).toBeNull();
});

// A repo `.d.ts` is global only when every file can see it (`declScope`).

const AMBIENT: Record<string, string> = {
  ...CHAIN,
  "virt.d.ts": 'declare module "virt:*" {\n  export const v: number;\n}\n',
  "use-virt.ts": 'import { v } from "virt:x";\nexport const w: number = v;\n',
  "side.d.ts": "export declare const s: number;\n",
  "use-side.ts": 'import { s } from "./side";\nexport const t: number = s;\n',
};

test("an ambient-module .d.ts edit checks the files whose specifiers it matches", async () => {
  const [, edited] = await walk([
    AMBIENT,
    {
      ...AMBIENT,
      "virt.d.ts": 'declare module "virt:*" {\n  export const v: string;\n}\n',
    },
  ]);
  expect(edited).toEqual(["use-virt.ts"]);
});

test("an ambient module declared where an import did not resolve checks that importer", async () => {
  const { "virt.d.ts": _, ...without } = AMBIENT;
  const [, added] = await walk([without, AMBIENT]);
  expect(added).toEqual(["use-virt.ts"]);
});

test("a module .d.ts edit checks its importers", async () => {
  const [, edited] = await walk([
    AMBIENT,
    { ...AMBIENT, "side.d.ts": "export declare const s: string;\n" },
  ]);
  expect(edited).toEqual(["use-side.ts"]);
});

test("a global .d.ts edit checks everything", async () => {
  const files = { ...AMBIENT, "env.d.ts": "declare const ENV: number;\n" };
  const [, edited] = await walk([
    files,
    { ...files, "env.d.ts": "declare const ENV: string;\n" },
  ]);
  expect(edited).toEqual(
    Object.keys(files)
      .filter((f) => !f.endsWith(".d.ts") || f === "d.ts")
      .sort(),
  );
});

// ─── 3. Resolutions ─────────────────────────────────────────────────────────

test("an added file that shadows a resolution re-checks its importers", async () => {
  const files = {
    "lib/index.ts": "export const v: number = 1;\n",
    "use.ts": 'import { v } from "./lib";\nexport const w: number = v;\n',
  };
  const [, shadowed] = await walk([
    files,
    { ...files, "lib.ts": 'export const v: string = "s";\n' },
  ]);
  expect(shadowed).toEqual(["lib.ts", "use.ts"]);
});

test("a file added beside a directory index moves the key", async () => {
  // `pkg/index.ts` is what `./pkg` resolves to; a `pkg.ts` added to the tree
  // beside it — untracked-not-ignored and in the tree, or a gitignored root in
  // the overlay — shadows it. `use.ts` is unchanged; its resolution key moves.
  const root = freshRoot();
  const store = memoryNameStore();
  const files = {
    "pkg/index.ts": "export const v: number = 1;\n",
    "use.ts": 'import { v } from "./pkg";\nexport const w: number = v;\n',
  };
  writeTree(root, files);
  await run(root, files, store);
  const shadowed = { ...files, "pkg.ts": 'export const v: string = "s";\n' };
  writeTree(root, shadowed, files);
  const out = await run(root, shadowed, store);
  expect(out.report.moved).toBe(1);
  expect(out.checked).toEqual(["pkg.ts", "use.ts"]);
  expect(out.results.get("use.ts")!.diagnostics.join("\n")).toContain("TS2322");
});

test("a file on disk and not in the tree moves no key, and shadows nothing", async () => {
  // A transient root entry (`.install.lock`), and a `pkg.ts` that would shadow
  // `pkg/index.ts` were it in the tree: neither is, so no listing a key hashes
  // moves, and the program does not see the shadow either.
  const root = freshRoot();
  const store = memoryNameStore();
  const files = {
    "pkg/index.ts": "export const v: number = 1;\n",
    "use.ts": 'import { v } from "./pkg";\nexport const w: number = v;\n',
  };
  writeTree(root, files);
  await run(root, files, store);
  writeTree(root, {
    ...files,
    ".install.lock": "",
    "pkg.ts": 'export const v: string = "s";\n',
  });
  const out = await run(root, files, store);
  expect(out.report.moved).toBe(0);
  expect(out.report.refreshed).toBe(0);
  expect(out.checked).toEqual([]);
  expect(out.results.get("use.ts")!.diagnostics).toEqual([]);
});

test("a version is the file's git blob sha", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  const files = { "lone.ts": "export const lone = 1;\n" };
  writeTree(root, files);
  await run(root, files, store);
  // `git hash-object` of the text: what the tree names the file by.
  const blob = gitBlobSha(Buffer.from(files["lone.ts"]), TREE);
  expect(blob).toBe("265a6ce1381f8313268c20ba641ee0959a070a99");
  expect(
    [...store.entries.keys()].some((k) => k.endsWith(`\0lone.ts\0${blob}`)),
  ).toBe(true);
});

test("a file whose bytes changed after the tree was taken fails the run", async () => {
  const root = freshRoot();
  const files = { "lone.ts": "export const lone = 1;\n" };
  writeTree(root, { "lone.ts": "export const lone = 2;\n" });
  let thrown: unknown;
  try {
    await runNameCheck({
      view: viewOf(root, files),
      options: optionsFor(root),
      roots: ["lone.ts"],
      engine: "fixture",
      store: memoryNameStore(),
      cache: createSourceFileCache(),
      onMiss: "throw",
    });
  } catch (err) {
    thrown = err;
  }
  expect(String(thrown)).toContain(
    "changed on disk after the check took its tree",
  );
});

test("a probed directory that starts to exist moves the key", async () => {
  // `./later/thing` probes `later/`, which does not exist: the key holds the
  // listing of its nearest existing ancestor, which creating it changes.
  const files = {
    "use.ts": 'import { v } from "./later/thing";\nexport const w = v;\n',
  };
  const [cold, resolved] = await walk([
    files,
    { ...files, "later/thing.ts": "export const v = 1;\n" },
  ]);
  expect(cold).toEqual(["use.ts"]);
  expect(resolved).toEqual(["later/thing.ts", "use.ts"]);
});

test("an unresolved import that starts resolving re-checks its importer", async () => {
  const files = {
    "use.ts": 'import { v } from "./later";\nexport const w = v;\n',
  };
  const [cold, resolved] = await walk([
    files,
    { ...files, "later.ts": "export const v = 1;\n" },
  ]);
  expect(cold).toEqual(["use.ts"]);
  expect(resolved).toEqual(["later.ts", "use.ts"]);
});

// ─── 4. Stores and order ────────────────────────────────────────────────────

test("a store warmed on another tree gives the full check's answers", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  const other = {
    ...CHAIN,
    "g.ts": "export interface G { x: number; w: number }\n",
    "e.ts":
      'import type { G } from "./g";\nexport type T = G;\nexport const make = (): T => ({ x: 1, w: 2 });\n',
  };
  writeTree(root, other);
  await run(root, other, store);
  writeTree(root, CHAIN, other);
  const out = await run(root, CHAIN, store);
  // Same text, different declarations behind it: g and e moved back, and so
  // did what uses them.
  expect(out.checked).toEqual(["d.ts", "e.ts", "f.ts", "g.ts", "k.ts"]);
  // And a third tree back on `other`: every entry is already there.
  writeTree(root, other, CHAIN);
  expect((await run(root, other, store)).checked).toEqual([]);
});

test("root order does not move a key", async () => {
  const root = freshRoot();
  const files = {
    "first.ts": 'export const first = "qqalpha" as const;\n',
    "pick.ts":
      'export const pick = (n: number) => (n > 0 ? "qqzeta" : "qqalpha");\n',
    "use.ts": 'import { pick } from "./pick";\nexport const use = pick;\n',
  };
  writeTree(root, files);
  const a = await run(root, files, memoryNameStore());
  const b = await run(root, files, memoryNameStore(), { order: "reverse" });
  expect(Object.fromEntries(b.keys)).toEqual(Object.fromEntries(a.keys));
});

// ─── 5. Typed lint ──────────────────────────────────────────────────────────

test("typed lint runs in the program holding the file; a valid file with a stale part joins program 2", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  writeTree(root, CHAIN);
  await run(root, CHAIN, store);
  const edited = {
    ...CHAIN,
    "k.ts":
      'import type { G } from "./g";\nexport function k(): number { const v: G = { x: 3 }; return v.x; }\n',
  };
  writeTree(root, edited, CHAIN);
  const linted: { path: string; source: boolean }[] = [];
  const lint: LintHook = {
    // k (re-checked) and lone (valid, its typed part evicted).
    wants: (p) => p === "k.ts" || p === "lone.ts",
    run(program, files) {
      for (const { path } of files) {
        const sf = program.getSourceFile(join(root, path));
        linted.push({
          path,
          source: sf !== undefined && !sf.isDeclarationFile,
        });
      }
      return Promise.resolve();
    },
    discard() {
      linted.length = 0;
    },
  };
  const out = await run(root, edited, store, { lint });
  expect(linted.sort((x, y) => (x.path < y.path ? -1 : 1))).toEqual([
    { path: "k.ts", source: true },
    { path: "lone.ts", source: true },
  ]);
  expect(out.checked).toEqual(["k.ts"]);
  expect(out.report.lintOnly).toBe(1);
  expect(out.report.p2?.checked).toBe(0);
});

test("a repo .d.ts has a typed key, and is linted in a program even when nothing is checked", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  const files = {
    ...CHAIN,
    "env.d.ts":
      'import type { G } from "./g";\ndeclare module "virtual:env" { export const g: G; }\n',
  };
  writeTree(root, files);
  const first = await run(root, files, store);
  expect(first.keys.get("env.d.ts")).toBeDefined();
  const linted: { path: string; declaration: boolean }[] = [];
  const lint: LintHook = {
    wants: (p) => p === "env.d.ts",
    run(program, list) {
      for (const { path } of list) {
        const sf = program.getSourceFile(join(root, path));
        linted.push({ path, declaration: sf?.isDeclarationFile === true });
      }
      return Promise.resolve();
    },
    discard() {
      linted.length = 0;
    },
  };
  const out = await run(root, files, store, { lint });
  expect(out.checked).toEqual([]);
  expect(linted).toEqual([{ path: "env.d.ts", declaration: true }]);
  expect(out.keys.get("env.d.ts")).toBe(first.keys.get("env.d.ts"));
  // What it imports moves: so does its key.
  const edited = { ...files, "g.ts": "export interface G { x: string }\n" };
  writeTree(root, edited, files);
  const moved = await run(root, edited, store);
  expect(moved.keys.get("env.d.ts")).not.toBe(first.keys.get("env.d.ts"));
});

// ─── 6. The pieces ──────────────────────────────────────────────────────────

test("contractNames: per-name text, name-use edges, aliases, stars", () => {
  const dts = [
    'import { R } from "./r";',
    'export { A } from "./a";',
    'export * from "./b";',
    "interface Local { r: R }",
    "export declare function f(l: Local): Out;",
    "export interface Out { n: number }",
    'declare const _default: { x: import("./e").T };',
    "export default _default;",
  ].join("\n");
  const c = contractNames(dts, "self.ts", (spec) => `${spec.slice(2)}.ts`);
  expect(Object.keys(c.names).sort()).toEqual(["A", "Out", "default", "f"]);
  expect(c.names.A!.d).toEqual([nameKey("a.ts", "A")]);
  // `f` inlines the non-exported `Local`, edges to `R` through it, and to
  // `Out` as another export of the same file.
  expect(c.names.f!.d).toEqual([
    nameKey("r.ts", "R"),
    nameKey("self.ts", "Out"),
  ]);
  expect(c.names.default!.d).toEqual([nameKey("e.ts", "T")]);
  expect(c.star).toEqual(["b.ts"]);
  expect(c.specifiers).toEqual(["./a", "./b", "./e", "./r"]);
});

test("a signature ignores the order of a type literal's properties and a union's members, never of overloads", () => {
  const a =
    'declare const d: ({\n    rule: "x";\n    task?: undefined;\n} | {\n    rule: "y";\n    task: string;\n})[];\n';
  const b =
    'declare const d: ({\n    task?: undefined;\n    rule: "x";\n} | {\n    rule: "y";\n    task: string;\n})[];\n';
  expect(canonicalDeclarations(a)).toBe(canonicalDeclarations(b));
  const f =
    "declare const o: {\n    f(x: string): 1;\n    f(x: number): 2;\n};\n";
  const g =
    "declare const o: {\n    f(x: number): 2;\n    f(x: string): 1;\n};\n";
  expect(canonicalDeclarations(f)).not.toBe(canonicalDeclarations(g));
});

test("a type named through an import binding reads as the import type it names, whichever way emit spelled it", () => {
  // Declaration emit copies `import("s").Rank` from a served `.d.ts`, and
  // prints `Rank` through the local binding when it infers from source.
  const viaBinding =
    'import { Rank } from "s";\nimport * as NS from "n";\nimport D from "d";\nexport declare const r: {\n    rank: Rank;\n    n: NS.Inner.T<Rank>;\n    d: typeof D;\n};\n';
  const viaImportType =
    'export declare const r: {\n    rank: import("s").Rank;\n    n: import("n").Inner.T<import("s").Rank>;\n    d: typeof import("d").default;\n};\n';
  expect(canonicalDeclarations(viaBinding)).toBe(
    canonicalDeclarations(viaImportType),
  );
  // A binding still referenced (a heritage clause, a re-export) keeps its
  // import; a type parameter of the same name is not the binding.
  const kept =
    'import { Base } from "b";\nexport declare class C extends Base {\n}\nexport { Base };\n';
  expect(canonicalDeclarations(kept)).toContain('import { Base } from "b";');
  const shadow =
    'import { T } from "t";\nexport declare function f<T>(x: T): T;\nexport declare const t: T;\n';
  expect(canonicalDeclarations(shadow)).toContain("x: T");
});

test("the typed result key depends on both the rules and the result key", () => {
  const k = typedResultKey("rules", "result");
  expect(k).toHaveLength(16);
  expect(typedResultKey("rules2", "result")).not.toBe(k);
  expect(typedResultKey("rules", "result2")).not.toBe(k);
});

test("components are found iteratively, far deeper than the call stack", () => {
  const n = 50_000;
  const order: number[] = [];
  forEachComponent(
    Array.from({ length: n }, (_, i) => i),
    (v) => (v > 0 ? [v - 1] : []),
    (members) => order.push(members[0]!),
  );
  expect(order.length).toBe(n);
  expect(order[0]).toBe(0);
});
