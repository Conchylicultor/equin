import { describe, expect, test } from "bun:test";
import type { TestFileStatusRow, TestStatus } from "../../core";
import {
  buildTestTree,
  countStatuses,
  fileLabel,
  type PluginRow,
} from "./build-test-tree";

// A fixture repo's plugins directory: paths are built from it, as data
// (no plugin of this checkout is named).
const P = "plugins";

function file(path: string, pluginId: string, status: TestStatus) {
  return {
    path,
    pluginId,
    runner: "bun:test",
    digest: "d",
    status,
    lastOutcome: null,
    lastRanAt: null,
    lastOpId: null,
    lastOrigin: null,
    lastSlug: null,
    cases: null,
    failedCases: null,
    durationMs: null,
    currentPassed: 0,
    currentFailed: 0,
    history: [],
  } as unknown as TestFileStatusRow;
}

const FILES = [
  file(`${P}/a/core/x.test.ts`, "a", "passing"),
  file(`${P}/a/plugins/b/core/y.test.ts`, "a.b", "failing"),
  file(`${P}/a/plugins/b/core/z.test.ts`, "a.b", "stale"),
  file(`${P}/c/core/w.test.ts`, "c", "never"),
];

describe("buildTestTree", () => {
  const rows = buildTestTree(FILES);
  const byId = new Map(rows.map((r) => [r.id, r]));

  test("one plugin row per plugin on the way to a file, child plugins before files", () => {
    expect(rows.map((r) => r.id)).toEqual([
      "plugin:a",
      "plugin:a.b",
      `file:${P}/a/plugins/b/core/y.test.ts`,
      `file:${P}/a/plugins/b/core/z.test.ts`,
      `file:${P}/a/core/x.test.ts`,
      "plugin:c",
      `file:${P}/c/core/w.test.ts`,
    ]);
    expect(byId.get("plugin:a.b")!.parentId).toBe("plugin:a");
    expect(byId.get(`file:${P}/a/core/x.test.ts`)!.parentId).toBe("plugin:a");
  });

  test("a plugin carries its subtree's counts and worst status", () => {
    const a = byId.get("plugin:a") as PluginRow;
    expect(a.fileCount).toBe(3);
    expect(a.counts.failing).toBe(1);
    expect(a.counts.passing).toBe(1);
    expect(a.status).toBe("failing");
    expect((byId.get("plugin:c") as PluginRow).status).toBe("never");
  });

  test("siblings are ranked in order", () => {
    const kids = rows.filter((r) => r.parentId === "plugin:a");
    const ranks = kids.map((r) => String(r.rank));
    expect([...ranks].sort()).toEqual(ranks);
  });

  test("a file is labelled below its plugin's folder", () => {
    expect(fileLabel(`${P}/a/plugins/b/core/y.test.ts`, "a.b")).toBe(
      "core/y.test.ts",
    );
  });

  test("countStatuses counts every file once", () => {
    expect(countStatuses(FILES)).toEqual({
      failing: 1,
      flaky: 0,
      stale: 1,
      passing: 1,
      never: 1,
    });
  });
});
