import { describe, test, expect } from "bun:test";
import { computeStatusEmits, conversationStatusChange } from "./status-emit";
import type { TaskStatus } from "./schema";
import type { TaskStatusRow } from "./queries/tasks";

// The emission RULE, with no DB in sight: both readings are handed in, so every
// convention the emit path carries (gone, unchanged, first-time) is stated as an
// ordinary function call. The DB half — which tasks end up in those maps — is
// `status-closure.test.ts`.

const before = (
  entries: Record<string, TaskStatus | null>,
): Map<string, TaskStatus | null> => new Map(Object.entries(entries));

const after = (
  entries: Record<string, TaskStatus>,
  folderId: string | null = null,
): Map<string, TaskStatusRow> =>
  new Map(
    Object.entries(entries).map(([id, status]) => [id, { status, folderId }]),
  );

describe("computeStatusEmits", () => {
  test("an unchanged status emits nothing", () => {
    expect(
      computeStatusEmits(before({ a: "blocked" }), after({ a: "blocked" })),
    ).toEqual([]);
  });

  test("a task absent from `after` emits nothing — it is gone, not transitioned", () => {
    expect(computeStatusEmits(before({ a: "new" }), after({}))).toEqual([]);
  });

  test("a first-time read (before === null) reports previousStatus = status", () => {
    expect(
      computeStatusEmits(before({ a: null }), after({ a: "new" })),
    ).toEqual([
      { taskId: "a", folderId: null, status: "new", previousStatus: "new" },
    ]);
  });

  test("a closure member that changed while the seed did not emits for the member only", () => {
    // The incident's shape: the seed (`b`, the detached edge's dependent end)
    // reads the same status either side of the write, while `c` — reachable only
    // through the closure — is the task that actually became launchable.
    expect(
      computeStatusEmits(
        before({ b: "dropped", c: "blocked" }),
        after({ b: "dropped", c: "new" }),
      ),
    ).toEqual([
      { taskId: "c", folderId: null, status: "new", previousStatus: "blocked" },
    ]);
  });

  test("the folder rides along from the `after` reading", () => {
    expect(
      computeStatusEmits(
        before({ a: "new" }),
        after({ a: "done" }, "folder-1"),
      ),
    ).toEqual([
      {
        taskId: "a",
        folderId: "folder-1",
        status: "done",
        previousStatus: "new",
      },
    ]);
  });
});

// `conversation.statusChanged`: the status column OR `waitingFor` moving is a
// change — a question answered while the agent stays `waiting` must still wake
// whoever holds a turn until it stops waiting (watch delivery, self-compact).
describe("conversationStatusChange", () => {
  const idle = { status: "waiting", waitingFor: null } as const;
  const asking = { status: "waiting", waitingFor: "question" } as const;

  test("nothing moved: no event", () => {
    expect(conversationStatusChange("c", "t", idle, idle)).toBeNull();
    expect(conversationStatusChange("c", "t", asking, asking)).toBeNull();
  });

  test("waitingFor cleared, status unchanged: an event saying so", () => {
    expect(conversationStatusChange("c", "t", asking, idle)).toEqual({
      conversationId: "c",
      taskId: "t",
      status: "waiting",
      previousStatus: "waiting",
      waitingFor: null,
      previousWaitingFor: "question",
    });
  });

  test("status moved: an event carrying both readings", () => {
    expect(
      conversationStatusChange(
        "c",
        null,
        { status: "working", waitingFor: null },
        asking,
      ),
    ).toEqual({
      conversationId: "c",
      taskId: null,
      status: "waiting",
      previousStatus: "working",
      waitingFor: "question",
      previousWaitingFor: null,
    });
  });

  test("first reading (previous null): previous = current", () => {
    expect(conversationStatusChange("c", "t", null, asking)).toEqual({
      conversationId: "c",
      taskId: "t",
      status: "waiting",
      previousStatus: "waiting",
      waitingFor: "question",
      previousWaitingFor: "question",
    });
  });
});
