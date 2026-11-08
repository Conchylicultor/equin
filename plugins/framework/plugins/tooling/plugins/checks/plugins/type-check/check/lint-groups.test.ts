/**
 * A lint rule group's members are its import closure, walked from its root
 * over the check's view of the tree (`../shared/repo-view.ts`) — no whole-repo
 * graph, no disk probes. What the walk this replaced did, kept:
 *   1. relative and `@plugins/` imports resolve to a `.ts` / `.tsx` / index in
 *      the tree; a bare package, a missing target and an escape do not;
 *   2. a generated registry is never entered, and a `stop` file (the engine,
 *      for a contribution) is not descended into;
 *   3. a non-lintable member (`prototypes/`) is a member, not a way through;
 *   4. a file the tree does not hold is invisible, though it is on disk.
 * And: each file on a walk is parsed once, however many closures reach it; a
 * type-only import is no edge (erased before a rule runs); and the real
 * engine's closure holds no process plumbing.
 */

import { asAppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { gitBlobSha, repoViewOver, type RepoView } from "../shared/repo-view";
import { LINT_CONFIG_SOURCE } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { codeCheckoutRoot, lintClosures } from "./lint-groups";

const TREE = "0".repeat(40);
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
  for (const [rel, text] of Object.entries({ ...files, ...offTree })) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    if (rel in files) blobs.set(rel, gitBlobSha(Buffer.from(text), TREE));
  }
  return repoViewOver(asAppPath(root), TREE, blobs);
}

const sorted = (s: Set<string>): string[] => [...s].sort();

test("a closure follows relative and @plugins imports through the tree, and nothing else", () => {
  const view = viewOf(
    {
      "plugins/shell/lint/index.ts":
        'import { b } from "./b";\nimport { c } from "@plugins/search/core";\nimport x from "eslint";\nimport { m } from "./missing";\nimport { u } from "../../../../up";\n',
      "plugins/shell/lint/b.ts":
        'import { d } from "./d";\nexport const b = 1;\n',
      "plugins/shell/lint/d.tsx": "export const d = 1;\n",
      "plugins/search/core/index.ts": 'export * from "./c";\n',
      "plugins/search/core/c.ts": "export const c = 1;\n",
      "plugins/ids/unrelated.ts": "export const u = 1;\n",
    },
    // On disk, not in the tree: invisible to the walk.
    { "plugins/shell/lint/missing.ts": "export const m = 1;\n" },
  );
  expect(
    sorted(lintClosures(view).of("plugins/shell/lint/index.ts", new Set())),
  ).toEqual([
    "plugins/search/core/c.ts",
    "plugins/search/core/index.ts",
    "plugins/shell/lint/b.ts",
    "plugins/shell/lint/d.tsx",
    "plugins/shell/lint/index.ts",
  ]);
});

test("a registry is never entered, a stop file is not descended, a non-lintable member is not a way through", () => {
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
  const walks = lintClosures(view);
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

test("each file is parsed once across closures, and only files on a walk are", () => {
  const view = viewOf({
    "plugins/ui/shared.ts": "export const s = 1;\n",
    "plugins/map/lint/index.ts": 'import "../../ui/shared";\n',
    "plugins/music/lint/index.ts": 'import "../../ui/shared";\n',
    "plugins/ids/read.ts": "export const r = 1;\n",
  });
  const walks = lintClosures(view);
  walks.of("plugins/map/lint/index.ts", new Set());
  walks.of("plugins/music/lint/index.ts", new Set());
  expect(walks.parsed()).toBe(3);
});

test("a group root the tree does not hold fails loudly", () => {
  const view = viewOf({ "plugins/ui/a.ts": "export {};\n" });
  expect(() =>
    lintClosures(view).of("plugins/review/lint/index.ts", new Set()),
  ).toThrow("is not in the checked tree");
});

test("a type-only import is no edge; a value, side-effect or inline import is", () => {
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
  expect(
    sorted(lintClosures(view).of("plugins/shell/lint/index.ts", new Set())),
  ).toEqual([
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
];

test("the lint engine reaches only its declared folders", () => {
  const root = codeCheckoutRoot();
  // The working tree as it stands, so the test sees the edit under review.
  const disk = {
    treeHash: "working tree",
    isFile: (rel: string) => existsSync(join(root, rel)),
    readText: (rel: string) => readFileSync(join(root, rel), "utf8"),
  };
  const engine = lintClosures(disk).of(LINT_CONFIG_SOURCE, new Set());
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
