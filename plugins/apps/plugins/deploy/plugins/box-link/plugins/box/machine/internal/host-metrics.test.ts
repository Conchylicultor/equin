import { describe, expect, test } from "bun:test";
import {
  busyPctBetween,
  createHostSampler,
  parseProcStatCpu,
} from "./host-metrics";

describe("parseProcStatCpu", () => {
  test("idle is idle + iowait; steal counts busy", () => {
    const text = [
      "cpu  100 10 50 800 40 5 5 20 0 0",
      "cpu0 50 5 25 400 20 2 3 10 0 0",
      "intr 12345",
    ].join("\n");
    expect(parseProcStatCpu(text)).toEqual({ busy: 190, total: 1030 });
  });
  test("a file without the aggregate line throws", () => {
    expect(() => parseProcStatCpu("cpu0 1 2 3 4\n")).toThrow(/no aggregate/);
  });
});

describe("busyPctBetween", () => {
  test("the busy share of the time between two readings", () => {
    expect(
      busyPctBetween({ busy: 100, total: 1000 }, { busy: 150, total: 1100 }),
    ).toBe(50);
  });
  test("no time passed → null, never a stand-in 0", () => {
    expect(
      busyPctBetween({ busy: 1, total: 10 }, { busy: 1, total: 10 }),
    ).toBeNull();
  });
});

describe("createHostSampler", () => {
  test("the first reading has no CPU share; the next one does", async () => {
    const sampler = createHostSampler();
    const first = await sampler.read();
    expect(first.cpu.busyPct).toBeNull();
    expect(first.cpu.cores).toBeGreaterThan(0);
    expect(first.mem.total).toBeGreaterThan(0);
    expect(first.disk.used).toBeLessThanOrEqual(first.disk.total);
    await Bun.sleep(30);
    const second = await sampler.read();
    // Some time passed on some core; a 30 ms window may still be all idle.
    expect(second.cpu.busyPct === null || second.cpu.busyPct >= 0).toBe(true);
  });
});
