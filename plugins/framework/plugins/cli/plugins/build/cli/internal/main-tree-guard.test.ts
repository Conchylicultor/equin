import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffSnapshots,
  parsePorcelainZ,
  describeMainTreeWrites,
  snapshotTree,
  type TreeEntry,
} from "./main-tree-guard";

const snap = (entries: Record<string, TreeEntry>) =>
  new Map(Object.entries(entries));

describe("parsePorcelainZ", () => {
  test("reads modified, deleted and untracked entries", () => {
    expect(parsePorcelainZ(" M docs/a.md\0D  b.ts\0?? c/d.ts\0")).toEqual([
      [" M", "docs/a.md"],
      ["D ", "b.ts"],
      ["??", "c/d.ts"],
    ]);
  });

  test("a rename keeps its destination and skips its source field", () => {
    expect(parsePorcelainZ("R  new.ts\0old.ts\0 M x.ts\0")).toEqual([
      ["R ", "new.ts"],
      [" M", "x.ts"],
    ]);
  });

  test("a clean tree is no entries", () => {
    expect(parsePorcelainZ("")).toEqual([]);
  });
});

describe("diffSnapshots", () => {
  test("nothing written when the tree is unchanged, even if it was dirty", () => {
    const dirty = snap({ "a.ts": { status: " M", content: "1" } });
    expect(diffSnapshots(dirty, dirty).written).toEqual([]);
  });

  test("a path dirty only after the build was written from clean", () => {
    const drift = diffSnapshots(
      snap({}),
      snap({ "docs/plugins-details.md": { status: " M", content: "2" } }),
    );
    expect(drift.written).toEqual([
      { path: "docs/plugins-details.md", status: " M", wasClean: true },
    ]);
  });

  test("a pre-existing edit the build rewrote is written, not from clean", () => {
    const drift = diffSnapshots(
      snap({ "a.ts": { status: " M", content: "1" } }),
      snap({ "a.ts": { status: " M", content: "2" } }),
    );
    expect(drift.written).toEqual([
      { path: "a.ts", status: " M", wasClean: false },
    ]);
  });

  test("an edit the build reverted to HEAD is a write too", () => {
    const drift = diffSnapshots(
      snap({ "a.ts": { status: " M", content: "1" } }),
      snap({}),
    );
    expect(drift.written).toEqual([
      { path: "a.ts", status: " M", wasClean: false },
    ]);
  });

  test("untracked files after the build are listed as suspects", () => {
    const stray = {
      "plugins/config_v2/web/internal/git-layer.generated.ts": {
        status: "??",
        content: "s",
      },
    };
    const drift = diffSnapshots(snap(stray), snap(stray));
    expect(drift.written).toEqual([]);
    expect(drift.untracked).toEqual([
      "plugins/config_v2/web/internal/git-layer.generated.ts",
    ]);
  });
});

describe("describeMainTreeWrites", () => {
  const git = (cwd: string, ...args: string[]) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const withRepo = async (fn: (root: string) => Promise<void>) => {
    const root = mkdtempSync(join(tmpdir(), "main-tree-guard-"));
    try {
      git(root, "init", "-q");
      writeFileSync(join(root, "doc.md"), "committed\n");
      writeFileSync(join(root, "edited.md"), "committed\n");
      git(root, "add", ".");
      git(
        root,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t",
        "commit",
        "-qm",
        "init",
      );
      await fn(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  test("a build's writes are accounted for and left in place (the slot's next checkout resets them)", async () => {
    await withRepo(async (root) => {
      writeFileSync(join(root, "edited.md"), "dirty before\n");
      const before = await snapshotTree(root);
      writeFileSync(join(root, "doc.md"), "written\n");
      writeFileSync(join(root, "stray.ts"), "stray\n");
      const account = await describeMainTreeWrites(root, before);
      expect(account).not.toBeNull();
      const text = account!.join("\n");
      expect(text).toContain(" M doc.md");
      expect(text).toContain("stray.ts");
      expect(text).not.toContain("edited.md");
      expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("written\n");
    });
  });

  test("rewriting a path already dirty before the build is a write, marked so", async () => {
    await withRepo(async (root) => {
      writeFileSync(join(root, "edited.md"), "dirty before\n");
      const before = await snapshotTree(root);
      writeFileSync(join(root, "edited.md"), "rewritten\n");
      const account = await describeMainTreeWrites(root, before);
      expect(account!.join("\n")).toContain(
        "edited.md (already dirty before the build)",
      );
    });
  });

  test("a build that wrote nothing git sees has no account", async () => {
    await withRepo(async (root) => {
      const before = await snapshotTree(root);
      expect(await describeMainTreeWrites(root, before)).toBeNull();
    });
  });
});
