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

// The `edit_task` / `drop_task` policy over an in-memory store: a caller
// manages only the tasks it owns — a supervisor its tree (and what its role
// owns beyond it), any other agent what it filed.

const SUP = "conv-sup";
const AGENT = "conv-agent";
// SUP's task is R, a supervisor root: it owns A and B (its tree) and Z
// (another tree's root its role owns). N names a mandate of its own (M below
// it, not SUP's); X is another tree's root, Y under it.
// AGENT's task is I (interactive): it filed S and T; a person filed H beside
// them; another agent filed O.
const roots: Record<string, string> = {
  R: "R",
  A: "R",
  B: "R",
  N: "N",
  M: "N",
  X: "X",
  Y: "X",
  Z: "Z",
  I: "I",
  S: "I",
  T: "I",
  H: "I",
  O: "I",
};
const callerTasks: Record<string, string> = { [SUP]: "R", [AGENT]: "I" };
/** Who owns each task: the conversation acting as its owner, else its owner
 * in words. */
const owners: Record<string, { by: string } | { label: string }> = {
  A: { by: SUP },
  B: { by: SUP },
  Z: { by: SUP },
  M: { label: "owned by the supervisor of task N" },
  N: { label: "filed by a person" },
  X: { label: "filed by a person" },
  Y: { label: "filed by a person" },
  S: { by: AGENT },
  T: { by: AGENT },
  H: { label: "filed by a person" },
  O: { label: "filed by the agent of task Q" },
  R: { label: "filed by a person" },
  I: { label: "filed by a person" },
};

const DEFAULT = ModelChoiceSchema.parse("opus");
// The caller's filing default for a sidequest (a grant per track).
const SIDEQUEST_DEFAULT = ModelChoiceSchema.parse("sonnet");
// A and S are sidequests; every other task is main.
const tracks: Record<string, "main" | "sidequest"> = {
  A: "sidequest",
  S: "sidequest",
};

function store(
  opts: { callerTask?: string | null; handOffRefused?: string } = {},
) {
  const applied: TaskEdit[] = [];
  // B's agent already launched (an open attempt).
  const launched = new Set(["B"]);
  const unarmable: Record<string, string> = {};
  const dropped: string[] = [];
  let cycle = false;
  const ports: ManageTasksPorts = {
    callerTask: async (conv) =>
      opts.callerTask !== undefined
        ? opts.callerTask
        : (callerTasks[conv] ?? null),
    ownerOf: async (conv, id) => {
      const owner = owners[id];
      if (owner === undefined) return { kind: "not-found" };
      if ("by" in owner)
        return owner.by === conv
          ? { kind: "owned" }
          : { kind: "not-owned", owner: "filed by another agent" };
      return { kind: "not-owned", owner: owner.label };
    },
    // Only the supervisor holds tasks.manage; both may hand off.
    canManage: async (conv) => conv === SUP,
    canHandOff: async () => true,
    callerRoot: async (conv) => callerTasks[conv] ?? null,
    rootOf: async (id) =>
      id in roots
        ? { kind: "found", rootTaskId: roots[id]! }
        : { kind: "not-found" },
    unarmable: async (id) => unarmable[id] ?? null,
    launched: async (id) => launched.has(id),
    trackOf: async (id) => tracks[id] ?? "main",
    defaultModel: async (_conv, track) =>
      track === "sidequest" ? SIDEQUEST_DEFAULT : DEFAULT,
    modelCatalog: () => BASELINE_MODELS,
    apply: async (edit) => {
      if (cycle)
        return { ok: false, message: "Cycle detected in dependencies" };
      if (edit.handOff && opts.handOffRefused)
        return { ok: false, message: opts.handOffRefused };
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

  test("refused when not its own, on its own task, in a nested mandate, unknown id — nothing written", async () => {
    const s = store();
    const cases = await Promise.all([
      editTask({ task_id: "Y", title: "x" }, SUP, s.ports),
      editTask({ task_id: "R", title: "x" }, SUP, s.ports),
      editTask({ task_id: "M", title: "x" }, SUP, s.ports),
      editTask({ task_id: "A", add_after: ["Y"] }, SUP, s.ports),
      editTask({ task_id: "R", remove_after: ["A"] }, SUP, s.ports),
      editTask({ task_id: "nope", title: "x" }, SUP, s.ports),
    ]);
    expect(cases.map((c) => c.kind === "refused" && c.reason)).toEqual([
      "not-owner",
      "root",
      "not-owner",
      "not-owner",
      "root",
      "not-found",
    ]);
    expect(s.applied).toEqual([]);
  });

  test("the root as the other end of a dependency: a task below it stops (or starts) waiting on it", async () => {
    // add_task once wired a supervisor's task after the root by default; the
    // root stays in progress all session, so only this edit frees the task.
    const s = store();
    expect(
      await editTask({ task_id: "A", remove_after: ["R"] }, SUP, s.ports),
    ).toEqual({ kind: "edited", taskId: "A", changed: ["remove_after"] });
    expect(
      await editTask({ task_id: "A", add_after: ["R"] }, SUP, s.ports),
    ).toEqual({ kind: "edited", taskId: "A", changed: ["add_after"] });
    expect(s.applied).toEqual([
      { taskId: "A", addAfter: [], removeAfter: ["R"] },
      { taskId: "A", addAfter: ["R"], removeAfter: [] },
    ]);
  });

  test("no task, nothing to change, self-dependency, add+remove the same id, a cycle", async () => {
    const s = store({ callerTask: null });
    expect(
      await editTask({ task_id: "A", title: "x" }, SUP, s.ports),
    ).toMatchObject({
      reason: "no-task",
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

describe("edit_task on a task whose agent already launched", () => {
  test("add_after is refused (it would hold back nothing), naming message_agent; the rest still edits", async () => {
    const s = store();
    const out = await editTask(
      { task_id: "B", add_after: ["A"], title: "x" },
      SUP,
      s.ports,
    );
    expect(out).toMatchObject({ kind: "refused", reason: "launched" });
    expect(out.kind === "refused" && out.message).toContain("message_agent");
    expect(s.applied).toEqual([]);
    expect(
      await editTask(
        { task_id: "B", title: "x", remove_after: ["A"] },
        SUP,
        s.ports,
      ),
    ).toMatchObject({ kind: "edited" });
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
    ).toMatchObject({ reason: "not-owner" });
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
  test("drops a task of its tree; refuses its own task and another tree's task", async () => {
    const s = store();
    expect(await dropTask({ task_id: "B" }, SUP, s.ports)).toEqual({
      kind: "dropped",
      taskId: "B",
    });
    expect(await dropTask({ task_id: "R" }, SUP, s.ports)).toMatchObject({
      reason: "root",
    });
    expect(await dropTask({ task_id: "Y" }, SUP, s.ports)).toMatchObject({
      reason: "not-owner",
    });
    expect(s.dropped).toEqual(["B"]);
  });
});

describe("a supervisor's tasks beyond its tree (its role owns them)", () => {
  test("a task outside the tree it owns is managed; others are still refused", async () => {
    const s = store();
    expect(await dropTask({ task_id: "Z" }, SUP, s.ports)).toEqual({
      kind: "dropped",
      taskId: "Z",
    });
    expect(
      await editTask({ task_id: "A", add_after: ["Z"] }, SUP, s.ports),
    ).toMatchObject({ kind: "edited" });
    expect(await dropTask({ task_id: "X" }, SUP, s.ports)).toMatchObject({
      reason: "not-owner",
    });
  });

  test("an owned task beyond the tree is never armed: that would launch it outside the tree", async () => {
    const s = store();
    expect(
      await editTask({ task_id: "Z", start: "armed" }, SUP, s.ports),
    ).toMatchObject({ kind: "refused", reason: "not-in-tree" });
    expect(s.applied).toEqual([]);
  });
});

describe("an agent manages what it filed", () => {
  test("edits and drops its own sidequests, and frees one from waiting on its task", async () => {
    const s = store();
    expect(
      await editTask(
        { task_id: "S", title: "Sharper", description: "More context" },
        AGENT,
        s.ports,
      ),
    ).toEqual({
      kind: "edited",
      taskId: "S",
      changed: ["title", "description"],
    });
    expect(
      await editTask(
        { task_id: "S", add_after: ["T"], remove_after: ["I"] },
        AGENT,
        s.ports,
      ),
    ).toMatchObject({ kind: "edited" });
    expect(await dropTask({ task_id: "T" }, AGENT, s.ports)).toEqual({
      kind: "dropped",
      taskId: "T",
    });
    expect(s.dropped).toEqual(["T"]);
  });

  test("never a task a person or another agent filed — the refusal names the owner", async () => {
    const s = store();
    const person = await editTask({ task_id: "H", title: "x" }, AGENT, s.ports);
    expect(person).toMatchObject({
      reason: "not-owner",
      message: expect.stringContaining("filed by a person"),
    });
    expect(await dropTask({ task_id: "O" }, AGENT, s.ports)).toMatchObject({
      reason: "not-owner",
      message: expect.stringContaining("filed by the agent of task Q"),
    });
    // Nor a supervisor's, nor wiring its own task after a task not its own.
    expect(await dropTask({ task_id: "A" }, AGENT, s.ports)).toMatchObject({
      reason: "not-owner",
    });
    expect(
      await editTask({ task_id: "S", add_after: ["H"] }, AGENT, s.ports),
    ).toMatchObject({ reason: "not-owner" });
    expect(s.applied).toEqual([]);
    expect(s.dropped).toEqual([]);
  });

  test("start and track stay a supervisor's", async () => {
    const s = store();
    for (const input of [
      { task_id: "S", start: "armed" as const },
      { task_id: "S", start: "manual" as const },
      { task_id: "S", track: "main" as const, title: "x" },
    ])
      expect(await editTask(input, AGENT, s.ports)).toMatchObject({
        reason: "not-permitted",
      });
    expect(s.applied).toEqual([]);
  });
});

describe("edit_task supervisor: the hand-off", () => {
  test("hands a task to a role with new context, in one edit", async () => {
    const s = store();
    expect(
      await editTask(
        {
          task_id: "S",
          description: "What I learned",
          supervisor: "srole-follow-ups",
        },
        AGENT,
        s.ports,
      ),
    ).toEqual({
      kind: "edited",
      taskId: "S",
      changed: ["description", "handed to srole-follow-ups"],
    });
    expect(s.applied).toEqual([
      {
        taskId: "S",
        description: "What I learned",
        addAfter: [],
        removeAfter: [],
        handOff: {
          supervisor: "srole-follow-ups",
          conversationId: AGENT,
          fromTaskId: "I",
        },
      },
    ]);
  });

  test("refused: not its own, armed or wired after something, the backlog refusing, no grant", async () => {
    const s = store();
    expect(
      await editTask({ task_id: "H", supervisor: "srole-x" }, AGENT, s.ports),
    ).toMatchObject({ reason: "not-owner" });
    expect(
      await editTask(
        { task_id: "S", supervisor: "srole-x", add_after: ["T"] },
        AGENT,
        s.ports,
      ),
    ).toMatchObject({ reason: "conflict" });
    expect(
      await editTask(
        { task_id: "A", supervisor: "srole-x", start: "armed" },
        SUP,
        s.ports,
      ),
    ).toMatchObject({ reason: "conflict" });
    const refusing = store({ handOffRefused: "No listed supervisor role" });
    expect(
      await editTask(
        { task_id: "S", supervisor: "srole-x" },
        AGENT,
        refusing.ports,
      ),
    ).toMatchObject({
      reason: "conflict",
      message: "No listed supervisor role",
    });
    const noGrant = store();
    noGrant.ports.canHandOff = async () => false;
    expect(
      await editTask(
        { task_id: "S", supervisor: "srole-x" },
        AGENT,
        noGrant.ports,
      ),
    ).toMatchObject({ reason: "not-permitted" });
    expect([...s.applied, ...refusing.applied, ...noGrant.applied]).toEqual([]);
  });
});
