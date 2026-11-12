/**
 * The check's input is the run's git tree alone, read through one view
 * (`./repo-view.ts`), on a real git fixture:
 *   1. a file's version is its git blob sha — what `git hash-object` says;
 *   2. a gitignored file is not in the view and not a root, even under the
 *      tsconfig `include` (a build's composition registry, a file under an
 *      ignored directory the tsconfig does not exclude) — so a build
 *      rewriting one while a check runs changes nothing it reads;
 *   3. the worker's parse of the tsconfig over the view finds the same roots;
 *   4. no gitignored entry moves a resolution key — a transient one at the
 *      root, nor one the tsconfig includes that would shadow a resolution;
 *   5. a file edited or deleted after the tree was taken still reads as the
 *      tree's blob.
 */

import {
  asAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
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

let root: AppPath = asAppPath("");

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
  root = asAppPath(realpathSync(mkdtempSync(join(tmpdir(), "repo-view-"))));
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
  // Gitignored, under the include: still not in the input.
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

test("a gitignored file is not in the input, even under the include", async () => {
  const { view, config } = await read();
  if (config.kind !== "parsed") throw new Error("expected a parsed tsconfig");
  expect([...config.roots].sort()).toEqual([
    "src/a.ts",
    "src/pkg/index.ts",
    "src/use.ts",
    "vite.config.ts",
  ]);
  for (const rel of [
    "src/web.composition.x.generated.ts",
    "src/stale/keep.ts",
    "src/node_modules/dep/index.ts",
    "src/dist/out.ts",
  ]) {
    expect(view.isFile(rel)).toBe(false);
  }
});

test("a build rewriting a gitignored registry mid-run changes nothing the check reads", async () => {
  const before = await read();
  write("src/web.composition.x.generated.ts", "export const reg = [1];\n");
  try {
    const after = await read();
    expect(after.tree.treeHash).toBe(before.tree.treeHash);
    // Every file of the view still reads: none of them was the registry.
    for (const rel of before.view.files()) before.view.readText(rel);
  } finally {
    write("src/web.composition.x.generated.ts", "export const reg = [];\n");
  }
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

test("no gitignored entry moves a resolution key — transient, or included and shadowing", async () => {
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

  // A gitignored file the tsconfig includes does not exist for the check:
  // it shadows nothing.
  write("src/pkg.ts", "export const v = 2;\n");
  try {
    const shadowed = await read();
    expect(shadowed.view.isFile("src/pkg.ts")).toBe(false);
    expect(resolveUse(shadowed)).toEqual(base);
  } finally {
    rmSync(join(root, "src/pkg.ts"));
  }
});

test("a file edited or deleted after the tree was taken reads as the tree's blob", async () => {
  const { view } = await read();
  expect(view.readText("src/a.ts")).toBe("export const a = 1;\n");
  // What a push merging into a live checkout mid-run does: the working tree
  // moves, the run's tree does not — its bytes come out of the object store.
  write("src/a.ts", "export const a = 2;\n");
  try {
    expect(view.readText("src/a.ts")).toBe("export const a = 1;\n");
    rmSync(join(root, "src/a.ts"));
    expect(view.readText("src/a.ts")).toBe("export const a = 1;\n");
  } finally {
    write("src/a.ts", "export const a = 1;\n");
  }
  expect(() => view.readText("src/nope.ts")).toThrow(
    "is not in the checked tree",
  );
});
