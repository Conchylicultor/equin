import { describe, expect, test } from "bun:test";
import { createIoHealthDetector, IO_HEALTH_THRESHOLDS as T } from "./detect";
import { findingKey } from "./finding";
import type { MonitorTick } from "./tick";

const T0 = 1_793_700_000;

function tick(i: number, over: Partial<MonitorTick> = {}): MonitorTick {
  const t = T0 + i * 30;
  return {
    t,
    iso: new Date(t * 1000).toISOString().slice(0, 19) + "Z",
    max_op_ms: 20,
    fg: { max_op: 5 },
    bg: { max_op: 20 },
    canary: [],
    load1: 4,
    daemon_cpu: { fseventsd: 0.5, syspolicyd: 0.1 },
    new_vnodes_s: 3000,
    disk_read_ops_s: 4000,
    disk_read_mb_s: 40,
    disk_read_ms_per_op: 0.6,
    ...over,
  };
}

function run(n: number, over: (i: number) => Partial<MonitorTick>) {
  const d = createIoHealthDetector();
  const raised: { i: number; key: string }[] = [];
  const cleared: { i: number; key: string }[] = [];
  for (let i = 0; i < n; i++) {
    const s = d.push(tick(i, over(i)));
    for (const f of s.raised) raised.push({ i, key: findingKey(f) });
    for (const f of s.cleared) cleared.push({ i, key: findingKey(f) });
  }
  return { d, raised, cleared };
}

describe("io-health detector", () => {
  test("a healthy busy fleet raises nothing", () => {
    const { raised } = run(240, () => ({}));
    expect(raised).toEqual([]);
  });

  test("a daemon at high CPU is raised once it holds the hour's median, with its onset kept", () => {
    const { d, raised } = run(200, () => ({ daemon_cpu: { fseventsd: 85 } }));
    expect(raised).toEqual([
      { i: T.minTicks - 1, key: "daemon-cpu:fseventsd" },
    ]);
    const f = d.active()[0]!;
    expect(f.since).toBe((T0 + (T.minTicks - 1) * 30) * 1000);
    expect(f.summary).toContain("fseventsd has used 85 % CPU");
  });

  test("device latency holds down to its lower bar, then clears (no flapping at the line)", () => {
    // 2.1 ms for an hour, then 1.7 (between hold and raise), then 0.6.
    const ms = (i: number) => (i < 120 ? 2.1 : i < 360 ? 1.7 : 0.6);
    const { raised, cleared } = run(600, (i) => ({
      disk_read_ms_per_op: ms(i),
    }));
    expect(raised.map((r) => r.key)).toEqual(["device-latency:disk"]);
    expect(cleared).toHaveLength(1);
    expect(cleared[0]!.i).toBeGreaterThan(360);
  });

  test("idle ticks do not count toward device latency", () => {
    const { raised } = run(240, () => ({
      disk_read_ops_s: 10,
      disk_read_ms_per_op: 9,
    }));
    expect(raised).toEqual([]);
  });

  test("one stall over a second is critical at once and clears an hour later", () => {
    const { raised, cleared, d } = run(130, (i) =>
      i === 5 ? { max_op_ms: 1800, bg: { max_op: 1800 } } : {},
    );
    expect(raised).toEqual([{ i: 5, key: "metadata-stall:probe" }]);
    expect(cleared[0]!.i).toBe(5 + 120);
    expect(d.active()).toEqual([]);
  });

  test("a daemon with a new pid every few minutes is a relaunch loop (legacy corecaptured field too)", () => {
    const viaProcs = run(60, (i) => ({
      daemon_procs: {
        corecaptured: { pid: 100 + Math.floor(i / 9), age_s: (i % 9) * 30 },
      },
    }));
    expect(viaProcs.raised.map((r) => r.key)).toEqual([
      "relaunch-loop:corecaptured",
    ]);
    const legacy = run(60, (i) => ({
      corecaptured: { pid: 100 + Math.floor(i / 9), age_s: (i % 9) * 30 },
    }));
    expect(legacy.raised.map((r) => r.key)).toEqual([
      "relaunch-loop:corecaptured",
    ]);
    const steady = run(240, () => ({
      daemon_procs: { mds: { pid: 7, age_s: 999 } },
    }));
    expect(steady.raised).toEqual([]);
  });

  test("cache collapse needs every tick since the canary's read to be quiet", () => {
    const canary = [{ age_s: 90, resident: 0 }];
    const quiet = run(120, () => ({ new_vnodes_s: 50, canary }));
    expect(quiet.raised.map((r) => r.key)).toEqual(["cache-collapse:cache"]);
    // A churn burst every third tick: the eviction is the fleet's, not news.
    const bursty = run(120, (i) => ({
      new_vnodes_s: i % 3 === 0 ? 20_000 : 50,
      canary,
    }));
    expect(bursty.raised).toEqual([]);
    const resident = run(120, () => ({
      new_vnodes_s: 50,
      canary: [{ age_s: 90, resident: 1 }],
    }));
    expect(resident.raised).toEqual([]);
  });

  test("a root daemon installed but silent is raised from the first tick that says so, and cleared by the next that does not", () => {
    const status = {
      problem: "empty" as const,
      plist: "/Library/LaunchDaemons/dev.equin.fs-latency-monitor.plist",
      stdio: "/tmp/fs-latency-root-stdio.log",
      fix: "sudo '/x/equin.app/Contents/MacOS/fs-latency-monitor' install-root …",
    };
    const { raised, cleared, d } = run(10, (i) =>
      i >= 2 && i < 6 ? { root_daemon: status } : {},
    );
    expect(raised).toEqual([{ i: 2, key: "root-daemon:root-daemon" }]);
    expect(cleared).toEqual([{ i: 6, key: "root-daemon:root-daemon" }]);
    expect(d.active()).toEqual([]);
    const held = run(3, () => ({ root_daemon: status })).d.active()[0]!;
    expect(held.summary).toContain("its plist is empty");
    expect(held.evidence).toContainEqual({
      label: "reinstall (from any directory)",
      value: status.fix,
    });
  });

  test("a tick not newer than the last is dropped and counted", () => {
    const d = createIoHealthDetector();
    d.push(tick(3));
    d.push(tick(2));
    d.push(tick(3));
    expect(d.outOfOrder()).toBe(2);
    expect(d.last()!.t).toBe(T0 + 90);
  });
});
