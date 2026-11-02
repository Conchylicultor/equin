import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listDirNames } from "./worktree-dirs";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";

describe("listDirNames", () => {
  test("keeps directories, skips non-directory entries (.DS_Store shape)", () => {
    const dir = asAppPath(mkdtempSync(join(tmpdir(), "worktree-dirs-")));
    try {
      mkdirSync(joinAppPath(dir, "claude-123"));
      mkdirSync(joinAppPath(dir, MAIN_WORKTREE_NAME));
      writeFileSync(joinAppPath(dir, ".DS_Store"), "finder junk");
      writeFileSync(joinAppPath(dir, "att-abc.json"), "{}");
      expect(listDirNames(dir).sort()).toEqual([
        "claude-123",
        MAIN_WORKTREE_NAME,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tolerates an entry vanishing mid-scan (stat ENOENT)", () => {
    const dir = asAppPath(mkdtempSync(join(tmpdir(), "worktree-dirs-")));
    try {
      mkdirSync(joinAppPath(dir, "alive"));
      // A dangling symlink is listed by readdir but ENOENTs on stat — the same
      // shape as a worktree reaped between readdir and stat.
      symlinkSync(
        joinAppPath(dir, "does-not-exist"),
        joinAppPath(dir, "vanished"),
      );
      expect(listDirNames(dir)).toEqual(["alive"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing root dir yields an empty list", () => {
    expect(
      listDirNames(asAppPath(join(tmpdir(), "worktree-dirs-nonexistent-root"))),
    ).toEqual([]);
  });
});
