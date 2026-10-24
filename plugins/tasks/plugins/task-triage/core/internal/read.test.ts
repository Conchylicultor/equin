/**
 * A triage row parses into the arm of its state, and a row that breaks the
 * state ⇄ fields contract throws instead of reading as a half-read.
 *
 * Run: `./singularity test plugins/tasks/plugins/task-triage`.
 */

import { describe, expect, test } from "bun:test";
import { latestTriageResult, parseTriageRead, TriageRowError } from "./read";
import { TaskTriageRowSchema, type TaskTriageRow } from "./resources";

const REQUESTED = new Date("2026-10-20T10:00:00Z");
const TRIAGED = new Date("2026-10-20T10:05:00Z");

const EMPTY: TaskTriageRow = {
  taskId: "task-1",
  state: "queued",
  staleReason: null,
  conversationId: null,
  runTaskId: null,
  requestedAt: REQUESTED,
  startedAt: null,
  triagedAt: null,
  error: null,
  verdict: null,
  priority: null,
  taskType: null,
  risk: null,
  context: null,
  question: null,
  answers: [],
  answer: null,
  areas: [],
  mainSha: null,
};

const RESULT = {
  triagedAt: TRIAGED,
  verdict: "ready",
  priority: "should",
  taskType: "bugfix",
  risk: "low",
  context: "The badge is off by one.",
  question: "Fix the count or the label?",
  answers: ["The count", "The label"],
  areas: ["tasks/task-list"],
  mainSha: "abc123",
} satisfies Partial<TaskTriageRow>;

function row(patch: Partial<TaskTriageRow>): TaskTriageRow {
  return { ...EMPTY, ...patch };
}

describe("parseTriageRead", () => {
  test("the fixture is a wire row", () => {
    expect(TaskTriageRowSchema.parse(EMPTY)).toEqual(EMPTY);
  });

  test("queued, first run: no previous read", () => {
    expect(parseTriageRead(EMPTY)).toEqual({
      taskId: "task-1",
      conversationId: null,
      runTaskId: null,
      requestedAt: REQUESTED,
      state: "queued",
      startedAt: null,
      previous: null,
    });
  });

  test("running a re-run keeps the read it replaces as `previous`", () => {
    const started = new Date("2026-10-21T09:00:00Z");
    const read = parseTriageRead(
      row({
        ...RESULT,
        state: "running",
        startedAt: started,
        conversationId: "conv-2",
      }),
    );
    expect(read.state).toBe("running");
    if (read.state !== "running") throw new Error("unreachable");
    expect(read.startedAt).toEqual(started);
    expect(read.previous?.priority).toBe("should");
    expect(read.conversationId).toBe("conv-2");
  });

  test("failed carries its error", () => {
    const read = parseTriageRead(row({ state: "failed", error: "boom" }));
    expect(read).toMatchObject({
      state: "failed",
      error: "boom",
      previous: null,
    });
  });

  test("done carries the whole read", () => {
    const read = parseTriageRead(
      row({ ...RESULT, state: "done", answer: "The count" }),
    );
    expect(read).toMatchObject({
      state: "done",
      read: { ...RESULT, answer: "The count" },
    });
  });

  test("stale carries its reason and the read", () => {
    const read = parseTriageRead(
      row({ ...RESULT, state: "stale", staleReason: "edited" }),
    );
    expect(read).toMatchObject({
      state: "stale",
      staleReason: "edited",
      read: { priority: "should" },
    });
  });

  test("a done row missing its priority throws", () => {
    expect(() =>
      parseTriageRead(row({ ...RESULT, state: "done", priority: null })),
    ).toThrow(TriageRowError);
    expect(() =>
      parseTriageRead(row({ ...RESULT, state: "done", priority: null })),
    ).toThrow(/missing priority/);
  });

  test("a done row with no result throws", () => {
    expect(() => parseTriageRead(row({ state: "done" }))).toThrow(
      /has no result/,
    );
  });

  test("a stale row without its reason throws", () => {
    expect(() => parseTriageRead(row({ ...RESULT, state: "stale" }))).toThrow(
      /has no reason/,
    );
  });

  test("a failed row without its error throws", () => {
    expect(() => parseTriageRead(row({ state: "failed" }))).toThrow(
      /has no error/,
    );
  });

  test("a partial result throws in any state", () => {
    expect(() =>
      parseTriageRead(row({ state: "queued", verdict: "ready" })),
    ).toThrow(TriageRowError);
  });
});

describe("latestTriageResult", () => {
  test("not triaged, or a first run in flight, ranks by nothing", () => {
    expect(latestTriageResult(null)).toBeNull();
    expect(latestTriageResult(parseTriageRead(EMPTY))).toBeNull();
  });

  test("a read in flight or failed still ranks by the read it replaces", () => {
    for (const state of ["queued", "running"] as const) {
      expect(
        latestTriageResult(parseTriageRead(row({ ...RESULT, state })))
          ?.priority,
      ).toBe("should");
    }
    expect(
      latestTriageResult(
        parseTriageRead(row({ ...RESULT, state: "failed", error: "x" })),
      )?.priority,
    ).toBe("should");
  });

  test("done and stale rank by their read", () => {
    expect(
      latestTriageResult(parseTriageRead(row({ ...RESULT, state: "done" })))
        ?.taskType,
    ).toBe("bugfix");
    expect(
      latestTriageResult(
        parseTriageRead(row({ ...RESULT, state: "stale", staleReason: "old" })),
      )?.taskType,
    ).toBe("bugfix");
  });
});
