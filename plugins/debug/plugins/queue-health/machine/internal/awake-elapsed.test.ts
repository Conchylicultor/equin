import { describe, expect, test } from "bun:test";
import {
  awakeMs,
  judgeBacklog,
  stepClassStarvation,
  type StarvationCandidate,
} from "./awake-elapsed";

const T = { backlogDepthThreshold: 200, oldestOverdueMinutes: 10 };
const MIN = 60_000;

// The overlap of one sleep with a span — what `sleptDuring` answers for a
// process that saw that one sleep.
function overlap(
  span: [number, number],
  sleep: { wokeAt: number; sleptMs: number },
): number {
  const lo = Math.max(span[0], sleep.wokeAt - sleep.sleptMs);
  const hi = Math.min(span[1], sleep.wokeAt);
  return Math.max(0, hi - lo);
}

describe("judgeBacklog", () => {
  // Every kept occurrence of report-1795136339-969ygo (main, 2026-11-20), as
  // stored: when it was filed, its message's overdue, and its afterWake.
  const kept = [
    {
      at: 1795141755435,
      overdueS: 915,
      ready: 13,
      locked: 8,
      wokeAt: 1795141755075.06,
      sleptMs: 962793.29,
    },
    {
      at: 1795140745437,
      overdueS: 865,
      ready: 7,
      locked: 8,
      wokeAt: 1795140745066.146,
      sleptMs: 908812.807,
    },
    {
      at: 1795139789463,
      overdueS: 869,
      ready: 13,
      locked: 8,
      wokeAt: 1795139789105.799,
      sleptMs: 924816.006,
    },
    {
      at: 1795138817489,
      overdueS: 917,
      ready: 8,
      locked: 8,
      wokeAt: 1795138817125.021,
      sleptMs: 917794.947,
    },
    {
      at: 1795137852444,
      overdueS: 852,
      ready: 12,
      locked: 8,
      wokeAt: 1795137852113.27,
      sleptMs: 918164.027,
    },
    {
      at: 1795136339423,
      overdueS: 959,
      ready: 10,
      locked: 0,
      wokeAt: 1795136339096.355,
      sleptMs: 961181.106,
    },
  ];

  test.each(kept)(
    "replay: the post-wake occurrence at $at is not a backlog",
    (o) => {
      const oldestOverdueMs = o.overdueS * 1000;
      const sleptMs = overlap([o.at - oldestOverdueMs, o.at], o);
      expect(
        judgeBacklog(
          {
            readyCount: o.ready,
            lockedCount: o.locked,
            oldestOverdueMs,
            sleptMs,
          },
          T,
        ),
      ).toBeNull();
    },
  );

  test("replay: the same occurrences judged on the wall clock (as before) all trip", () => {
    for (const o of kept)
      expect(
        judgeBacklog(
          {
            readyCount: o.ready,
            lockedCount: o.locked,
            oldestOverdueMs: o.overdueS * 1000,
            sleptMs: 0,
          },
          T,
        ),
      ).not.toBeNull();
  });

  test("a real stall while awake is reported as STALLED", () => {
    expect(
      judgeBacklog(
        {
          readyCount: 10,
          lockedCount: 0,
          oldestOverdueMs: 11 * MIN,
          sleptMs: 0,
        },
        T,
      ),
    ).toEqual({
      readyCount: 10,
      lockedCount: 0,
      oldestOverdueMs: 11 * MIN,
      oldestAwakeOverdueMs: 11 * MIN,
      stalled: true,
    });
  });

  test("a post-wake burst that does not drain within the threshold of awake time is reported", () => {
    // Came due mid-nap (15 min asleep), still waiting 10.5 min after the wake.
    const j = judgeBacklog(
      {
        readyCount: 12,
        lockedCount: 8,
        oldestOverdueMs: 18 * MIN,
        sleptMs: 7.5 * MIN,
      },
      T,
    );
    expect(j?.oldestAwakeOverdueMs).toBe(10.5 * MIN);
    expect(j?.stalled).toBe(false);
  });

  test("awake waiting on both sides of a nap adds up", () => {
    // 6 min overdue before a 15 min nap, 5 more after: 11 min awake.
    const j = judgeBacklog(
      {
        readyCount: 3,
        lockedCount: 0,
        oldestOverdueMs: 26 * MIN,
        sleptMs: 15 * MIN,
      },
      T,
    );
    expect(j?.oldestAwakeOverdueMs).toBe(11 * MIN);
    expect(j?.stalled).toBe(true);
  });

  test("depth trips whatever the clock says", () => {
    expect(
      judgeBacklog(
        {
          readyCount: 201,
          lockedCount: 8,
          oldestOverdueMs: 15 * MIN,
          sleptMs: 15 * MIN,
        },
        T,
      )?.stalled,
    ).toBe(false);
  });

  test("a platform that cannot tell sleep judges on the wall clock", () => {
    expect(
      judgeBacklog(
        {
          readyCount: 1,
          lockedCount: 0,
          oldestOverdueMs: 11 * MIN,
          sleptMs: null,
        },
        T,
      )?.stalled,
    ).toBe(true);
  });
});

describe("stepClassStarvation", () => {
  const window = 3 * MIN;
  const noSleep = () => 0;

  test("a class whose head does not move across two awake reads a window apart trips", () => {
    const t0 = 1_000_000_000;
    const open = stepClassStarvation(
      undefined,
      { readyCount: 5, oldestOverdueMs: 60_000 },
      t0,
      window,
      noSleep,
    );
    expect(open.kind).toBe("open");
    const prev = (open as { candidate: StarvationCandidate }).candidate;
    const t1 = t0 + window;
    expect(
      stepClassStarvation(
        prev,
        { readyCount: 5, oldestOverdueMs: 60_000 + window },
        t1,
        window,
        noSleep,
      ),
    ).toEqual({ kind: "trip", starvedForMs: window });
  });

  test("the same frozen head across a nap is not starvation", () => {
    const t0 = 1_000_000_000;
    const prev: StarvationCandidate = {
      headRunAtMs: t0 - 60_000,
      readyCount: 5,
      since: t0,
    };
    const t1 = t0 + 15 * MIN + 30_000; // 15 min asleep, 30 s awake
    expect(
      stepClassStarvation(
        prev,
        { readyCount: 5, oldestOverdueMs: t1 - prev.headRunAtMs },
        t1,
        window,
        () => 15 * MIN,
      ),
    ).toEqual({ kind: "wait" });
  });

  test("a head that moved, or a depth that fell, re-opens", () => {
    const t0 = 1_000_000_000;
    const prev: StarvationCandidate = {
      headRunAtMs: t0 - 60_000,
      readyCount: 5,
      since: t0,
    };
    const t1 = t0 + window;
    expect(
      stepClassStarvation(
        prev,
        { readyCount: 5, oldestOverdueMs: 10_000 },
        t1,
        window,
        noSleep,
      ).kind,
    ).toBe("open");
    expect(
      stepClassStarvation(
        prev,
        { readyCount: 4, oldestOverdueMs: t1 - prev.headRunAtMs },
        t1,
        window,
        noSleep,
      ).kind,
    ).toBe("open");
  });

  test("nothing ready clears", () => {
    expect(
      stepClassStarvation(
        undefined,
        { readyCount: 0, oldestOverdueMs: 0 },
        1,
        window,
        noSleep,
      ).kind,
    ).toBe("clear");
  });
});

test("awakeMs never goes below zero and rounds", () => {
  expect(awakeMs(1000, 1500)).toBe(0);
  expect(awakeMs(1000.6, null)).toBe(1001);
});
