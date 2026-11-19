import { describe, expect, test } from "bun:test";
import { blockedTrip, type JobSpanSample } from "./profile-delta";

const ZERO: JobSpanSample = {
  count: 0,
  totalMs: 0,
  waitTotalMs: 0,
  ioTotalMs: 0,
  waits: {},
};
const IO = new Set(["spawn:git", "spawn:ps"]);

describe("blockedTrip", () => {
  test("a job whose time is its own git children is working, not blocked", () => {
    // worktree.fsmonitor-reconcile on main, 2026-11-19 18:52Z: 10.2 s held,
    // 9.9 s of it git children it ran itself.
    const cur: JobSpanSample = {
      count: 1,
      totalMs: 10_197,
      waitTotalMs: 10_006,
      ioTotalMs: 10_006,
      waits: { "spawn:git": 9_871, "spawn:ps": 78, "db-acquire": 0 },
    };
    expect(blockedTrip(ZERO, cur, 5_000, IO)).toBeNull();
  });

  test("a job queued on a gate inside its slot still trips, naming the gate", () => {
    // jobs.dead-gc: 77 s held, all of it on background-tx-acquire.
    const cur: JobSpanSample = {
      count: 1,
      totalMs: 77_000,
      waitTotalMs: 76_746,
      ioTotalMs: 0,
      waits: { "background-tx-acquire": 76_746 },
    };
    const trip = blockedTrip(ZERO, cur, 5_000, IO);
    expect(trip?.layer).toBe("background-tx-acquire");
    expect(trip?.workMs).toBeCloseTo(254);
  });

  test("io beside a real gate wait: only the gate is the wait, io is work", () => {
    const cur: JobSpanSample = {
      count: 2,
      totalMs: 40_000,
      waitTotalMs: 36_000,
      ioTotalMs: 6_000,
      waits: { "spawn:git": 6_000, "read-admit": 30_000 },
    };
    const trip = blockedTrip(ZERO, cur, 5_000, IO);
    expect(trip?.waitMs).toBe(15_000);
    expect(trip?.workMs).toBe(5_000);
    expect(trip?.layers).toEqual([{ layer: "read-admit", ms: 15_000 }]);
  });

  test("io that leaves the gate wait under half the hold does not trip", () => {
    const cur: JobSpanSample = {
      count: 1,
      totalMs: 20_000,
      waitTotalMs: 18_000,
      ioTotalMs: 12_000,
      waits: { "spawn:git": 12_000, "read-admit": 6_000 },
    };
    expect(blockedTrip(ZERO, cur, 5_000, IO)).toBeNull();
  });
});
