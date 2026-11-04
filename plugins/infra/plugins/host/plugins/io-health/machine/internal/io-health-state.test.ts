import { describe, expect, test } from "bun:test";
import type { Finding, MonitorTick } from "../../core";
import { createIoHealthState } from "./io-health-state";
import type { TailRead } from "./log-tail";

const T0 = 1_793_700_000;

function tick(i: number, fseventsd: number): MonitorTick {
  return {
    t: T0 + i * 30,
    iso: `i${i}`,
    max_op_ms: 10,
    fg: { max_op: 5 },
    bg: { max_op: 10 },
    canary: [],
    load1: 3,
    daemon_cpu: { fseventsd },
    disk_read_ops_s: 4000,
    disk_read_ms_per_op: 0.5,
  };
}

/** A state fed one batch per refresh, the wall clock at `lagS` past the batch's newest tick. */
function harness(files: boolean, lagS = 0) {
  let pending: TailRead = { kind: "missing" };
  let now = 0;
  const recorded: Finding[] = [];
  const state = createIoHealthState({
    read: async () => pending,
    record: async (f) => {
      recorded.push(f);
    },
    files,
    now: () => now,
  });
  let offset = 0;
  return {
    state,
    recorded,
    async feed(ticks: MonitorTick[]) {
      offset += ticks.length;
      pending = { kind: "read", ticks, cursor: { ino: 1, offset } };
      now = (ticks.at(-1)!.t + lagS) * 1000;
      await state.refresh();
    },
    async missing() {
      pending = { kind: "missing" };
      await state.refresh();
    },
  };
}

describe("io-health state", () => {
  test("files a finding when raised, and again once an hour while it holds", async () => {
    const h = harness(true);
    for (let i = 0; i < 300; i++) await h.feed([tick(i, 90)]);
    // Raised at tick 39, re-filed at 159 and 279 (every 120 ticks = 1 h).
    expect(h.recorded.map((f) => f.rule)).toEqual([
      "daemon-cpu",
      "daemon-cpu",
      "daemon-cpu",
    ]);
    expect(h.recorded[2]!.since).toBe(h.recorded[0]!.since);
    const v = h.state.current();
    if (v?.monitor !== "present") throw new Error("expected present");
    expect(v.findings.map((f) => f.subject)).toEqual(["fseventsd"]);
  });

  test("a worktree backend shows findings but files nothing", async () => {
    const h = harness(false);
    for (let i = 0; i < 100; i++) await h.feed([tick(i, 90)]);
    expect(h.recorded).toEqual([]);
    const v = h.state.current();
    expect(v?.monitor === "present" && v.findings.length).toBe(1);
  });

  test("a boot onto a log the monitor stopped writing a day ago files nothing", async () => {
    const h = harness(true, 86_400);
    await h.feed(Array.from({ length: 100 }, (_, i) => tick(i, 90)));
    expect(h.recorded).toEqual([]);
    const v = h.state.current();
    expect(v?.monitor === "present" && v.findings.length).toBe(1);
  });

  test("the log disappearing reads as the monitor missing", async () => {
    const h = harness(true);
    await h.feed([tick(0, 1)]);
    expect(h.state.current()?.monitor).toBe("present");
    await h.missing();
    expect(h.state.current()).toEqual({ monitor: "missing" });
  });
});
