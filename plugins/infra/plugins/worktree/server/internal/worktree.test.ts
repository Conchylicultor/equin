import { describe, expect, test } from "bun:test";
import { isCanonicalWorktreePath } from "./worktree";

describe("isCanonicalWorktreePath", () => {
  // Synthetic repo root — `isCanonicalWorktreePath` only does path logic relative
  // to it. Kept free of real-home patterns so `paths:no-hardcoded-paths` is happy.
  const root = "/repo/equin";
  test("accepts a direct child of <root>/.claude/worktrees", () => {
    expect(isCanonicalWorktreePath(`${root}/.claude/worktrees/att-123-abc`, root)).toBe(true);
  });
  test("rejects the repo root itself", () => {
    expect(isCanonicalWorktreePath(root, root)).toBe(false);
  });
  test("rejects /tmp paths", () => {
    expect(isCanonicalWorktreePath("/tmp", root)).toBe(false);
    expect(isCanonicalWorktreePath("/tmp/askq-test", root)).toBe(false);
  });
  test("rejects a path nested deeper than a direct child", () => {
    expect(isCanonicalWorktreePath(`${root}/.claude/worktrees/att-1/sub`, root)).toBe(false);
  });
  test("rejects a sibling of the worktrees dir", () => {
    expect(isCanonicalWorktreePath(`${root}/.claude/att-123`, root)).toBe(false);
  });
});
