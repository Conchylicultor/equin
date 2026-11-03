/**
 * The safety net: a run that ends closes its ledger row, whether or not any
 * workflow is alive to hear about it.
 *
 * This is the regression guard for a hole an earlier draft of this plugin had.
 * When `finish` only announced, the job handler was the sole thing that could
 * stamp a row — so a workflow that died between spawning its child and
 * recording that it did left the row open forever, and the kind's partial unique
 * in-flight index then refused every future run of that kind, permanently and
 * silently.
 */
import { describe, expect, test } from "bun:test";
import type { RunTerminal } from "../../core";
import { finishSupervisedRun } from "./finish";

const TERMINAL: RunTerminal = {
  exitCode: 1,
  signalCode: null,
  finishedAt: new Date("2026-09-02T12:00:00Z"),
};

describe("finishSupervisedRun", () => {
  test("closes the row with the observed outcome, then announces", async () => {
    const order: string[] = [];
    const closed: { runId: string; terminal: RunTerminal }[] = [];

    await finishSupervisedRun(
      {
        closeRow: (runId, terminal) => {
          order.push("close");
          closed.push({ runId, terminal });
          return Promise.resolve();
        },
        announce: () => {
          order.push("announce");
          return Promise.resolve();
        },
      },
      "run-1",
      TERMINAL,
    );

    expect(order).toEqual(["close", "announce"]);
    expect(closed).toEqual([{ runId: "run-1", terminal: TERMINAL }]);
  });

  test("a failed announcement still leaves a closed row behind it", async () => {
    // The announcement is a DB write, so it can fail — and it is also the only
    // thing that ever reaches the workflow. If the close depended on it, one
    // failed emit would wedge the kind. Ordering close first is what makes that
    // impossible rather than unlikely.
    let closes = 0;

    // Reported, not swallowed: the reconciler files it per-run and carries on.
    expect(
      finishSupervisedRun(
        {
          closeRow: () => {
            closes += 1;
            return Promise.resolve();
          },
          announce: () => Promise.reject(new Error("emit failed")),
        },
        "run-2",
        TERMINAL,
      ),
    ).rejects.toMatchObject({ message: "emit failed" });

    expect(closes).toBe(1);
  });

  test("the row is closed with no workflow involved at all", async () => {
    // What a dead workflow's run looks like from here: nothing resumes, nothing
    // runs `onEnded`, and the row is closed anyway — so the next claim can win.
    const closed: string[] = [];

    await finishSupervisedRun(
      {
        closeRow: (runId) => {
          closed.push(runId);
          return Promise.resolve();
        },
        announce: () => Promise.resolve(),
      },
      "orphan-run",
      TERMINAL,
    );

    expect(closed).toEqual(["orphan-run"]);
  });
});
