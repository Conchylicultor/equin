import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diffSnapshots,
  parsePorcelainZ,
  planRestore,
  restoringMainTreeOnThrow,
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

describe("planRestore", () => {
  const w = (path: string, status: string, wasClean: boolean) => ({
    path,
    status,
    wasClean,
  });

  test("a hand-authored (non-regen) file clean before the build is restored", () => {
    // 2026-11-04: seedAuthoredOverrides re-stamped config overrides on main.
    const modified = w("config/apps-core/app.jsonc", " M", true);
    expect(planRestore([modified])).toEqual({ restore: [modified], kept: [] });
  });

  test("a generated artifact clean before the build is restored", () => {
    const doc = w("docs/plugins-details.md", " M", true);
    expect(planRestore([doc]).restore).toEqual([doc]);
  });

  test("a tracked file the build deleted, staged or not, is restored", () => {
    const deleted = [
      w("a.ts", " D", true),
      w("b.ts", "D ", true),
      w("c.ts", "MM", true),
      w("d.ts", " T", true),
    ];
    expect(planRestore(deleted)).toEqual({ restore: deleted, kept: [] });
  });

  test("a path dirty before the build is never restored", () => {
    const edited = w("config/apps-core/app.jsonc", " M", false);
    const reverted = w("b.ts", " D", false);
    expect(planRestore([edited, reverted])).toEqual({
      restore: [],
      kept: [
        { ...edited, reason: "dirty-before" },
        { ...reverted, reason: "dirty-before" },
      ],
    });
  });

  test("a path with no HEAD version, or unmerged, is kept", () => {
    const created = [
      w("new.generated.ts", "??", true),
      w("staged.ts", "A ", true),
      w("moved.ts", "R ", true),
      w("conflict.ts", "UU", true),
    ];
    expect(planRestore(created)).toEqual({
      restore: [],
      kept: created.map((c) => ({ ...c, reason: "not-restorable" })),
    });
  });
});

describe("restoringMainTreeOnThrow", () => {
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

  test("a writer that throws has its writes restored, and its error rethrown", async () => {
    await withRepo(async (root) => {
      // Dirty before the build: someone's edit, never touched.
      writeFileSync(join(root, "edited.md"), "someone's edit\n");
      const before = await snapshotTree(root);
      const crash = new Error("codegen crashed mid-write");
      const thrown = await restoringMainTreeOnThrow(root, before, async () => {
        writeFileSync(join(root, "doc.md"), "half-written\n");
        throw crash;
      }).then(
        () => "resolved",
        (err: unknown) => err,
      );
      expect(thrown).toBe(crash);
      expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("committed\n");
      expect(readFileSync(join(root, "edited.md"), "utf8")).toBe(
        "someone's edit\n",
      );
    });
  });

  test("a writer that succeeds is returned untouched — the guard judges it", async () => {
    await withRepo(async (root) => {
      const before = await snapshotTree(root);
      const out = await restoringMainTreeOnThrow(root, before, async () => {
        writeFileSync(join(root, "doc.md"), "written\n");
        return 42;
      });
      expect(out).toBe(42);
      expect(readFileSync(join(root, "doc.md"), "utf8")).toBe("written\n");
    });
  });
});
