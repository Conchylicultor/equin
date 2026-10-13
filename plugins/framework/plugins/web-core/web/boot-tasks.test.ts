import { describe, expect, test } from "bun:test";
import {
  runBootTasks,
  type BootTask,
  type BootTaskProblem,
  type BootTaskStatus,
} from "./boot-tasks";

const never = () => new Promise<void>(() => {});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function task(
  label: string,
  ifUnavailable: BootTask["ifUnavailable"],
  run: () => Promise<void>,
): BootTask {
  return { label, ifUnavailable, run };
}

function harness(
  tasks: BootTask[],
  opts: { holdOnBlocking?: boolean; deadlineMs?: number } = {},
) {
  const problems: BootTaskProblem[] = [];
  let last: readonly BootTaskStatus[] = [];
  let settled = false;
  const run = runBootTasks(tasks, {
    holdOnBlocking: opts.holdOnBlocking ?? true,
    deadlineMs: opts.deadlineMs ?? 20,
    onProblem: (p) => problems.push(p),
    onChange: (t) => {
      last = t;
    },
  });
  void run.settled.then(() => {
    settled = true;
  });
  return {
    run,
    problems,
    outcomes: () => last.map((t) => t.outcome.kind),
    isSettled: () => settled,
  };
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe("runBootTasks", () => {
  test("starts every task pending and settles once all are done", async () => {
    const h = harness([task("a", "block", async () => {})]);
    expect(h.run.initial.map((t) => t.outcome.kind)).toEqual(["pending"]);
    await h.run.settled;
    expect(h.outcomes()).toEqual(["done"]);
    expect(h.problems).toEqual([]);
  });

  test("a rejected block task is reported and holds boot", async () => {
    const h = harness([
      task("snap", "block", () => Promise.reject(new Error("HTTP 503"))),
    ]);
    await tick(5);
    expect(h.outcomes()).toEqual(["failed"]);
    expect(h.problems.map((p) => p.task.outcome)).toEqual([
      { kind: "failed", message: "HTTP 503" },
    ]);
    expect(h.isSettled()).toBe(false);
    h.run.continueAnyway();
    await h.run.settled;
  });

  test("an overdue block task holds boot, then settles when it finally resolves", async () => {
    const late = deferred();
    const h = harness([task("snap", "block", () => late.promise)]);
    await tick(40);
    expect(h.outcomes()).toEqual(["overdue"]);
    expect(h.problems).toHaveLength(1);
    expect(h.isSettled()).toBe(false);
    late.resolve();
    await h.run.settled;
    expect(h.outcomes()).toEqual(["done"]);
  });

  test("an overdue continue task is reported and does not hold boot", async () => {
    const h = harness([
      task("themes", "continue", never),
      task("snap", "block", async () => {}),
    ]);
    await tick(40);
    expect(h.isSettled()).toBe(true);
    expect(h.problems.map((p) => p.task.label)).toEqual(["themes"]);
  });

  test("without holdOnBlocking a failed block task only reports", async () => {
    const h = harness(
      [task("x", "block", () => Promise.reject(new Error("boom")))],
      { holdOnBlocking: false },
    );
    await h.run.settled;
    expect(h.problems).toHaveLength(1);
  });

  test("no tasks settles at once", async () => {
    await harness([]).run.settled;
  });
});
