import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listDirNames } from "./worktree-dirs";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

describe("listDirNames", () => {
  test("keeps directories, skips non-directory entries (.DS_Store shape)", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-dirs-"));
    try {
      mkdirSync(join(dir, "claude-123"));
      mkdirSync(join(dir, MAIN_WORKTREE_NAME));
      writeFileSync(join(dir, ".DS_Store"), "finder junk");
      writeFileSync(join(dir, "att-abc.json"), "{}");
      expect(listDirNames(dir).sort()).toEqual([
        "claude-123",
        MAIN_WORKTREE_NAME,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tolerates an entry vanishing mid-scan (stat ENOENT)", () => {
    const dir = mkdtempSync(join(tmpdir(), "worktree-dirs-"));
    try {
      mkdirSync(join(dir, "alive"));
      // A dangling symlink is listed by readdir but ENOENTs on stat — the same
      // shape as a worktree reaped between readdir and stat.
      symlinkSync(join(dir, "does-not-exist"), join(dir, "vanished"));
      expect(listDirNames(dir)).toEqual(["alive"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing root dir yields an empty list", () => {
    expect(
      listDirNames(join(tmpdir(), "worktree-dirs-nonexistent-root")),
    ).toEqual([]);
  });
});
