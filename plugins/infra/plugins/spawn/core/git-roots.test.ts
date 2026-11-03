/**
 * Tests for the memoized git-root helpers. Run with `bun test`.
 *
 * The memo contract is per resolved cwd and stores the PROMISE, so two calls
 * for the same cwd must return the identical promise (one spawn per process).
 * Outside a git repo the helpers THROW — never absorb to "".
 */

import { test, expect } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { getWorktreeRoot, getMainRepoRoot } from "./internal/git-roots";
import { SpawnFailedError } from "./internal/spawn-captured";

test("getWorktreeRoot resolves this checkout's root", async () => {
  const root = await getWorktreeRoot();
  expect(isAbsolute(root)).toBe(true);
  expect(existsSync(join(root, "package.json"))).toBe(true);
});

test("per-cwd memo identity: same cwd returns the identical promise", () => {
  expect(getWorktreeRoot()).toBe(getWorktreeRoot());
  expect(getWorktreeRoot(process.cwd())).toBe(getWorktreeRoot());
  expect(getMainRepoRoot()).toBe(getMainRepoRoot());
});

test("getMainRepoRoot resolves the main checkout owning .git", async () => {
  const mainRoot = await getMainRepoRoot();
  expect(isAbsolute(mainRoot)).toBe(true);
  expect(existsSync(join(mainRoot, ".git"))).toBe(true);
});

test("throws outside a git repo instead of absorbing to empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-spawn-norepo-"));
  try {
    expect(getWorktreeRoot(dir)).rejects.toBeInstanceOf(SpawnFailedError);
    expect(getMainRepoRoot(dir)).rejects.toBeInstanceOf(SpawnFailedError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
