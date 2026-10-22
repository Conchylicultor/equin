/**
 * The check's input is the run's git tree plus its OVERLAY, read through one
 * view (`./repo-view.ts`), on a real git fixture:
 *   1. a file's version is its git blob sha — what `git hash-object` says;
 *   2. the overlay is the gitignored files the tsconfig makes roots of — a
 *      composition registry, a file under an ignored directory the tsconfig
 *      does not exclude — each versioned the same way; an ignored file under
 *      an excluded directory (`node_modules`, `dist`) is not one;
 *   3. the worker's parse of the tsconfig over the view finds the same roots;
 *   4. a transient gitignored entry at the root moves no resolution key, while
 *      a gitignored file the tsconfig includes, shadowing a resolution, does;
 *   5. a file whose bytes changed after the tree was taken cannot be read.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
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
import { ProbeFs, RecordingResolver } from "./name-resolve";
import {
  openRepoView,
  parseTsconfigOver,
  readCheckTree,
  type ReadCheckTree,
} from "./repo-view";

let root = "";

function write(rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

async function git(...args: string[]): Promise<string> {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (exit ${code}): ${await new Response(proc.stderr).text()}`,
    );
  }
  return out.trim();
}

const read = (): Promise<ReadCheckTree> =>
  readCheckTree(root, join(root, "tsconfig.json"));

const OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
};

beforeAll(async () => {
  // The real path: tsc names files by it, and so does the view.
  root = realpathSync(mkdtempSync(join(tmpdir(), "repo-view-")));
  write(
    "tsconfig.json",
    JSON.stringify({
      include: ["src", "*.config.ts"],
      exclude: ["**/node_modules", "**/dist"],
    }),
  );
  write(
    ".gitignore",
    [
      "*.composition.*.generated.ts",
      "node_modules/",
      "dist/",
      "stale/",
      ".install.lock",
      ".check-*/",
      "src/pkg.ts",
      "",
    ].join("\n"),
  );
  write("vite.config.ts", "export default {};\n");
  write("src/a.ts", "export const a = 1;\n");
  write("src/pkg/index.ts", "export const v = 1;\n");
  write("src/use.ts", 'import { v } from "./pkg";\nexport const w = v;\n');
  // Gitignored, under the include: the overlay.
  write("src/web.composition.x.generated.ts", "export const reg = [];\n");
  write("src/stale/keep.ts", "export const keep = 1;\n");
  // Gitignored, under an excluded directory: never a root.
  write("src/node_modules/dep/index.ts", "export const dep = 1;\n");
  write("src/dist/out.ts", "export const out = 1;\n");
  await git("init", "-q");
  // So the host user's own global ignores cannot decide what the fixture holds.
  await git("config", "core.excludesFile", "/dev/null");
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test("a file's version is its git blob sha", async () => {
  const { view } = await read();
  for (const rel of ["src/a.ts", "src/use.ts", "tsconfig.json"]) {
    expect(view.version(rel)).toBe(await git("hash-object", rel));
  }
});

test("the overlay is the gitignored roots, versioned like the tree", async () => {
  const { tree, view, config } = await read();
  expect(Object.keys(tree.overlay).sort()).toEqual([
    "src/stale/keep.ts",
    "src/web.composition.x.generated.ts",
  ]);
  for (const [rel, version] of Object.entries(tree.overlay)) {
    expect(version).toBe(await git("hash-object", rel));
    expect(view.version(rel)).toBe(version);
  }
  if (config.kind !== "parsed") throw new Error("expected a parsed tsconfig");
  expect([...config.roots].sort()).toEqual([
    "src/a.ts",
    "src/pkg/index.ts",
    "src/stale/keep.ts",
    "src/use.ts",
    "src/web.composition.x.generated.ts",
    "vite.config.ts",
  ]);
  // What is ignored and not a root is not in the view at all.
  expect(view.isFile("src/node_modules/dep/index.ts")).toBe(false);
  expect(view.isFile("src/dist/out.ts")).toBe(false);
});

test("the worker's parse over the view finds the same roots", async () => {
  const { tree, config } = await read();
  const view = await openRepoView(root, tree);
  const again = parseTsconfigOver(view, join(root, "tsconfig.json"));
  if (config.kind !== "parsed" || again.kind !== "parsed") {
    throw new Error("expected a parsed tsconfig");
  }
  expect([...again.roots].sort()).toEqual([...config.roots].sort());
});

/** `src/use.ts`'s resolution of `./pkg`: its target and its key. */
function resolveUse(r: ReadCheckTree): { target: string; key: string } {
  const rec = new RecordingResolver(new ProbeFs(r.view), OPTIONS).record(
    "src/use.ts",
    [["./pkg", -1]],
  );
  return { target: rec.targets[0]![2], key: rec.key };
}

test("a transient gitignored entry moves no resolution key; an included shadow does", async () => {
  const before = await read();
  const base = resolveUse(before);
  expect(base.target).toBe("src/pkg/index.ts");

  // What unrelated commands leave at the root: gitignored, never a root.
  write(".install.lock", "");
  write(".check-123/x.ts", "export {};\n");
  const transient = await read();
  expect(transient.tree.treeHash).toBe(before.tree.treeHash);
  expect(new ProbeFs(transient.view).listing("")).toBe(
    new ProbeFs(before.view).listing(""),
  );
  expect(resolveUse(transient)).toEqual(base);

  // A gitignored file the tsconfig includes is in the overlay, and shadows.
  write("src/pkg.ts", "export const v = 2;\n");
  try {
    const shadowed = await read();
    expect(Object.keys(shadowed.tree.overlay)).toContain("src/pkg.ts");
    const moved = resolveUse(shadowed);
    expect(moved.target).toBe("src/pkg.ts");
    expect(moved.key).not.toBe(base.key);
  } finally {
    rmSync(join(root, "src/pkg.ts"));
  }
});

test("a file whose bytes changed after the tree was taken cannot be read", async () => {
  const { view } = await read();
  expect(view.readText("src/a.ts")).toBe("export const a = 1;\n");
  write("src/a.ts", "export const a = 2;\n");
  try {
    expect(() => view.readText("src/a.ts")).toThrow(
      "changed on disk after the check took its tree",
    );
  } finally {
    write("src/a.ts", "export const a = 1;\n");
  }
  expect(() => view.readText("src/nope.ts")).toThrow(
    "is not in the checked tree",
  );
});
