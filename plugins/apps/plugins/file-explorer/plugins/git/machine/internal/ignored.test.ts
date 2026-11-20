import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import {
  folderIn,
  movesIgnoreRules,
  readIgnoredEntries,
  withinTwoLevels,
} from "./ignored";

let root: string;

function write(rel: string, text = "x\n"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, text);
}

beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "git-ignored-")));
  await runGit(["init", "-q"], root);
  write(".gitignore", "node_modules/\n*.log\ndist/\n");
  write("src/a.ts");
  write("src/b.log");
  write("src/node_modules/x/index.js");
  write("node_modules/react/index.js");
  write("app.log");
  write("dist/kept.js"); // tracked despite the rule
  write("dist/built.js");
  write("plain.txt");
  write(":(glob)weird.log"); // a name that reads as pathspec magic
  write("src/deep/c.log"); // three levels down from the root
  symlinkSync(join(root, "src"), join(root, "linked"));
  await runGit(["add", ".gitignore", "src/a.ts", "plain.txt"], root);
  await runGit(["add", "-f", "dist/kept.js"], root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("readIgnoredEntries", () => {
  test("the root: its entries and its subfolders' entries, never a folder holding a tracked file", async () => {
    const { paths, truncated } = await readIgnoredEntries(root, "");
    expect(truncated).toBe(false);
    // Below node_modules nothing is listed (ignored by prefix); dist holds a
    // tracked file so only its ignored file is; src/deep/c.log is a level too
    // deep for the root's answer; nothing beyond the `linked` symlink.
    expect(paths.sort()).toEqual(
      [
        ":(glob)weird.log",
        "app.log",
        "dist/built.js",
        "node_modules",
        "src/b.log",
        "src/node_modules",
      ].sort(),
    );
  });

  test("a folder below the root answers two levels of its own", async () => {
    const { paths } = await readIgnoredEntries(root, "src");
    expect(paths.sort()).toEqual(["b.log", "deep/c.log", "node_modules"]);
  });

  test("nothing is ignored beyond a symlink", async () => {
    expect(await readIgnoredEntries(root, "linked")).toEqual({
      paths: [],
      truncated: false,
    });
  });

  test("a missing folder and a path climbing out are refused", () => {
    expect(readIgnoredEntries(root, "nope")).rejects.toThrow(/No such folder/);
    expect(() => folderIn(root, "../x")).toThrow(/Not a folder path/);
    expect(() => folderIn(root, "/abs")).toThrow(/Not a folder path/);
    expect(() => folderIn(root, "a//b")).toThrow(/Not a folder path/);
  });
});

describe("withinTwoLevels", () => {
  test("the folder, its entries and its subfolders' entries; nothing deeper or outside", () => {
    expect(withinTwoLevels("/r/a", "/r/a")).toBe(true);
    expect(withinTwoLevels("/r/a", "/r/a/x")).toBe(true);
    expect(withinTwoLevels("/r/a", "/r/a/x/y")).toBe(true);
    expect(withinTwoLevels("/r/a", "/r/a/x/y/z")).toBe(false);
    expect(withinTwoLevels("/r/a", "/r/b/x")).toBe(false);
  });
});

describe("movesIgnoreRules", () => {
  test("a .gitignore or the git dir can; another tree change cannot", () => {
    expect(
      movesIgnoreRules({ path: "/r/a/.gitignore", area: "worktree" }),
    ).toBe(true);
    expect(movesIgnoreRules({ path: "/r/.git/index", area: "git" })).toBe(true);
    expect(movesIgnoreRules({ path: "/r/a/b.ts", area: "worktree" })).toBe(
      false,
    );
  });
});
