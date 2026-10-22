/**
 * The incremental walk (`./walk-incremental.ts`, `./walk-base.ts`): over a
 * series of fixture trees, each run walks from the base the previous run
 * wrote, and is compared with a FULL walk of the same tree over the same
 * store (its writes kept apart) and with a fresh whole program:
 *
 *   - every file's result key, `.d.ts` hash, signature and diagnostics equal
 *     the full walk's, and the diagnostics and signatures the full check's;
 *   - the base the incremental run writes holds the same per-file state and
 *     the same reverse indexes as one written from the full walk, and its
 *     ranks put every file above what it reads;
 *   - what it walks follows the change: nothing on an unchanged tree, the
 *     file on a body edit, the users of what moved on an API edit.
 *
 * Cases: star re-export dependents, a cycle created by an added edge and
 * broken again, a fixed file whose stored `.d.ts` aged out, a `global` flip,
 * added and removed files, a resolution moved by a file added in a probed
 * directory, and a run that throws writing no base.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
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
import { createSourceFileCache } from "./name-host";
import { splitKey } from "./name-records";
import { runNameCheck, type NameRunOutput } from "./name-run";
import {
  bufferedNameStore,
  memoryNameStore,
  type NameStore,
} from "./name-store";
import { gitBlobSha, repoViewOver, type RepoView } from "./repo-view";
import {
  openWalkBase,
  openWalkBaseStore,
  writeWalkBase,
  type OpenedWalkBase,
  type WalkBaseStore,
  type WalkFileState,
  type WalkShard,
} from "./walk-base";

setDefaultTimeout(120_000);

const dirs: string[] = [];
const priorDataRoot = process.env.SINGULARITY_DIR;
beforeAll(() => {
  const d = mkdtempSync(join(tmpdir(), "walk-incremental-data-"));
  dirs.push(d);
  process.env.SINGULARITY_DIR = d;
});
afterAll(() => {
  if (priorDataRoot === undefined) delete process.env.SINGULARITY_DIR;
  else process.env.SINGULARITY_DIR = priorDataRoot;
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const freshRoot = (): string => {
  const r = realpathSync(mkdtempSync(join(tmpdir(), "walk-incremental-")));
  dirs.push(r);
  return r;
};

const optionsFor = (root: string) =>
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
    },
    root,
  );

function writeTree(
  root: string,
  files: Record<string, string>,
  previous: Record<string, string>,
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

let treeCount = 0;
/** A fresh fake tree hash per tree (SHA-1 length: blob shas are SHA-1). */
const nextTree = (): string => (++treeCount).toString(16).padStart(40, "0");

const viewOf = (
  root: string,
  files: Record<string, string>,
  tree: string,
): RepoView =>
  repoViewOver(
    root,
    tree,
    new Map(
      Object.entries(files).map(([f, text]) => [
        f,
        gitBlobSha(Buffer.from(text), tree),
      ]),
    ),
  );

/** A base's every shard, read. */
function shardsOf(store: WalkBaseStore, hash: string): WalkShard[] {
  const root = store.root(hash)!;
  return Object.values(root.shards).map(([h]) => store.shard(h)!);
}

/** A base's state with ranks and component ids left out (they are placements, not facts). */
function facts(store: WalkBaseStore, hash: string) {
  const files: Record<string, unknown> = {};
  const ir: Record<string, unknown> = {};
  const id: Record<string, unknown> = {};
  const fi: Record<string, unknown> = {};
  const p: Record<string, unknown> = {};
  const comps: Record<string, string> = {};
  for (const s of shardsOf(store, hash)) {
    for (const [path, f] of Object.entries(s.f)) {
      const { o: _o, m, w: _w, ...rest } = f;
      files[path] = rest;
      comps[path] = m ?? path;
    }
    Object.assign(ir, s.ir);
    Object.assign(id, s.id);
    Object.assign(fi, s.if);
    Object.assign(p, s.p);
  }
  return { files, ir, id, if: fi, p, comps };
}

/** Every file ranks above every source it reads outside its component. */
function expectRanked(store: WalkBaseStore, hash: string, step: string): void {
  const all = new Map<string, WalkFileState>();
  for (const s of shardsOf(store, hash)) {
    for (const [path, f] of Object.entries(s.f)) all.set(path, f);
  }
  for (const [path, f] of all) {
    for (const k of [...f.u, ...(f.k ?? [])]) {
      const o = splitKey(k)[0];
      const t = all.get(o);
      if (t === undefined || o === path) continue;
      if ((t.m ?? o) === (f.m ?? path)) {
        expect(t.o, `${step}: ${path} and ${o} share a component`).toBe(f.o);
      } else {
        expect(t.o < f.o, `${step}: ${path} (${f.o}) reads ${o} (${t.o})`).toBe(
          true,
        );
      }
    }
  }
}

interface Step {
  inc: NameRunOutput;
  full: NameRunOutput;
}

/**
 * Run `trees` in order: each step incrementally from the last base, beside a
 * full walk and a full check. `between(i, store)` runs before step i.
 */
async function series(
  trees: Record<string, string>[],
  between: (
    i: number,
    store: ReturnType<typeof memoryNameStore>,
  ) => void = () => {},
): Promise<Step[]> {
  const root = freshRoot();
  const store = memoryNameStore();
  const wstore = openWalkBaseStore();
  let base: OpenedWalkBase = { kind: "none", reason: "first run" };
  let previous: Record<string, string> = {};
  const out: Step[] = [];
  for (const [i, files] of trees.entries()) {
    between(i, store);
    writeTree(root, files, previous);
    previous = files;
    const tree = nextTree();
    const view = viewOf(root, files, tree);
    const options = optionsFor(root);
    const list = Object.keys(files).sort();
    const common = {
      view,
      options,
      roots: list,
      engine: "fixture",
      onMiss: "throw" as const,
    };
    const full = await runNameCheck({
      ...common,
      store: bufferedNameStore(store),
      cache: createSourceFileCache(),
      base: { kind: "none", reason: "oracle" },
    });
    const inc = await runNameCheck({
      ...common,
      store,
      cache: createSourceFileCache(),
      base,
    });
    const step = `step ${i}`;
    // Every file: the incremental walk's result equals the full walk's…
    expect(Object.fromEntries(inc.walk.all()), step).toEqual(
      Object.fromEntries(full.walk.all()),
    );
    // …and the full check's.
    const check = fullCheck(view, options, list);
    const results = new Map(
      [...inc.walk.all()].map(([p, f]) => [
        p,
        { diagnostics: f.diagnostics, signature: f.signature },
      ]),
    );
    expect(compareResults(results, check.results), step).toEqual([]);
    // The base it writes holds the full walk's facts.
    const write = (o: NameRunOutput, t: string) =>
      writeWalkBase({
        store: wstore,
        treeHash: t,
        checkout: root,
        global: o.walk.global,
        globals: o.walk.globals,
        listings: o.walk.listings,
        view,
        base: o.walk.base,
        files: o.walk.files,
        removed: o.walk.removed,
        meaning: o.walk.meaning,
        touch: (p, f) => store.touch(p, f.v, f.c, f.r),
      });
    const fullBase = write(full, `full-${tree}`);
    const incBase = write(inc, tree);
    const a = facts(wstore, incBase.hash);
    const b = facts(wstore, fullBase.hash);
    expect(a.files, step).toEqual(b.files);
    expect(a.ir, step).toEqual(b.ir);
    expect(a.id, step).toEqual(b.id);
    expect(a.if, step).toEqual(b.if);
    expect(a.p, step).toEqual(b.p);
    expect(a.comps, step).toEqual(b.comps);
    expectRanked(wstore, incBase.hash, step);
    base = openWalkBase(wstore, incBase.hash, `step ${i}`);
    out.push({ inc, full });
  }
  return out;
}

const walked = (s: Step): number => s.inc.report.walk.d;

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

test("unchanged walks nothing; a body edit walks the file; an API edit its users; a revert reuses", async () => {
  const steps = await series([
    CHAIN,
    CHAIN,
    {
      ...CHAIN,
      "k.ts":
        'import type { G } from "./g";\nexport function k(): number { const v: G = { x: 2 }; return v.x + 1; }\n',
    },
    { ...CHAIN, "g.ts": "export interface G { x: number; y?: string }\n" },
    CHAIN,
  ]);
  expect(steps[0]!.inc.report.walk.mode).toContain("full");
  expect(steps[1]!.inc.report.walk.mode).toContain("incremental");
  expect(walked(steps[1]!)).toBe(0);
  expect(steps[1]!.inc.checked).toEqual([]);
  expect(steps[2]!.inc.checked).toEqual(["k.ts"]);
  expect(walked(steps[2]!)).toBe(1);
  expect(steps[3]!.inc.checked).toEqual(steps[3]!.full.checked);
  expect(walked(steps[3]!)).toBeLessThan(Object.keys(CHAIN).length);
  expect(steps[3]!.inc.report.walk.entries).toBeLessThan(
    Object.keys(CHAIN).length,
  );
  // Back: every text has a valid variant.
  expect(steps[4]!.inc.checked).toEqual([]);
});

test("a name a barrel brings through a star: its users follow it", async () => {
  const files = {
    "a.ts": "export const one = 1;\n",
    "barrel.ts": 'export * from "./a";\n',
    "top.ts": 'export * from "./barrel";\n',
    "use.ts": 'import { two } from "./top";\nexport const t = two;\n',
    "ns.ts": 'import * as all from "./top";\nexport const k = all;\n',
    "other.ts": 'import { one } from "./top";\nexport const o: number = one;\n',
  };
  const steps = await series([
    files,
    { ...files, "a.ts": "export const one = 1;\nexport const two = 2;\n" },
    { ...files, "a.ts": 'export const one = "s";\nexport const two = 2;\n' },
  ]);
  expect(steps[1]!.inc.checked).toContain("use.ts");
  expect(steps[1]!.inc.checked).toContain("ns.ts");
  expect(steps[1]!.inc.checked).not.toContain("other.ts");
  expect(steps[2]!.inc.checked).toContain("other.ts");
});

test("an edge up past a fixed reader walks that reader too, not every file", async () => {
  const files = {
    "t1.ts": "export const t1 = 1;\n",
    "t2.ts": 'import { t1 } from "./t1";\nexport const t2 = t1;\n',
    "t3.ts": 'import { t2 } from "./t2";\nexport const t3 = t2;\n',
    "a.ts": "export const a = 1;\n",
    "r.ts": 'import { a } from "./a";\nexport const r: number = a;\n',
  };
  const steps = await series([
    files,
    // a, below r, now reads t3, ranked above r.
    {
      ...files,
      "a.ts":
        'import { t3 } from "./t3";\nexport const a = 1;\nexport const at = t3;\n',
    },
  ]);
  expect(steps[1]!.inc.report.walk.mode).toContain("incremental");
  expect(steps[1]!.inc.report.walk.d).toBe(2);
  expect(steps[1]!.inc.checked).toEqual(["a.ts"]);
});

test("a cycle created by an added edge, and broken again", async () => {
  const files = {
    "p.ts": "export const p = (): number => 1;\n",
    "q.ts": 'import { p } from "./p";\nexport const q = (): number => p();\n',
    "r.ts": 'import { q } from "./q";\nexport const r = q();\n',
    "s.ts": 'import { r } from "./r";\nexport const s: number = r;\n',
  };
  const cyc = await series([
    files,
    // p now reads s: p → s → r → q → p.
    {
      ...files,
      "p.ts":
        'import { s } from "./s";\nexport const p = (): number => 1;\nexport const ps = (): number => s;\n',
    },
    files,
  ]);
  // Closing and opening the cycle stays incremental: its readers are walked.
  expect(cyc[1]!.inc.report.walk.mode).toContain("incremental");
  expect(cyc[2]!.inc.report.walk.mode).toContain("incremental");
});

test("a program-1 file that read a stale .d.ts through a fixed file is re-checked", async () => {
  const files = {
    "dep.ts": "export interface D { v: number }\n",
    "x.ts":
      'import type { D } from "./dep";\nexport type Stable = string;\nexport type Uses = D;\n',
    "mid.ts": 'import type { Stable } from "./x";\nexport type M = Stable;\n',
    "y.ts": 'import type { M } from "./mid";\nexport type Y = M;\n',
    "z.ts": 'import type { Y } from "./y";\nexport const z: Y = "a";\n',
  };
  const steps = await series([
    files,
    {
      ...files,
      "dep.ts": "export interface D { v: string }\n",
      "y.ts":
        'import type { M } from "./mid";\n// edited\nexport type Y = M;\n',
    },
  ]);
  // y (program 1) reached x's previous .d.ts through mid, which stays fixed.
  expect(steps[1]!.inc.checked).toEqual(steps[1]!.full.checked);
  expect(steps[1]!.inc.checked).toContain("y.ts");
  expect(steps[1]!.inc.report.walk.mode).toContain("incremental");
});

test("a fixed file whose stored .d.ts aged out is re-checked, not trusted", async () => {
  const steps = await series(
    [
      CHAIN,
      {
        ...CHAIN,
        "f.ts":
          'import { value } from "./d";\nexport const n: number = value.x + 1;\n',
      },
    ],
    (i, store) => {
      // Before step 1: d.ts — fixed, and served to f's program — loses its
      // stored `.d.ts`.
      if (i !== 1) return;
      for (const [h, text] of store.contracts) {
        if (text.includes("value")) store.contracts.delete(h);
      }
    },
  );
  expect(steps[1]!.inc.checked).toContain("d.ts");
  expect(steps[1]!.inc.checked).toContain("f.ts");
});

test("a global flip walks every file", async () => {
  const withAug = {
    ...CHAIN,
    "aug.ts":
      'declare module "./g" { interface G { z?: boolean } }\nexport {};\n',
  };
  const steps = await series([CHAIN, withAug, CHAIN]);
  expect(steps[1]!.inc.report.walk.mode).toContain("global hash");
  expect(steps[2]!.inc.report.walk.mode).toContain("global hash");
});

test("an ambient module declared walks every file; its edit walks from the base", async () => {
  const ambient = {
    ...CHAIN,
    "virt.d.ts": 'declare module "virt:*" {\n  export const v: number;\n}\n',
    "use-virt.ts": 'import { v } from "virt:x";\nexport const w: number = v;\n',
  };
  const edited = {
    ...ambient,
    "virt.d.ts": 'declare module "virt:*" {\n  export const v: string;\n}\n',
  };
  const steps = await series([
    { ...CHAIN, "use-virt.ts": ambient["use-virt.ts"]! },
    ambient,
    edited,
  ]);
  // A new ambient name changes which files use the `.d.ts`: every file walks.
  expect(steps[1]!.inc.report.walk.mode).toContain("ambient module names");
  expect(steps[1]!.inc.checked).toEqual(["use-virt.ts"]);
  // An edit moves only its readers' keys: incremental, the one importer.
  expect(steps[2]!.inc.report.walk.mode).toContain("incremental");
  expect(steps[2]!.inc.checked).toEqual(["use-virt.ts"]);
});

test("added and removed files", async () => {
  const files = {
    "a.ts": "export const a = 1;\n",
    "b.ts": 'import { a } from "./a";\nexport const b = a;\n',
    "c.ts": "export const c = 1;\n",
  };
  const steps = await series([
    files,
    {
      "a.ts": files["a.ts"],
      "b.ts": files["b.ts"],
      "n/new.ts": "export const x = 1;\n",
    },
    {
      "a.ts": files["a.ts"],
      "b.ts": 'import { x } from "./n/new";\nexport const b = x;\n',
      "n/new.ts": "export const x = 1;\n",
    },
    { "b.ts": "export const b = 1;\n", "n/new.ts": "export const x = 1;\n" },
  ]);
  expect(steps[1]!.inc.checked).toEqual(["n/new.ts"]);
});

test("a file added in a probed directory moves a resolution", async () => {
  const files = {
    "pkg/index.ts": "export const v: number = 1;\n",
    "use.ts": 'import { v } from "./pkg";\nexport const w: number = v;\n',
    "far.ts": "export const far = 1;\n",
  };
  const steps = await series([
    files,
    { ...files, "pkg.ts": 'export const v: string = "s";\n' },
    files,
  ]);
  expect(steps[1]!.inc.checked).toEqual(["pkg.ts", "use.ts"]);
  expect(steps[1]!.inc.report.moved).toBe(1);
  expect(steps[1]!.inc.checked).not.toContain("far.ts");
});

test("a run that throws writes no base: the next run walks from the last one", async () => {
  const root = freshRoot();
  const store = memoryNameStore();
  const wstore = openWalkBaseStore();
  const tree = nextTree();
  const files = { "lone.ts": "export const lone = 1;\n" };
  writeTree(root, { "lone.ts": "export const lone = 2;\n" }, {});
  let thrown: unknown;
  try {
    // The worker writes the base only from a run that returned.
    await runNameCheck({
      view: viewOf(root, files, tree),
      options: optionsFor(root),
      roots: ["lone.ts"],
      engine: "fixture",
      store: store satisfies NameStore,
      cache: createSourceFileCache(),
      onMiss: "throw",
      base: { kind: "none", reason: "first" },
    });
  } catch (err) {
    thrown = err;
  }
  expect(String(thrown)).toContain("changed on disk");
  expect(wstore.pointer(tree)).toBeUndefined();
});
