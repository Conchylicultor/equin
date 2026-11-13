/**
 * A lint rule group's members are its import closure, walked from its root
 * over the check's view of the tree (`../shared/repo-view.ts`) — no whole-repo
 * graph, no disk probes. Its edges are the plugin-records module graph's
 * (`fileSetBindings`), so:
 *   1. relative and `@plugins/` imports resolve as the graph resolves them; a
 *      bare package is no edge, and a missing target throws;
 *   2. a generated registry is never entered, and a `stop` file (the engine,
 *      for a contribution) is not descended into;
 *   3. a non-lintable member (`prototypes/`) is a member, not a way through;
 *   4. a file the tree does not hold does not exist, though it is on disk.
 * And: each file on a walk is parsed once, however many closures reach it; a
 * type-only import is no edge (erased before a rule runs); and the real
 * engine's closure holds no process plumbing.
 */

import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import {
  blobSourceOf,
  gitBlobSha,
  repoViewOver,
  type RepoView,
} from "../shared/repo-view";
import {
  LINT_DATA_FILES,
  LINT_CONFIG_SOURCE,
} from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { readTreeSnapshot } from "@plugins/framework/plugins/tooling/plugins/checks/core";
import { viewOfSnapshot } from "../shared/repo-view";
import {
  codeCheckoutRoot,
  computeLintGroups,
  lintClosures,
  lintEngineRoots,
  lintWorkerModules,
} from "./lint-groups";

const TREE = "0".repeat(40);

/**
 * The plugin-records modules whose code keys the module graph's file facts
 * and the bindings scan: every view the graph reads holds them (from this
 * checkout), as a checked tree does.
 */
const RECORD_SCANNERS: Record<string, string> = Object.fromEntries(
  [
    "plugins/plugin-meta/plugins/plugin-records/core/internal/scan-imports.ts",
    "plugins/plugin-meta/plugins/plugin-records/plugins/bindings/core/bindings.scan.ts",
    ...[
      "index",
      "endpoint-exports",
      "find-imports",
      "find-marker-calls",
      "helpers",
      "host-services",
      "mask-source",
      "server-contribution-kinds",
      "snapshot-scope",
    ].map((f) => `plugins/plugin-meta/plugins/parse-utils/core/${f}.ts`),
  ].map((rel) => [rel, readFileSync(join(codeCheckoutRoot(), rel), "utf8")]),
);
const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** `files` on disk, and a view holding `files` alone (`offTree` only on disk). */
function viewOf(
  files: Record<string, string>,
  offTree: Record<string, string> = {},
): RepoView {
  const root = mkdtempSync(join(tmpdir(), "lint-groups-"));
  roots.push(root);
  const blobs = new Map<string, string>();
  const tree = { ...RECORD_SCANNERS, ...files };
  for (const [rel, text] of Object.entries({ ...tree, ...offTree })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    if (rel in tree) blobs.set(rel, gitBlobSha(Buffer.from(text), TREE));
  }
  return repoViewOver(
    asAppPath(root),
    TREE,
    blobs,
    blobSourceOf(Object.values(tree), TREE),
  );
}

const sorted = (s: Set<string>): string[] => [...s].sort();

test("a closure follows relative and @plugins imports through the tree, and nothing else", async () => {
  const view = viewOf({
    "plugins/shell/lint/index.ts":
      'import { b } from "./b";\nimport { c } from "@plugins/search/core";\nimport x from "eslint";\n',
    "plugins/shell/lint/b.ts":
      'import { d } from "./d";\nexport const b = 1;\n',
    "plugins/shell/lint/d.tsx": "export const d = 1;\n",
    "plugins/search/core/index.ts": 'export * from "./c";\n',
    "plugins/search/core/c.ts": "export const c = 1;\n",
    "plugins/ids/unrelated.ts": "export const u = 1;\n",
  });
  const walks = await lintClosures(view, ["plugins/shell/lint/index.ts"]);
  expect(sorted(walks.of("plugins/shell/lint/index.ts", new Set()))).toEqual([
    "plugins/search/core/c.ts",
    "plugins/search/core/index.ts",
    "plugins/shell/lint/b.ts",
    "plugins/shell/lint/d.tsx",
    "plugins/shell/lint/index.ts",
  ]);
});

test("an import of a file the tree does not hold fails loudly, though the file is on disk", () => {
  const view = viewOf(
    { "plugins/shell/lint/index.ts": 'import { m } from "./missing";\n' },
    { "plugins/shell/lint/missing.ts": "export const m = 1;\n" },
  );
  expect(lintClosures(view, ["plugins/shell/lint/index.ts"])).rejects.toThrow(
    "resolves to no file of the checkout",
  );
});

test("a registry is never entered, a stop file is not descended, a non-lintable member is not a way through", async () => {
  const view = viewOf({
    "plugins/shell/lint/index.ts":
      'import "./lint.generated";\nimport "../../history/core";\nimport "../../../prototypes/p";\n',
    "plugins/shell/lint/lint.generated.ts": 'import "./behind-registry";\n',
    "plugins/shell/lint/behind-registry.ts": "export {};\n",
    "plugins/history/core/index.ts": 'import "./engine-dep";\n',
    "plugins/history/core/engine-dep.ts": "export {};\n",
    "prototypes/p.ts": 'import "../plugins/shell/lint/behind-prototype";\n',
    "plugins/shell/lint/behind-prototype.ts": "export {};\n",
  });
  const walks = await lintClosures(view, ["plugins/shell/lint/index.ts"]);
  expect(
    sorted(
      walks.of(
        "plugins/shell/lint/index.ts",
        new Set(["plugins/history/core/index.ts"]),
      ),
    ),
  ).toEqual(["plugins/shell/lint/index.ts", "prototypes/p.ts"]);
  // Without the stop, the engine's own closure is followed.
  expect(sorted(walks.of("plugins/shell/lint/index.ts", new Set()))).toEqual([
    "plugins/history/core/engine-dep.ts",
    "plugins/history/core/index.ts",
    "plugins/shell/lint/index.ts",
    "prototypes/p.ts",
  ]);
});

test("each file is read once across closures, and only files on a walk are", async () => {
  const view = viewOf({
    "plugins/ui/shared.ts": "export const s = 1;\n",
    "plugins/map/lint/index.ts": 'import "../../ui/shared";\n',
    "plugins/music/lint/index.ts": 'import "../../ui/shared";\n',
    "plugins/ids/read.ts": "export const r = 1;\n",
  });
  const walks = await lintClosures(view, [
    "plugins/map/lint/index.ts",
    "plugins/music/lint/index.ts",
  ]);
  walks.of("plugins/map/lint/index.ts", new Set());
  walks.of("plugins/music/lint/index.ts", new Set());
  expect(walks.parsed()).toBe(3);
});

test("a group root the tree does not hold fails loudly", () => {
  const view = viewOf({ "plugins/ui/a.ts": "export {};\n" });
  expect(lintClosures(view, ["plugins/review/lint/index.ts"])).rejects.toThrow(
    "is not in the checked tree",
  );
});

test("a type-only import is no edge; a value, side-effect or inline import is", async () => {
  const view = viewOf({
    "plugins/shell/lint/index.ts": [
      'import type { T } from "./typed";',
      'export type { U } from "./re-typed";',
      'import { type V, w } from "./mixed";',
      'import "./side";',
      'export const load = () => import("./dynamic");',
      "",
    ].join("\n"),
    "plugins/shell/lint/typed.ts": "export type T = 1;\n",
    "plugins/shell/lint/re-typed.ts": "export type U = 1;\n",
    "plugins/shell/lint/mixed.ts": "export type V = 1;\nexport const w = 1;\n",
    "plugins/shell/lint/side.ts": "export {};\n",
    "plugins/shell/lint/dynamic.ts": "export {};\n",
  });
  const walks = await lintClosures(view, ["plugins/shell/lint/index.ts"]);
  expect(sorted(walks.of("plugins/shell/lint/index.ts", new Set()))).toEqual([
    "plugins/shell/lint/dynamic.ts",
    "plugins/shell/lint/index.ts",
    "plugins/shell/lint/mixed.ts",
    "plugins/shell/lint/side.ts",
  ]);
});

// The engine is folded into every rule group, so an edit to any file of its
// closure re-lints the whole tree (~500–800 CPU-s). It used to grow unseen:
// through the builder's own repo listing and `import type` edges, process
// plumbing (spawn, flock, semaphores, host admission) was 39 of its 53 files,
// and half the whole-tree re-lints of 10-28..11-05 came from edits to that
// plumbing, none of which can change a message. So the folders the engine
// reaches are declared here: a new one fails this test, and whoever adds it
// decides whether a rule's output really depends on it — or takes it as data,
// the way the builder takes the manifests' file set its IDE entry lists
// (`lint/core/ide-lint-config.ts`) and the stylesheet's `@utility` set
// (`readDeclaredUtilities`, keyed by `lintDataKey`): the builder read that file
// itself until 2026-11-08, which put timed-fs and user-path in the engine — 4 of
// the 20 engine moves of 11-01..11-08 were timed-fs edits, each a whole-tree
// re-lint in every worktree.
const ENGINE_FOLDERS = [
  // The builder, its classifier and scope lists.
  "plugins/framework/plugins/tooling/plugins/lint/core",
  // File categories: which rules are off in tests, e2e, and declared scopes.
  "plugins/framework/plugins/tooling/plugins/exempt/core",
  // This check's lint engine: the configs per part, the `--quiet` filter,
  // the message shape and the per-group bucketing (`shared/lint-engine.ts`).
  "plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared",
  // The group names it buckets messages under (`core/worker-protocol.ts`).
  "plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/core",
];

/** The real engine as `computeLintGroups` derives it, over the working tree. */
async function realEngine() {
  const code = viewOfSnapshot(
    await readTreeSnapshot(asAppPath(codeCheckoutRoot())),
  );
  const walks = await lintClosures(code, [
    LINT_CONFIG_SOURCE,
    ...lintWorkerModules(code),
  ]);
  const roots = lintEngineRoots(walks, code);
  const engine = new Set<string>();
  for (const r of roots) for (const f of walks.of(r, new Set())) engine.add(f);
  return { walks, roots, engine };
}

test("the lint engine is rooted at every module the worker loads that runs ESLint", async () => {
  const { roots } = await realEngine();
  expect(roots).toEqual(
    [
      LINT_CONFIG_SOURCE,
      "plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared/lint-engine.ts",
    ].sort(),
  );
});

test("the lint engine reaches only its declared folders", async () => {
  const { engine } = await realEngine();
  // A file's folder: its path up to its barrel folder (`core/`, …).
  const folders = new Set(
    [...engine].map((f) => {
      const m = /^(.*?\/(?:core|shared|server|web|central|cli))\//.exec(f);
      if (m === null)
        throw new Error(`engine file ${f} is in no barrel folder`);
      return m[1]!;
    }),
  );
  expect([...folders].sort()).toEqual([...ENGINE_FOLDERS].sort());
});

test("a lint loop moved into a module of its own is engine the moment it imports ESLint", async () => {
  const shared =
    "plugins/framework/plugins/tooling/plugins/checks/plugins/type-check/shared";
  const files = {
    [LINT_CONFIG_SOURCE]: 'const l = await import("eslint");\n',
    [`${shared}/worker.ts`]: 'import { run } from "./loop";\n',
    [`${shared}/loop.ts`]:
      'import { quiet } from "@plugins/search/core";\nimport { Linter } from "eslint";\n',
    [`${shared}/plumbing.ts`]:
      'import { spawn } from "@plugins/review/core";\n',
    "plugins/search/core/index.ts":
      'export { quiet } from "./quiet";\nexport { read } from "./read";\n',
    "plugins/search/core/quiet.ts": "export const quiet = 2;\n",
    "plugins/search/core/read.ts":
      'import { fs } from "@plugins/review/core";\n',
    "plugins/review/core/index.ts": "export const spawn = 1;\n",
  };
  const view = viewOf(files);
  const code = { files: () => Object.keys(files) };
  const walks = await lintClosures(view, [
    LINT_CONFIG_SOURCE,
    ...lintWorkerModules(code),
  ]);
  const roots = lintEngineRoots(walks, code);
  expect(roots).toEqual([LINT_CONFIG_SOURCE, `${shared}/loop.ts`].sort());
  // By name through the barrel: the loop's helper, not the barrel's reader.
  expect(sorted(walks.of(`${shared}/loop.ts`, new Set()))).toEqual([
    `${shared}/loop.ts`,
    "plugins/search/core/index.ts",
    "plugins/search/core/quiet.ts",
  ]);
});

test("a barrel the engine entered by name still leads a contribution to the names the engine did not ask", async () => {
  const view = viewOf({
    "plugins/audience/core/builder.ts":
      'import { build } from "@plugins/runs/core";\n',
    "plugins/runs/core/index.ts": [
      'export { build } from "./build";',
      'export { creator } from "./creator";',
      'export * as ns from "./ns";',
      "",
    ].join("\n"),
    "plugins/runs/core/build.ts": "export const build = 1;\n",
    "plugins/runs/core/creator.ts": 'import { id } from "@plugins/ids/core";\n',
    "plugins/runs/core/ns.ts": "export const n = 1;\n",
    "plugins/ids/core/index.ts": "export const id = 1;\n",
    "plugins/shell/lint/index.ts":
      'import { creator, build, ns } from "@plugins/runs/core";\n',
  });
  const walks = await lintClosures(view, [
    "plugins/audience/core/builder.ts",
    "plugins/shell/lint/index.ts",
  ]);
  const engine = walks.of("plugins/audience/core/builder.ts", new Set());
  expect(sorted(engine)).toEqual([
    "plugins/audience/core/builder.ts",
    "plugins/runs/core/build.ts",
    "plugins/runs/core/index.ts",
  ]);
  // The engine's barrel is no wall: the contribution reaches `creator` and
  // the namespace `ns` through it, and stops at `build`, which the engine
  // covers.
  expect(sorted(walks.of("plugins/shell/lint/index.ts", engine))).toEqual([
    "plugins/ids/core/index.ts",
    "plugins/runs/core/creator.ts",
    "plugins/runs/core/index.ts",
    "plugins/runs/core/ns.ts",
    "plugins/shell/lint/index.ts",
  ]);
});

test("a closure enters a pure barrel by name, and an impure one whole", async () => {
  const view = viewOf({
    "plugins/shell/lint/index.ts": [
      'import { a, type T } from "@plugins/wish/core";',
      'import { z } from "@plugins/tasks/core";',
      'import * as all from "@plugins/hints/core";',
      "",
    ].join("\n"),
    // Pure: re-exports and a type alias. `a` is reached through `export *`.
    "plugins/wish/core/index.ts": [
      'export { b, c as d } from "./bc";',
      'export * from "./star";',
      'export type { T } from "./types";',
      'import type { U } from "./types";',
      "export type V = U;",
      "",
    ].join("\n"),
    "plugins/wish/core/bc.ts":
      'import { heavy } from "@plugins/history/core";\n',
    "plugins/wish/core/star.ts": "export const a = 1;\n",
    "plugins/wish/core/types.ts": "export type T = 1;\n",
    // Impure: a local export, so every import of it is followed.
    "plugins/tasks/core/index.ts":
      'import { z } from "./z";\nimport { y } from "./y";\nexport { z };\n',
    "plugins/tasks/core/z.ts": "export const z = 1;\n",
    "plugins/tasks/core/y.ts": "export const y = 1;\n",
    // A namespace import asks every name.
    "plugins/hints/core/index.ts":
      'export { r1 } from "./r1";\nexport { r2 } from "./r2";\n',
    "plugins/hints/core/r1.ts": "export const r1 = 1;\n",
    "plugins/hints/core/r2.ts": "export const r2 = 1;\n",
    "plugins/history/core/index.ts": "export const heavy = 1;\n",
  });
  const walks = await lintClosures(view, ["plugins/shell/lint/index.ts"]);
  expect(sorted(walks.of("plugins/shell/lint/index.ts", new Set()))).toEqual(
    [
      "plugins/wish/core/index.ts",
      "plugins/wish/core/star.ts",
      "plugins/tasks/core/index.ts",
      "plugins/tasks/core/y.ts",
      "plugins/tasks/core/z.ts",
      "plugins/hints/core/index.ts",
      "plugins/hints/core/r1.ts",
      "plugins/hints/core/r2.ts",
      "plugins/shell/lint/index.ts",
    ].sort(),
  );
});

test("a closure's npm packages are what its files import by name, builtins aside", async () => {
  const view = viewOf({
    "plugins/shell/lint/index.ts": [
      'import { b } from "./b";',
      'import ts from "typescript";',
      'import { x } from "@typescript-eslint/utils/ts-eslint";',
      'import { readFileSync } from "fs";',
      'import { join } from "node:path";',
      'import { test } from "bun:test";',
      'import { $ } from "bun";',
      'import type { T } from "zod";',
      "",
    ].join("\n"),
    "plugins/shell/lint/b.ts": 'import picomatch from "picomatch/posix";\n',
  });
  const walks = await lintClosures(view, ["plugins/shell/lint/index.ts"]);
  const closure = walks.of("plugins/shell/lint/index.ts", new Set());
  expect(sorted(walks.packagesOf(closure))).toEqual([
    "@typescript-eslint/utils",
    "picomatch",
    "typescript",
  ]);
});

// The npm packages the engine imports by name: with their lockfile closure,
// the npm code every group folds in. Like ENGINE_FOLDERS, a new one fails
// here, so whoever adds it sees that a bump of it (or of anything it depends
// on) re-lints every file.
const ENGINE_PACKAGES = [
  // The builder's own rules and parser (the base group).
  "@typescript-eslint/eslint-plugin",
  "@typescript-eslint/parser",
  "eslint-plugin-react-hooks",
  // The worker's linter, and the parser's compiler.
  "eslint",
  "typescript",
  // The exemption manifests' schema (exempt/core).
  "zod",
];

test("the lint engine loads only its declared npm packages", async () => {
  const { walks, engine } = await realEngine();
  expect(sorted(walks.packagesOf(engine))).toEqual([...ENGINE_PACKAGES].sort());
});

test("a dependency or patch no rule loads moves no group; a patch of one a rule loads moves every group", async () => {
  const code = viewOfSnapshot(
    await readTreeSnapshot(asAppPath(codeCheckoutRoot())),
  );
  const real = (rel: string): string =>
    readFileSync(join(codeCheckoutRoot(), rel), "utf8");
  const lock = real("bun.lock");
  const patches = code.files().filter((f) => f.startsWith("patches/"));
  const base: Record<string, string> = {
    "bun.lock": lock,
    "package.json": real("package.json"),
    "tsconfig.json": real("tsconfig.json"),
    "tsconfig.base.json": real("tsconfig.base.json"),
    ...Object.fromEntries(LINT_DATA_FILES.map((f) => [f, real(f)])),
    ...Object.fromEntries(patches.map((p) => [p, real(p)])),
  };
  // The npm code is the CODE checkout's: the fixture's lockfile and patches
  // stand in for the code tree's, under the repo's own rules.
  const fpsOf = async (files: Record<string, string>) => {
    const v = viewOf(files);
    const mine = (rel: string) =>
      rel === "bun.lock" || rel.startsWith("patches/");
    const withNpm: RepoView = {
      ...code,
      isFile: (rel) => (mine(rel) ? v.isFile(rel) : code.isFile(rel)),
      version: (rel) => (mine(rel) ? v.version(rel) : code.version(rel)),
      readText: (rel) => (mine(rel) ? v.readText(rel) : code.readText(rel)),
    };
    return (await computeLintGroups(v, withNpm)).fps;
  };
  const before = await fpsOf(base);

  // A server-only package's patch, and a new dependency nobody lints with.
  const graphile = patches.find((p) => p.includes("graphile-worker"))!;
  const unrelated = await fpsOf({
    ...base,
    [graphile]: `${base[graphile]}\n`,
    "package.json": base["package.json"]!.replace(
      '"dependencies": {',
      '"dependencies": {\n    "left-pad": "^1.3.0",',
    ),
    "bun.lock": lock.replace(
      '  "packages": {\n',
      '  "packages": {\n    "left-pad": ["left-pad@1.3.0", "", {}, "sha512-x"],\n',
    ),
  });
  expect(unrelated).toEqual(before);

  // A patch of a package the builder loads.
  const hooks = patches.find((p) => p.includes("eslint-plugin-react-hooks"))!;
  const moved = await fpsOf({ ...base, [hooks]: `${base[hooks]}\n` });
  for (const [g, fp] of before) expect(moved.get(g)).not.toBe(fp);
});
