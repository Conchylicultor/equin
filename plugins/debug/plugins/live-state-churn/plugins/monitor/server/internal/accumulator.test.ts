import { describe, expect, it, beforeEach } from "bun:test";
import {
  recordPushAt,
  snapshotAt,
  _resetForTest,
} from "./accumulator";

// A tasks.tree.v2:groups-like recompute, as measured on main (2026-11-14):
// ~3 ms of own work, no io, a sliver of gate wait.
const CHEAP = { ownMs: 3, waitMs: 0.2, ioMs: 0 };

beforeEach(() => {
  _resetForTest();
});

describe("accumulator", () => {
  it("reports the sustained no-op rate over the window", () => {
    const start = 1_000_000_000_000; // arbitrary fixed epoch ms
    // 5 no-op pushes/sec for 60s.
    for (let s = 0; s < 60; s++) {
      const base = start + s * 1000;
      for (let i = 0; i < 5; i++) {
        recordPushAt(
          "res:a",
          { tuple: "{}", subscribers: 3, changed: false, cost: CHEAP },
          base + i * 100,
        );
      }
    }
    // Snapshot at the last second of activity.
    const snap = snapshotAt(60, start + 59 * 1000 + 999);
    expect(snap).toHaveLength(1);
    const a = snap[0]!;
    expect(a.resourceKey).toBe("res:a");
    expect(a.noopCount).toBe(300);
    expect(a.totalCount).toBe(300);
    expect(a.subscribers).toBe(3);
    expect(a.noopRate).toBeCloseTo(5, 5);
  });

  it("counts changed pushes in total but not in noop", () => {
    const start = 2_000_000_000_000;
    for (let s = 0; s < 10; s++) {
      const base = start + s * 1000;
      // 4 no-op + 2 changed per second.
      for (let i = 0; i < 4; i++) {
        recordPushAt(
          "res:b",
          { tuple: "{}", subscribers: 1, changed: false, cost: CHEAP },
          base + i * 50,
        );
      }
      for (let i = 0; i < 2; i++) {
        recordPushAt(
          "res:b",
          { tuple: "{}", subscribers: 1, changed: true, cost: CHEAP },
          base + 500 + i * 50,
        );
      }
    }
    const snap = snapshotAt(10, start + 9 * 1000 + 999);
    expect(snap).toHaveLength(1);
    const b = snap[0]!;
    expect(b.noopCount).toBe(40); // 4 * 10
    expect(b.totalCount).toBe(60); // 6 * 10
    expect(b.noopRate).toBeCloseTo(4, 5); // 40 / 10s
  });

  it("prunes buckets older than the window so the rate drops over time", () => {
    const start = 3_000_000_000_000;
    // 5 no-op/sec for 60s.
    for (let s = 0; s < 60; s++) {
      const base = start + s * 1000;
      for (let i = 0; i < 5; i++) {
        recordPushAt(
          "res:c",
          { tuple: "{}", subscribers: 2, changed: false, cost: CHEAP },
          base + i * 100,
        );
      }
    }
    const lastActivityMs = start + 59 * 1000 + 999;

    // Immediately after activity: full rate.
    expect(snapshotAt(60, lastActivityMs).at(0)?.noopRate).toBeCloseTo(5, 5);

    // 30s later (no new pushes): only the trailing 30s of the original 60s
    // window still fall inside the window, so half the buckets remain.
    const snap30 = snapshotAt(60, lastActivityMs + 30 * 1000);
    expect(snap30[0]!.noopCount).toBeLessThan(300);
    expect(snap30[0]!.noopCount).toBeGreaterThan(0);

    // 120s later: every bucket is outside the 60s window → no totals → dropped.
    const snap120 = snapshotAt(60, lastActivityMs + 120 * 1000);
    expect(snap120).toHaveLength(0);
  });

  it("evicts the least-recently-active key past the cap", () => {
    const start = 4_000_000_000_000;
    // Fill 512 keys, each active at a distinct (increasing) time.
    for (let k = 0; k < 512; k++) {
      recordPushAt(
        `res:${k}`,
        { tuple: "{}", subscribers: 1, changed: false, cost: CHEAP },
        start + k,
      );
    }
    // key 0 is the least-recently-active. Adding a 513th evicts it.
    recordPushAt(
      "res:overflow",
      { tuple: "{}", subscribers: 1, changed: false, cost: CHEAP },
      start + 1000,
    );

    // Snapshot at the overflow time over a wide window so surviving keys report.
    const snap = snapshotAt(600, start + 1000);
    const keys = new Set(snap.map((s) => s.resourceKey));
    expect(keys.has("res:0")).toBe(false);
    expect(keys.has("res:overflow")).toBe(true);
    expect(keys.has("res:511")).toBe(true);
  });

  it("judges wasted work, not the count: cheap churn stays far under the bar", () => {
    const start = 5_000_000_000_000;
    // 3.1 no-op/s at ~3 ms own — the worst tasks.tree.v2:groups report.
    for (let i = 0; i < 186; i++)
      recordPushAt(
        "cheap",
        { tuple: "{}", subscribers: 2, changed: false, cost: CHEAP },
        start + i * 320,
      );
    const s = snapshotAt(60, start + 59_999)[0]!;
    expect(s.noopRate).toBeCloseTo(3.1, 1);
    expect(s.noopOwnMs).toBeCloseTo(558, 0);
    expect(s.wastedMsPerMinute).toBeCloseTo(558, 0); // < the 1000 ms/min default
  });

  it("an expensive no-op recompute counts at a low rate, io included, queue/join waits not", () => {
    const start = 6_000_000_000_000;
    // Two no-ops in a minute, each 400 ms own + 900 ms of git io inside 1500 ms of waits.
    const cost = { ownMs: 400, waitMs: 1500, ioMs: 900 };
    recordPushAt(
      "costly",
      { tuple: "{}", subscribers: 1, changed: false, cost },
      start,
    );
    recordPushAt(
      "costly",
      { tuple: "{}", subscribers: 1, changed: false, cost },
      start + 30_000,
    );
    // A changed recompute is not waste, whatever it cost.
    recordPushAt(
      "costly",
      { tuple: "{}", subscribers: 1, changed: true, cost },
      start + 40_000,
    );
    const s = snapshotAt(60, start + 59_999)[0]!;
    expect(s.noopCount).toBe(2);
    expect(s.totalCount).toBe(3);
    expect(s.noopOwnMs).toBe(800);
    expect(s.noopIoMs).toBe(1800);
    expect(s.noopWaitMs).toBe(3000);
    expect(s.wastedMsPerMinute).toBe(2600); // (800 + 1800) per 60 s
  });

  it("scales the waste to a minute over any window", () => {
    const start = 7_000_000_000_000;
    recordPushAt(
      "k",
      {
        tuple: "{}",
        subscribers: 1,
        changed: false,
        cost: { ownMs: 100, waitMs: 0, ioMs: 0 },
      },
      start,
    );
    expect(snapshotAt(30, start)[0]!.wastedMsPerMinute).toBe(200);
  });

  it("counts a no-op the host did not measure apart, never as free", () => {
    const start = 8_000_000_000_000;
    recordPushAt(
      "u",
      { tuple: "{}", subscribers: 1, changed: false, cost: null },
      start,
    );
    const s = snapshotAt(60, start)[0]!;
    expect(s.noopCount).toBe(1);
    expect(s.unmeasuredNoops).toBe(1);
    expect(s.wastedMsPerMinute).toBe(0);
  });

  describe("a busy host's contention is not counted as work", () => {
    // 2026-11-14 23:43 UTC on main (load 57 on 18 cores, event loop p99
    // 451 ms): tasks.tree.v2:groups measured ~50 ms per no-op, 98 in the
    // minute (4869 ms/min) against its ~3 ms quiet cost, and filed.
    it("a cheap tuple whose runs a loaded host inflated is charged its cheapest run", () => {
      const start = 9_000_000_000_000;
      for (let i = 0; i < 98; i++) {
        // Mostly ~50 ms, the host quiet for a moment now and then.
        const ownMs = i % 20 === 0 ? 3 : 45 + (i % 7) * 2;
        recordPushAt(
          "tasks.tree.v2:groups",
          {
            tuple: '{"limit":"100"}',
            subscribers: 2,
            changed: false,
            cost: { ownMs, waitMs: 12, ioMs: 0 },
          },
          start + i * 600,
        );
      }
      const s = snapshotAt(60, start + 59_999)[0]!;
      expect(s.measuredMsPerMinute).toBeGreaterThan(4000);
      expect(s.wastedMsPerMinute).toBe(98 * 3); // 294 < the 1000 ms/min bar
      expect(s.noopTuples).toBe(1);
    });

    it("a genuinely costly tuple still files at its cheapest run", () => {
      const start = 9_100_000_000_000;
      // queue-health.verdict-like: ~130 ms of real work, inflated up to 1.6 s.
      for (let i = 0; i < 20; i++)
        recordPushAt(
          "costly",
          {
            tuple: "{}",
            subscribers: 4,
            changed: false,
            cost: { ownMs: i === 7 ? 130 : 130 + i * 70, waitMs: 0, ioMs: 0 },
          },
          start + i * 3000,
        );
      const s = snapshotAt(60, start + 59_999)[0]!;
      expect(s.wastedMsPerMinute).toBe(20 * 130); // 2600 ≥ the bar: files
    });

    it("io a run waited on is part of its cheapest run", () => {
      const start = 9_200_000_000_000;
      for (const [ownMs, ioMs] of [
        [10, 500],
        [200, 900],
        [5, 600],
      ] as const)
        recordPushAt(
          "git",
          {
            tuple: "{}",
            subscribers: 1,
            changed: false,
            cost: { ownMs, waitMs: ioMs, ioMs },
          },
          start,
        );
      // Cheapest run: 10 + 500 = 510 (not 5 + 500 picked across runs).
      expect(snapshotAt(60, start)[0]!.wastedMsPerMinute).toBe(3 * 510);
    });

    it("each tuple is charged its own cheapest run: a cheap variant never hides a costly one", () => {
      const start = 9_300_000_000_000;
      for (let i = 0; i < 10; i++) {
        recordPushAt(
          "k",
          {
            tuple: "a",
            subscribers: 1,
            changed: false,
            cost: { ownMs: 2, waitMs: 0, ioMs: 0 },
          },
          start + i * 1000,
        );
        recordPushAt(
          "k",
          {
            tuple: "b",
            subscribers: 1,
            changed: false,
            cost: { ownMs: 300, waitMs: 0, ioMs: 0 },
          },
          start + i * 1000,
        );
      }
      const s = snapshotAt(60, start + 9_999)[0]!;
      expect(s.noopTuples).toBe(2);
      expect(s.wastedMsPerMinute).toBe(10 * 2 + 10 * 300);
    });

    it("the cheapest run is taken over the whole window, across seconds", () => {
      const start = 9_400_000_000_000;
      recordPushAt(
        "k",
        {
          tuple: "{}",
          subscribers: 1,
          changed: false,
          cost: { ownMs: 40, waitMs: 0, ioMs: 0 },
        },
        start,
      );
      recordPushAt(
        "k",
        {
          tuple: "{}",
          subscribers: 1,
          changed: false,
          cost: { ownMs: 4, waitMs: 0, ioMs: 0 },
        },
        start + 20_000,
      );
      recordPushAt(
        "k",
        {
          tuple: "{}",
          subscribers: 1,
          changed: false,
          cost: { ownMs: 40, waitMs: 0, ioMs: 0 },
        },
        start + 40_000,
      );
      expect(snapshotAt(60, start + 40_000)[0]!.wastedMsPerMinute).toBe(12);
      // Once the cheap run leaves the window, the remaining run is charged what it measured.
      expect(snapshotAt(15, start + 40_000)[0]!.wastedMsPerMinute).toBe(40 * 4);
    });

    it("a tuple past the per-second cap is charged what it measured, never less", () => {
      const start = 9_500_000_000_000;
      for (let t = 0; t < 40; t++)
        recordPushAt(
          "wide",
          {
            tuple: `t${t}`,
            subscribers: 1,
            changed: false,
            cost: { ownMs: 10, waitMs: 0, ioMs: 0 },
          },
          start,
        );
      const s = snapshotAt(60, start)[0]!;
      expect(s.noopTuples).toBe(32);
      expect(s.wastedMsPerMinute).toBe(400);
      expect(s.wastedMsPerMinute).toBe(s.measuredMsPerMinute);
    });
  });
});
