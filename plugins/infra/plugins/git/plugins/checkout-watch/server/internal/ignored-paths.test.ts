import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { ignoredPaths } from "./ignored-paths";

let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "checkout-watch-ignored-"));
  await runGit(["init", "-q"], root);
  writeFileSync(join(root, ".gitignore"), "dist/\n*.log\n");
  mkdirSync(join(root, "dist"));
  writeFileSync(join(root, "dist", "a.js"), "");
  writeFileSync(join(root, "tracked.log"), "");
  mkdirSync(join(root, "build"));
  writeFileSync(join(root, "build", "index.ts"), "");
  // Tracked despite matching `*.log`: git status still shows its changes.
  await runGit(["add", "-f", "tracked.log"], root);
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("ignoredPaths", () => {
  test("answers by git's rules: ignored untracked paths only", async () => {
    const ignored = await ignoredPaths(root, [
      "dist/a.js",
      "dist/gone/never-existed.js",
      "untracked.log",
      "tracked.log",
      ".gitignore",
      "build/index.ts",
      "src/a.ts",
    ]);
    expect([...ignored].sort()).toEqual([
      "dist/a.js",
      "dist/gone/never-existed.js",
      "untracked.log",
    ]);
  });

  test("none ignored is an empty answer, not a failure", async () => {
    const ignored = await ignoredPaths(root, ["src/a.ts", "build/index.ts"]);
    expect(ignored.size).toBe(0);
  });

  test("a checkout that is gone ignores nothing", async () => {
    const ignored = await ignoredPaths(join(root, "no-such-dir"), ["a.ts"]);
    expect(ignored.size).toBe(0);
  });
});
