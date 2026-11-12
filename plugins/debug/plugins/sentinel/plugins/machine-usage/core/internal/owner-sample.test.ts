import { describe, expect, it } from "bun:test";
import type { PsProcess } from "./attribute";
import type { MachineUsageBucket } from "./machine-usage";
import { processLabel, summarizeOwners } from "./owner-sample";

function proc(
  pid: number,
  cpuTimeMs: number,
  args = `p${pid}`,
  extra: Partial<PsProcess> = {},
): PsProcess {
  return { pid, ppid: 1, cpu: 0, rssBytes: 0, cpuTimeMs, args, ...extra };
}

const MB = 1_048_576;

describe("summarizeOwners", () => {
  const owner = new Map<number, MachineUsageBucket>([
    [1, "backends"],
    [2, "agents"],
    [3, "other"],
  ]);
  const memBytesOf = (p: PsProcess) => p.pid * 100 * MB;

  it("has no CPU on its first window, memory always", () => {
    const { sample } = summarizeOwners({
      procs: [proc(1, 5_000), proc(2, 1_000)],
      owner,
      memBytesOf,
      baseline: null,
      nowMs: 1_000,
      cores: 4,
    });
    expect(sample.windowMs).toBeUndefined();
    const backends = sample.owners.find((o) => o.bucket === "backends")!;
    expect(backends).toEqual({ bucket: "backends", processes: 1, memMb: 100 });
  });

  it("charges each process its CPU-time delta over the window, in cores", () => {
    const first = summarizeOwners({
      procs: [proc(1, 5_000), proc(2, 1_000)],
      owner,
      memBytesOf,
      baseline: null,
      nowMs: 0,
      cores: 4,
    });
    const { sample } = summarizeOwners({
      // 1 ran 20 s of CPU in 10 s (2 cores); 2 exited; 3 started and ran 5 s.
      procs: [proc(1, 25_000), proc(3, 5_000)],
      owner,
      memBytesOf,
      baseline: first.baseline,
      nowMs: 10_000,
      cores: 4,
    });
    expect(sample.windowMs).toBe(10_000);
    const cpu = Object.fromEntries(
      sample.owners.map((o) => [o.bucket, o.cpuCores]),
    );
    expect(cpu.backends).toBeCloseTo(2);
    expect(cpu.agents).toBe(0);
    expect(cpu.other).toBeCloseTo(0.5);
  });

  it("treats a pid whose CPU time went backwards as a new process", () => {
    const first = summarizeOwners({
      procs: [proc(1, 50_000)],
      owner,
      memBytesOf,
      baseline: null,
      nowMs: 0,
      cores: 4,
    });
    const { sample } = summarizeOwners({
      procs: [proc(1, 1_000)],
      owner,
      memBytesOf,
      baseline: first.baseline,
      nowMs: 10_000,
      cores: 4,
    });
    expect(sample.owners.find((o) => o.bucket === "backends")!.cpuCores).toBe(
      0.1,
    );
  });

  it("charges what a parent's children ran and it reaped, never twice", () => {
    const first = summarizeOwners({
      procs: [
        proc(1, 1_000, "p1", { reapedChildrenMs: 50_000 }),
        // A child seen running: 4 s so far, charged to its own bucket.
        proc(2, 4_000, "p2", { ppid: 1 }),
      ],
      owner,
      memBytesOf,
      baseline: null,
      nowMs: 0,
      cores: 4,
    });
    const { sample } = summarizeOwners({
      // In 10 s: 1 ran 1 s itself; 2 ran 2 more s and exited (reaped: 6 s);
      // short-lived children came and went for 7 s (reaped). 50 + 6 + 7 = 63.
      procs: [proc(1, 2_000, "p1", { reapedChildrenMs: 63_000 })],
      owner,
      memBytesOf,
      baseline: first.baseline,
      nowMs: 10_000,
      cores: 4,
    });
    const backends = sample.owners.find((o) => o.bucket === "backends")!;
    // 1 s own + 2 s (2's last stretch) + 7 s (the short-lived ones) = 10 s.
    expect(backends.cpuCores).toBeCloseTo(1);
  });

  it("a vanished grandchild's seen time is taken off its nearest live ancestor", () => {
    const first = summarizeOwners({
      procs: [
        proc(1, 0, "p1", { reapedChildrenMs: 0 }),
        proc(2, 1_000, "p2", { ppid: 1, reapedChildrenMs: 0 }),
        // A long-lived grandchild: 100 s seen, already charged.
        proc(3, 100_000, "p3", { ppid: 2, reapedChildrenMs: 0 }),
      ],
      owner,
      memBytesOf,
      baseline: null,
      nowMs: 0,
      cores: 4,
    });
    const { sample } = summarizeOwners({
      // 3 ran 1 more s and exited (reaped by 2: 101 s), then 2 exited after
      // 1 more s of its own (reaped by 1: 2 + 101 = 103 s).
      procs: [proc(1, 0, "p1", { reapedChildrenMs: 103_000 })],
      owner,
      memBytesOf,
      baseline: first.baseline,
      nowMs: 10_000,
      cores: 4,
    });
    const backends = sample.owners.find((o) => o.bucket === "backends")!;
    // 103 − (1 + 100) seen = 2 s in 10 s.
    expect(backends.cpuCores).toBeCloseTo(0.2);
  });

  it("names the largest processes by memory, then the busiest others", () => {
    const procs = Array.from({ length: 20 }, (_, i) => proc(i + 1, 0));
    procs.push(proc(100, 9_000_000)); // no memory, the busiest
    const first = summarizeOwners({
      procs: procs.map((p) => ({ ...p, cpuTimeMs: 0 })),
      owner,
      memBytesOf: (p) => (p.pid === 100 ? 0 : p.pid * MB),
      baseline: null,
      nowMs: 0,
      cores: 4,
    });
    const { sample } = summarizeOwners({
      procs,
      owner,
      memBytesOf: (p) => (p.pid === 100 ? 0 : p.pid * MB),
      baseline: first.baseline,
      nowMs: 10_000,
      cores: 4,
    });
    expect(sample.top.slice(0, 6).map((t) => t.name)).toEqual([
      "p20",
      "p19",
      "p18",
      "p17",
      "p16",
      "p15",
    ]);
    expect(sample.top[6]!.name).toBe("p100");
    // Each named process carries its pid: one process, one series.
    expect(sample.top.every((t) => typeof t.pid === "number")).toBe(true);
    expect(sample.top.length).toBe(7);
  });
});

describe("processLabel", () => {
  it("keeps the executable's file name, spaces included", () => {
    expect(
      processLabel(
        "/Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer) --type=renderer",
      ),
    ).toBe("Google Chrome Helper (Renderer)");
    expect(processLabel("/x/bin/equin · server · main")).toBe(
      "equin · server · main",
    );
    expect(
      processLabel(
        "/u/.equin/state/macos-app/equin.app/Contents/MacOS/gateway -listen x",
      ),
    ).toBe("gateway");
    expect(
      processLabel(
        "/u/bin/bun plugins/framework/plugins/cli/bin/index.ts check --scope tree",
      ),
    ).toBe("bun cli/bin/index.ts check --scope tree");
    expect(
      processLabel(
        "/u/state/sdk-agents/ns/conv-1/bin/equin · agent · conv-1 /repo/plugins/x/bin/agent.ts",
      ),
    ).toBe("equin · agent · conv-1 x/bin/agent.ts");
    expect(processLabel("postgres: equin main [local] idle")).toBe(
      "postgres: equin main [local] idle",
    );
  });
});
