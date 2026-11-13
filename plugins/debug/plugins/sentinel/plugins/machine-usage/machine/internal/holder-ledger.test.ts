import { expect, test } from "bun:test";
import {
  PER_UNIT_BYTES,
  type CpuHolderMarker,
  type HolderPeakRecord,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import type { PsProcess } from "../../core";
import { createHolderLedger, measureHolderTrees } from "./holder-ledger";

const GB = 1e9;

// The process's memory now rides in `rssBytes` (read back by `memOf`), its
// lifetime peak in `cpuTimeMs` (read back by `peakOf`) — test plumbing only.
function proc(pid: number, ppid: number, mem: number, peak = mem): PsProcess {
  return { pid, ppid, cpu: 0, rssBytes: mem, cpuTimeMs: peak, args: "x" };
}
const memOf = (p: PsProcess): number => p.rssBytes;
const peakOf = (p: PsProcess): number => p.cpuTimeMs;

function marker(
  pid: number,
  m: Partial<CpuHolderMarker> = {},
): CpuHolderMarker {
  return {
    v: 1,
    pid,
    work: "build",
    units: 2,
    lane: "background",
    since: 1,
    ...m,
  };
}

test("a holder is measured on its whole tree, stopping at a nested holder", () => {
  const procs = [
    proc(10, 1, 1 * GB),
    proc(11, 10, 2 * GB),
    proc(12, 11, 0.5 * GB, 4 * GB), // spiked between readings
    proc(20, 10, 3 * GB), // a nested share's holder, measured as itself
    proc(21, 20, 1 * GB),
  ];
  const outer = marker(10);
  const inner = marker(20, { work: "job", units: 1 });
  const got = measureHolderTrees(procs, [outer, inner], memOf, peakOf);
  expect(got.get(outer)).toEqual({
    bytes: 3.5 * GB,
    peakBytes: 7 * GB,
    shared: false,
  });
  expect(got.get(inner)).toEqual({
    bytes: 4 * GB,
    peakBytes: 4 * GB,
    shared: false,
  });
});

test("a holder ps no longer lists measures nothing", () => {
  const m = marker(99);
  expect(
    measureHolderTrees(
      [],
      [m],
      () => 1,
      () => 1,
    ).get(m),
  ).toEqual({
    bytes: 0,
    peakBytes: 0,
    shared: false,
  });
});

test("a second share of one process holds its reservation and records no peak", async () => {
  const a = marker(40, { since: 1 });
  const b = marker(40, { since: 2 });
  const trees = measureHolderTrees(
    [proc(40, 1, 2 * GB)],
    [a, b],
    memOf,
    peakOf,
  );
  expect(trees.get(a)).toEqual({
    bytes: 2 * GB,
    peakBytes: 2 * GB,
    shared: false,
  });
  expect(trees.get(b)).toEqual({ bytes: 0, peakBytes: 0, shared: true });
  const recorded: HolderPeakRecord[] = [];
  const ledger = createHolderLedger({
    readPeaks: async () => [],
    recordPeak: async (r) => {
      recorded.push(r);
    },
    nowMs: () => 0,
  });
  await ledger.observe(trees);
  await ledger.observe(new Map());
  expect(recorded.map((r) => r.peakBytes)).toEqual([2 * GB]);
});

const tree = (bytes: number, peakBytes = bytes) => ({
  bytes,
  peakBytes,
  shared: false,
});

test("an ended holder's peak is recorded, and its work's reservation follows the record", async () => {
  let now = Date.parse("2026-11-13T12:00:00Z");
  const recorded: HolderPeakRecord[] = [];
  // Nine earlier test holders: one more makes the work measured.
  const earlier: HolderPeakRecord[] = Array.from({ length: 9 }, () => ({
    t: new Date(now - 3_600_000).toISOString(),
    work: "test",
    units: 1,
    lane: "background",
    peakBytes: 1 * GB,
    samples: 3,
    seenMs: 60_000,
  }));
  const ledger = createHolderLedger({
    readPeaks: async () => [...earlier],
    recordPeak: async (r) => {
      recorded.push(r);
    },
    nowMs: () => now,
  });
  const t = marker(30, { work: "test", units: 1 });
  let readings = await ledger.observe(new Map([[t, tree(0.4 * GB)]]));
  expect(readings[0]).toMatchObject({
    reserveBasis: "unmeasured",
    reserveBytes: PER_UNIT_BYTES,
  });
  now += 30_000;
  // 1.2 GB now, but one of its processes peaked at 2 GB between readings.
  await ledger.observe(new Map([[t, tree(1.2 * GB, 2 * GB)]]));
  now += 30_000;
  const next = marker(31, { work: "test", units: 1 });
  readings = await ledger.observe(new Map([[next, tree(0.1 * GB)]]));
  expect(recorded).toEqual([
    {
      t: new Date(now - 30_000).toISOString(),
      work: "test",
      units: 1,
      lane: "background",
      peakBytes: 2 * GB,
      samples: 2,
      seenMs: 30_000,
    },
  ]);
  expect(readings[0]).toMatchObject({
    bytes: 0.1 * GB,
    reserveBasis: "measured",
    reserveBytes: 2 * GB,
  });
});
