import { describe, expect, test } from "bun:test";
import {
  diffSnapshots,
  parsePorcelainZ,
  planRestore,
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
