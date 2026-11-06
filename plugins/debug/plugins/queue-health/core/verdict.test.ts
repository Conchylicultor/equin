import { describe, expect, test } from "bun:test";
import {
  HOLD_CLASSES,
  deadlineMsFor,
  pickupTargetMsFor,
  reachableSlots,
  type HoldClass,
} from "@plugins/infra/plugins/jobs/core";
import {
  attentionWaitMs,
  criticalWaitMs,
  formatThresholdMs,
  OK_SUMMARY,
  queueVerdict,
  stuckHoldMs,
  type QueueFacts,
  type QueueVerdictConfig,
} from "./verdict";

// Every line below is read from the class table or the helpers built on it —
// no duration is restated here, so the test keeps meaning the same thing if the
// table is retuned.

const NOW = 1_800_000_000_000;
const CFG: QueueVerdictConfig = {
  slotHogDeadlineFraction: 0.5,
  deadJobAttentionMinutes: 60,
};

type ClassFacts = QueueFacts["classes"][number];

function classFacts(
  overrides: Partial<Record<HoldClass, Partial<ClassFacts>>> = {},
): ClassFacts[] {
  return HOLD_CLASSES.map((hold) => ({
    hold,
    busy: 0,
    reachable: reachableSlots(hold),
    waiting: 0,
    oldestWaitingRunAt: null,
    nextDueAt: null,
    ...overrides[hold],
  }));
}

function facts(partial: Partial<QueueFacts> = {}): QueueFacts {
  return {
    classes: classFacts(),
    running: [],
    waiting: [],
    dead: [],
    ...partial,
  };
}

/** A waiting head that has waited `ms`. */
function waitingFor(
  hold: HoldClass,
  ms: number,
  extra: Partial<ClassFacts> = {},
) {
  return classFacts({
    [hold]: { waiting: 1, oldestWaitingRunAt: NOW - ms, ...extra },
  });
}

describe("the ladder", () => {
  test("idle is ok, with no pending change", () => {
    const r = queueVerdict(facts(), CFG, NOW);
    expect(r.verdict.state).toBe("ok");
    expect(r.verdict.summary).toBe(OK_SUMMARY);
    expect(r.nextChangeAt).toBeNull();
    for (const hold of HOLD_CLASSES) expect(r.verdict.cause[hold]).toBe("ok");
  });

  test("running with nothing waiting is ok", () => {
    const r = queueVerdict(
      facts({
        running: [
          {
            jobName: "a",
            hold: "instant",
            lockedAt: NOW - 10,
            forfeited: false,
          },
          {
            jobName: "b",
            hold: "minutes",
            lockedAt: NOW - 10,
            forfeited: false,
          },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("ok");
    expect(r.verdict.summary).toBe(OK_SUMMARY);
  });

  for (const hold of HOLD_CLASSES) {
    test(`${hold}: just under the attention line is ok`, () => {
      const r = queueVerdict(
        facts({ classes: waitingFor(hold, attentionWaitMs(hold) - 1) }),
        CFG,
        NOW,
      );
      expect(r.verdict.state).toBe("ok");
      expect(r.verdict.summary).toBe(OK_SUMMARY);
      // The next change is the attention line itself.
      expect(r.nextChangeAt).toBe(NOW + 1);
    });

    test(`${hold}: 10× the pickup target is attention`, () => {
      expect(attentionWaitMs(hold)).toBe(10 * pickupTargetMsFor(hold));
      const r = queueVerdict(
        facts({ classes: waitingFor(hold, attentionWaitMs(hold)) }),
        CFG,
        NOW,
      );
      expect(r.verdict.state).toBe("attention");
      expect(r.verdict.cause[hold]).toBe("attention");
      // The other classes did not colour it.
      for (const other of HOLD_CLASSES.filter((h) => h !== hold)) {
        expect(r.verdict.cause[other]).toBe("ok");
      }
      // Next: the critical line.
      expect(r.nextChangeAt).toBe(
        NOW - attentionWaitMs(hold) + criticalWaitMs(hold),
      );
    });

    test(`${hold}: the class deadline is critical`, () => {
      expect(criticalWaitMs(hold)).toBe(deadlineMsFor(hold));
      const r = queueVerdict(
        facts({ classes: waitingFor(hold, criticalWaitMs(hold)) }),
        CFG,
        NOW,
      );
      expect(r.verdict.state).toBe("critical");
      expect(r.verdict.cause[hold]).toBe("critical");
      // Nothing further to cross.
      expect(r.nextChangeAt).toBeNull();
    });
  }

  test("critical outranks attention, whichever comes first in the input", () => {
    const r = queueVerdict(
      facts({
        classes: classFacts({
          instant: {
            waiting: 1,
            oldestWaitingRunAt: NOW - attentionWaitMs("instant"),
          },
          minutes: {
            waiting: 1,
            oldestWaitingRunAt: NOW - criticalWaitMs("minutes"),
          },
        }),
        dead: [{ jobName: "x", count: 1, lastDiedAt: NOW - 1000 }],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("critical");
    // Worst cause first; at most two causes named.
    expect(r.verdict.summary.startsWith("Minutes")).toBe(true);
    expect(r.verdict.summary.split(" · ").length).toBeLessThanOrEqual(3);
    expect(r.verdict.summary).not.toContain("failed");
  });

  test("rows behind a serial lane never colour: only `waiting` is judged", () => {
    // `waiting` excludes lane rows by construction (queryQueuePulse); a class
    // whose only ready rows sit behind a lane arrives with waiting = 0 and a
    // null oldest, however old those rows are.
    const r = queueVerdict(facts({ classes: classFacts() }), CFG, NOW);
    expect(r.verdict.state).toBe("ok");
  });
});

describe("stuck running jobs", () => {
  const hold: HoldClass = "seconds";
  const line = stuckHoldMs(hold, CFG.slotHogDeadlineFraction);

  test("the stuck line is the slot-hog fraction of the deadline", () => {
    expect(line).toBe(CFG.slotHogDeadlineFraction * deadlineMsFor(hold));
  });

  test("below the line is ok, and the line is the next change", () => {
    const r = queueVerdict(
      facts({
        running: [
          { jobName: "a", hold, lockedAt: NOW - line + 5, forfeited: false },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("ok");
    expect(r.nextChangeAt).toBe(NOW + 5);
  });

  test("at the line is attention, phrased by the line", () => {
    const r = queueVerdict(
      facts({
        running: [
          {
            jobName: "backup.run",
            hold,
            lockedAt: NOW - line,
            forfeited: false,
          },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("attention");
    expect(r.verdict.cause[hold]).toBe("attention");
    expect(r.verdict.summary).toBe(
      `backup.run stuck ${formatThresholdMs(line)}+`,
    );
  });

  test("a forfeited slot is stuck however young", () => {
    const r = queueVerdict(
      facts({
        running: [{ jobName: "zombie", hold, lockedAt: NOW, forfeited: true }],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("attention");
    expect(r.verdict.summary).toBe("zombie stuck · written off");
  });

  test("several stuck jobs are counted", () => {
    const r = queueVerdict(
      facts({
        running: [
          { jobName: "a", hold, lockedAt: NOW - line, forfeited: false },
          { jobName: "b", hold, lockedAt: NOW, forfeited: true },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.summary).toBe("2 jobs stuck");
  });
});

describe("dead jobs", () => {
  const window = CFG.deadJobAttentionMinutes * 60_000;

  test("a death inside the window is attention, and it ages out on time", () => {
    const r = queueVerdict(
      facts({
        dead: [
          { jobName: "worktree.fork-db", count: 3, lastDiedAt: NOW - 1000 },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("attention");
    expect(r.verdict.summary).toBe("worktree.fork-db failed ×3");
    // Classless: no bar tints for a dead job.
    for (const hold of HOLD_CLASSES) expect(r.verdict.cause[hold]).toBe("ok");
    expect(r.nextChangeAt).toBe(NOW - 1000 + window);
  });

  test("a single death is not given a count", () => {
    const r = queueVerdict(
      facts({ dead: [{ jobName: "x", count: 1, lastDiedAt: NOW - 1 }] }),
      CFG,
      NOW,
    );
    expect(r.verdict.summary).toBe("x failed");
  });

  test("a death past the window is ok", () => {
    const r = queueVerdict(
      facts({ dead: [{ jobName: "x", count: 1, lastDiedAt: NOW - window }] }),
      CFG,
      NOW,
    );
    expect(r.verdict.state).toBe("ok");
    expect(r.nextChangeAt).toBeNull();
  });

  test("0 minutes disables the rule", () => {
    const r = queueVerdict(
      facts({ dead: [{ jobName: "x", count: 1, lastDiedAt: NOW - 1 }] }),
      { ...CFG, deadJobAttentionMinutes: 0 },
      NOW,
    );
    expect(r.verdict.state).toBe("ok");
  });
});

describe("the summary", () => {
  test("a full class says so, and a count above one says 'oldest'", () => {
    const hold: HoldClass = "minutes";
    const r = queueVerdict(
      facts({
        classes: classFacts({
          [hold]: {
            busy: reachableSlots(hold),
            waiting: 2,
            oldestWaitingRunAt: NOW - attentionWaitMs(hold),
          },
        }),
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.summary).toBe(
      `Minutes class full · 2 jobs waiting, oldest ${formatThresholdMs(attentionWaitMs(hold))}+`,
    );
  });

  test("a class with free slots names itself without 'full'", () => {
    const hold: HoldClass = "instant";
    const r = queueVerdict(
      facts({ classes: waitingFor(hold, attentionWaitMs(hold)) }),
      CFG,
      NOW,
    );
    expect(r.verdict.summary).toBe(
      `Instant: 1 job waiting ${formatThresholdMs(attentionWaitMs(hold))}+`,
    );
  });

  test("names at most two causes, waiting before stuck before dead", () => {
    const r = queueVerdict(
      facts({
        classes: waitingFor("instant", attentionWaitMs("instant")),
        running: [
          { jobName: "z", hold: "instant", lockedAt: NOW, forfeited: true },
        ],
        dead: [{ jobName: "d", count: 1, lastDiedAt: NOW - 1 }],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.summary).toBe(
      `Instant: 1 job waiting ${formatThresholdMs(attentionWaitMs("instant"))}+ · z stuck · written off`,
    );
  });

  test("ok with work waiting under its line", () => {
    const r = queueVerdict(
      facts({
        classes: classFacts({
          seconds: { waiting: 3, oldestWaitingRunAt: NOW },
        }),
        running: [
          { jobName: "a", hold: "seconds", lockedAt: NOW, forfeited: false },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.verdict.summary).toBe(OK_SUMMARY);
  });

  test("thresholds are phrased in whole units", () => {
    expect(formatThresholdMs(10_000)).toBe("10s");
    expect(formatThresholdMs(100_000)).toBe("1m 40s");
    expect(formatThresholdMs(600_000)).toBe("10m");
    expect(formatThresholdMs(3_600_000)).toBe("1h");
    expect(formatThresholdMs(250)).toBe("250ms");
  });
});

describe("nextChangeAt", () => {
  test("is the earliest of every pending crossing", () => {
    const r = queueVerdict(
      facts({
        classes: waitingFor("minutes", 0),
        running: [
          { jobName: "a", hold: "instant", lockedAt: NOW, forfeited: false },
        ],
        dead: [{ jobName: "d", count: 1, lastDiedAt: NOW }],
      }),
      CFG,
      NOW,
    );
    const candidates = [
      NOW + attentionWaitMs("minutes"),
      NOW + stuckHoldMs("instant", CFG.slotHogDeadlineFraction),
      NOW + CFG.deadJobAttentionMinutes * 60_000,
    ];
    expect(r.nextChangeAt).toBe(Math.min(...candidates));
  });

  test("includes a listed waiting row's own crossing, not just the class head", () => {
    const hold: HoldClass = "seconds";
    const r = queueVerdict(
      facts({
        classes: waitingFor(hold, criticalWaitMs(hold)),
        waiting: [
          { hold, runAt: NOW - criticalWaitMs(hold) },
          { hold, runAt: NOW - attentionWaitMs(hold) + 7 },
        ],
      }),
      CFG,
      NOW,
    );
    expect(r.nextChangeAt).toBe(NOW + 7);
  });

  test("a scheduled row counts only while its class is full", () => {
    const hold: HoldClass = "minutes";
    const due = NOW + 5000;
    const free = queueVerdict(
      facts({ classes: classFacts({ [hold]: { nextDueAt: due } }) }),
      CFG,
      NOW,
    );
    expect(free.nextChangeAt).toBeNull();
    const full = queueVerdict(
      facts({
        classes: classFacts({
          [hold]: { nextDueAt: due, busy: reachableSlots(hold) },
        }),
      }),
      CFG,
      NOW,
    );
    expect(full.nextChangeAt).toBe(due);
  });

  test("never returns an instant in the past", () => {
    const hold: HoldClass = "minutes";
    const r = queueVerdict(
      facts({
        classes: classFacts({
          [hold]: { nextDueAt: NOW - 1, busy: reachableSlots(hold) },
        }),
      }),
      CFG,
      NOW,
    );
    expect(r.nextChangeAt).toBeNull();
  });
});
