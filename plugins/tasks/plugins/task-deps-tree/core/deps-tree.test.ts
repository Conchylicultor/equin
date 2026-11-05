import { describe, expect, test } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import type { TaskListItem, TaskStatus } from "@plugins/tasks/plugins/tasks-core/core";
import { buildDepsTree, type DepsTreeRow } from "./deps-tree";
import { taskClusterIds } from "./cluster";

// Minimal TaskListItem factory. `deps` is `task.dependencies` (dependent →
// dependency), OLDEST edge first — the tasks_v ordering buildDepsTree relies on
// for the primary-parent pick. `folderId` is the creation ("created under") edge.
// `clusterId` is the persisted membership label (see cluster.ts); `null` — the
// default — means "never unioned", i.e. its own singleton cluster.
function task(
  id: string,
  deps: string[] = [],
  opts: {
    folderId?: string | null;
    status?: TaskStatus;
    clusterId?: string;
  } = {},
): TaskListItem {
  const status = opts.status ?? "new";
  return {
    id,
    folderId: opts.folderId ?? null,
    groupId: null,
    clusterId: opts.clusterId ?? id,
    title: id,
    titleAuto: true,
    author: "user",
    droppedAt: null,
    heldAt: null,
    rank: Rank.from("a0"),
    createdAt: new Date("2026-07-10T00:00:00Z"),
    updatedAt: new Date("2026-07-10T00:00:00Z"),
    status,
    active: !["done", "dropped"].includes(status),
    finishedAt: null,
    dependencies: deps,
  };
}

// Index the derived rows by id for assertions.
function byId(rows: DepsTreeRow[]): Map<string, DepsTreeRow> {
  return new Map(rows.map((r) => [r.id, r]));
}

function parent(rows: DepsTreeRow[], id: string): string | null {
  return byId(rows).get(id)!.depsParentId;
}

function extras(rows: DepsTreeRow[], id: string): string[] {
  return byId(rows).get(id)!.extraDeps.map((t) => t.id);
}

const members = (...ids: string[]) => new Set(ids);

// Membership is no longer a graph walk over live edges — it is a filter on the
// persisted `clusterId` label (`clusterId ?? id`). These tests pin the LABEL
// semantics only; that the label is written monotonically (grows on edge
// creation, never shrinks on removal) is a server-side property, proven in
// `tasks-core/server/internal/mutations/clusters.test.ts` and
// `tasks/server/internal/deps-tree-move.test.ts`.
describe("taskClusterIds", () => {
  test("same label ⇒ member; different label ⇒ not a member", () => {
    const tasks = [
      task("A", [], { clusterId: "A" }),
      task("B", [], { clusterId: "A" }),
      task("Z", [], { clusterId: "Z" }),
    ];
    expect(taskClusterIds(tasks, "A")).toEqual(members("A", "B"));
    expect(taskClusterIds(tasks, "B")).toEqual(members("A", "B"));
    expect(taskClusterIds(tasks, "Z")).toEqual(members("Z"));
  });

  test("membership ignores live edges entirely — only the label decides", () => {
    // B depends on A and was created under A, yet carries a different label:
    // the edges are irrelevant to the set. (In production the union at edge
    // creation makes this state unreachable; the point is that the READ never
    // second-guesses the persisted label.)
    const tasks = [
      task("A", [], { clusterId: "A" }),
      task("B", ["A"], { folderId: "A", clusterId: "other" }),
    ];
    expect(taskClusterIds(tasks, "A")).toEqual(members("A"));
  });

  test("a null label is a SINGLETON — two unlabelled tasks are not grouped", () => {
    // The load-bearing case for `clusterId ?? id`. NULL means "never unioned",
    // so each such task is its own cluster. Reading NULL as a shared label
    // (e.g. grouping on the raw column) would fuse every never-unioned task in
    // the DB — today over half of them — into one phantom mega-cluster.
    const tasks = [task("A"), task("B"), task("C", [], { clusterId: "C" })];
    expect(taskClusterIds(tasks, "A")).toEqual(members("A"));
    expect(taskClusterIds(tasks, "B")).toEqual(members("B"));
  });

  test("a null-label root still collects tasks labelled with its own id", () => {
    // The asymmetric shape the union leaves behind: `min(id)` wins, so the
    // winner keeps `NULL` (never rewritten) while the loser is stamped with the
    // winner's id. Both must still read as one cluster.
    const tasks = [task("A"), task("B", [], { clusterId: "A" })];
    expect(taskClusterIds(tasks, "A")).toEqual(members("A", "B"));
    expect(taskClusterIds(tasks, "B")).toEqual(members("A", "B"));
  });

  test("the root is always a member of its own cluster", () => {
    const tasks = [task("A"), task("B", [], { clusterId: "B" })];
    expect(taskClusterIds(tasks, "A")).toContain("A");
    expect(taskClusterIds(tasks, "B")).toContain("B");
  });

  test("unknown root yields empty", () => {
    expect(taskClusterIds([task("A")], "missing")).toEqual(new Set());
  });

  test("detaching a dependency edge does not change the member set", () => {
    // The rule the deps tree must obey: rewiring the tree NEVER changes the set
    // of tasks it lists, only their nesting. Client-side this is now trivially
    // true — the read does not look at `dependencies` at all — so this case is
    // kept only as a statement of intent.
    //
    // THE REAL GUARD IS SERVER-SIDE: that the label survives an edge removal is
    // a property of the WRITE path, and it is proven in
    // `plugins/tasks/server/internal/deps-tree-move.test.ts`
    // ("a root-drop must not eject the moved task from its cluster") and in
    // `tasks-core/server/internal/mutations/clusters.test.ts`
    // ("union is monotone: removing the edge does not un-union"). Do not delete
    // those without replacing this guarantee.
    const before = [
      task("A", [], { clusterId: "A" }),
      task("B", ["A"], { folderId: "A", clusterId: "A" }),
      task("C", ["B"], { folderId: "A", clusterId: "A" }),
    ];
    const after = [
      task("A", [], { clusterId: "A" }),
      task("B", ["A"], { folderId: "A", clusterId: "A" }),
      task("C", [], { folderId: "A", clusterId: "A" }),
    ];
    for (const seed of ["A", "B", "C"]) {
      expect(taskClusterIds(before, seed)).toEqual(members("A", "B", "C"));
      expect(taskClusterIds(after, seed)).toEqual(members("A", "B", "C"));
    }
  });
});

describe("buildDepsTree", () => {
  test("linear chain: each task nests under its single prerequisite", () => {
    const tasks = [task("A"), task("B", ["A"]), task("C", ["B"])];
    const rows = buildDepsTree(tasks, members("A", "B", "C"));

    expect(new Set(rows.map((r) => r.id))).toEqual(new Set(["A", "B", "C"]));
    expect(parent(rows, "A")).toBeNull();
    expect(parent(rows, "B")).toBe("A");
    expect(parent(rows, "C")).toBe("B");
    for (const r of rows) expect(r.extraDeps).toEqual([]);
  });

  test("fan-out: parallel children share one parent", () => {
    const tasks = [task("A"), task("B", ["A"]), task("C", ["A"])];
    const rows = buildDepsTree(tasks, members("A", "B", "C"));

    expect(parent(rows, "B")).toBe("A");
    expect(parent(rows, "C")).toBe("A");
  });

  test("fan-in: primary parent is the oldest edge, the rest become chips", () => {
    const tasks = [task("A"), task("B"), task("C"), task("D", ["A", "B", "C"])];
    const rows = buildDepsTree(tasks, members("A", "B", "C", "D"));

    expect(parent(rows, "D")).toBe("A");
    expect(extras(rows, "D")).toEqual(["B", "C"]);
  });

  test("diamond: bottom task fans in, top fans out", () => {
    const tasks = [
      task("A"),
      task("B", ["A"]),
      task("C", ["A"]),
      task("D", ["B", "C"]),
    ];
    const rows = buildDepsTree(tasks, members("A", "B", "C", "D"));

    expect(parent(rows, "B")).toBe("A");
    expect(parent(rows, "C")).toBe("A");
    expect(parent(rows, "D")).toBe("B");
    expect(extras(rows, "D")).toEqual(["C"]);
  });

  test("a settled task in the middle of a chain still gets a row", () => {
    const tasks = [task("A"), task("B", ["A"], { status: "done" }), task("C", ["B"])];
    const rows = buildDepsTree(tasks, members("A", "B", "C"));

    expect(byId(rows).get("B")!.status).toBe("done");
    expect(parent(rows, "B")).toBe("A");
    expect(parent(rows, "C")).toBe("B");
  });

  test("a creation-only member (no in-cluster deps) renders as a root", () => {
    // Y is in the set only because it was created under X; it has no dependency,
    // so it has no primary parent and surfaces as an independent root here.
    const tasks = [task("X"), task("Y", [], { folderId: "X" })];
    const rows = buildDepsTree(tasks, members("X", "Y"));

    expect(parent(rows, "X")).toBeNull();
    expect(parent(rows, "Y")).toBeNull();
    expect(extras(rows, "Y")).toEqual([]);
  });

  test("dependencies pointing outside the member set are ignored", () => {
    const tasks = [task("A", ["ghost"]), task("B", ["A"])];
    const rows = buildDepsTree(tasks, members("A", "B"));

    expect(parent(rows, "A")).toBeNull();
    expect(extras(rows, "A")).toEqual([]);
    expect(parent(rows, "B")).toBe("A");
  });

  test("ids in the set but absent from the task list are skipped", () => {
    const rows = buildDepsTree([task("A")], members("A", "missing"));
    expect(rows.map((r) => r.id)).toEqual(["A"]);
  });
});
