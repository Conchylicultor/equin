import { describe, expect, test } from "bun:test";
import {
  BASELINE_MODELS,
  ModelChoiceSchema,
  ModelUnavailableError,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  dropTask,
  editTask,
  type ManageTasksPorts,
  type TaskEdit,
} from "./manage-tasks";

// The `edit_task` / `drop_task` scope policy over an in-memory store: only the
// tasks of the caller's own mandate tree, below its root.

const SUP = "conv-sup";
// R (root, the supervisor's task) ⊃ A, B ⊃ N (names a mandate of its own) ⊃ M.
// X is another tree's root, Y under it.
const roots: Record<string, string> = {
  R: "R",
  A: "R",
  B: "R",
  N: "N",
  M: "N",
  X: "X",
  Y: "X",
};

const DEFAULT = ModelChoiceSchema.parse("opus");
// The caller's filing default for a sidequest (a grant per track).
const SIDEQUEST_DEFAULT = ModelChoiceSchema.parse("sonnet");
// A is a sidequest; every other task is main.
const tracks: Record<string, "main" | "sidequest"> = { A: "sidequest" };

function store(callerRoot: string | null = "R") {
  const applied: TaskEdit[] = [];
  // B cannot be armed (an open attempt).
  const unarmable: Record<string, string> = {
    B: "B already has an open attempt",
  };
  const dropped: string[] = [];
  let cycle = false;
  const ports: ManageTasksPorts = {
    callerRoot: async (id) => (id === SUP ? callerRoot : null),
    rootOf: async (id) =>
      id in roots
        ? { kind: "found", rootTaskId: roots[id]! }
        : { kind: "not-found" },
    unarmable: async (id) => unarmable[id] ?? null,
    trackOf: async (id) => tracks[id] ?? "main",
    defaultModel: async (_conv, track) =>
      track === "sidequest" ? SIDEQUEST_DEFAULT : DEFAULT,
    modelCatalog: () => BASELINE_MODELS,
    apply: async (edit) => {
      if (cycle)
        return { ok: false, message: "Cycle detected in dependencies" };
      applied.push(edit);
      return { ok: true };
    },
    drop: async (id) => {
      dropped.push(id);
    },
  };
  return {
    ports,
    applied,
    dropped,
    closeCycle: () => {
      cycle = true;
    },
  };
}

describe("edit_task", () => {
  test("a task of its tree: title, description and dependencies in one edit", async () => {
    const s = store();
    const out = await editTask(
      {
        task_id: "A",
        title: "New",
        description: null,
        add_after: [" B ", "B"],
      },
      SUP,
      s.ports,
    );
    expect(out).toEqual({
      kind: "edited",
      taskId: "A",
      changed: ["title", "description", "add_after"],
    });
    expect(s.applied).toEqual([
      {
        taskId: "A",
        title: "New",
        description: null,
        addAfter: ["B"],
        removeAfter: [],
      },
    ]);
  });

  test("refused outside the tree, on the root, in a nested mandate, unknown id — nothing written", async () => {
    const s = store();
    const cases = await Promise.all([
      editTask({ task_id: "Y", title: "x" }, SUP, s.ports),
      editTask({ task_id: "R", title: "x" }, SUP, s.ports),
      editTask({ task_id: "M", title: "x" }, SUP, s.ports),
      editTask({ task_id: "A", add_after: ["Y"] }, SUP, s.ports),
      editTask({ task_id: "A", remove_after: ["R"] }, SUP, s.ports),
      editTask({ task_id: "nope", title: "x" }, SUP, s.ports),
    ]);
    expect(cases.map((c) => c.kind === "refused" && c.reason)).toEqual([
      "not-in-tree",
      "root",
      "not-in-tree",
      "not-in-tree",
      "root",
      "not-found",
    ]);
    expect(s.applied).toEqual([]);
  });

  test("no tree, nothing to change, self-dependency, add+remove the same id, a cycle", async () => {
    const s = store(null);
    expect(
      await editTask({ task_id: "A", title: "x" }, SUP, s.ports),
    ).toMatchObject({
      reason: "no-tree",
    });
    const t = store();
    expect(await editTask({ task_id: "A" }, SUP, t.ports)).toMatchObject({
      reason: "empty",
    });
    expect(
      await editTask({ task_id: "A", add_after: ["A"] }, SUP, t.ports),
    ).toMatchObject({ reason: "conflict" });
    expect(
      await editTask(
        { task_id: "A", add_after: ["B"], remove_after: ["B"] },
        SUP,
        t.ports,
      ),
    ).toMatchObject({ reason: "conflict" });
    t.closeCycle();
    expect(
      await editTask({ task_id: "A", add_after: ["B"] }, SUP, t.ports),
    ).toMatchObject({
      reason: "conflict",
      message: expect.stringContaining("Cycle"),
    });
  });
});

describe("edit_task start", () => {
  test("arms a task of its tree (any track) with the default model, or the one named", async () => {
    const s = store();
    expect(
      await editTask({ task_id: "A", start: "armed" }, SUP, s.ports),
    ).toEqual({ kind: "edited", taskId: "A", changed: ["start armed"] });
    const sonnet = ModelChoiceSchema.parse("sonnet");
    await editTask(
      { task_id: "A", start: "armed", model: sonnet, add_after: ["B"] },
      SUP,
      s.ports,
    );
    expect(s.applied.map((e) => e.start)).toEqual([
      { kind: "armed", model: SIDEQUEST_DEFAULT },
      { kind: "armed", model: sonnet },
    ]);
    expect(s.applied[1]!.addAfter).toEqual(["B"]);
  });

  test("arming keeps the track; `track` moves it, and the arm defaults to the new track's model", async () => {
    const s = store();
    await editTask({ task_id: "A", start: "armed" }, SUP, s.ports);
    expect(s.applied[0]!.track).toBeUndefined();
    expect(
      await editTask(
        { task_id: "A", start: "armed", track: "main" },
        SUP,
        s.ports,
      ),
    ).toEqual({
      kind: "edited",
      taskId: "A",
      changed: ["track main", "start armed"],
    });
    expect(s.applied[1]).toMatchObject({
      track: "main",
      start: { kind: "armed", model: DEFAULT },
    });
    expect(
      await editTask({ task_id: "B", track: "sidequest" }, SUP, s.ports),
    ).toEqual({ kind: "edited", taskId: "B", changed: ["track sidequest"] });
    expect(s.applied[2]!.start).toBeUndefined();
  });

  test("manual disarms", async () => {
    const s = store();
    expect(
      await editTask({ task_id: "B", start: "manual" }, SUP, s.ports),
    ).toMatchObject({ kind: "edited", changed: ["start manual"] });
    expect(s.applied[0]!.start).toEqual({ kind: "manual" });
  });

  test("refused before anything is written: unarmable, model without armed, unknown version, outside the tree", async () => {
    const s = store();
    expect(
      await editTask(
        { task_id: "B", start: "armed", title: "x" },
        SUP,
        s.ports,
      ),
    ).toMatchObject({ reason: "not-armable" });
    expect(
      await editTask(
        { task_id: "A", model: ModelChoiceSchema.parse("sonnet") },
        SUP,
        s.ports,
      ),
    ).toMatchObject({ reason: "conflict" });
    expect(
      await editTask(
        { task_id: "A", start: "manual", model: DEFAULT },
        SUP,
        s.ports,
      ),
    ).toMatchObject({ reason: "conflict" });
    expect(
      await editTask({ task_id: "Y", start: "armed" }, SUP, s.ports),
    ).toMatchObject({ reason: "not-in-tree" });
    expect(
      editTask(
        {
          task_id: "A",
          start: "armed",
          model: ModelChoiceSchema.parse("sonnet-9"),
        },
        SUP,
        s.ports,
      ),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
    expect(s.applied).toEqual([]);
  });
});

describe("drop_task", () => {
  test("drops a task of its tree; refuses the root and another tree's task", async () => {
    const s = store();
    expect(await dropTask({ task_id: "B" }, SUP, s.ports)).toEqual({
      kind: "dropped",
      taskId: "B",
    });
    expect(await dropTask({ task_id: "R" }, SUP, s.ports)).toMatchObject({
      reason: "root",
    });
    expect(await dropTask({ task_id: "Y" }, SUP, s.ports)).toMatchObject({
      reason: "not-in-tree",
    });
    expect(s.dropped).toEqual(["B"]);
  });
});
