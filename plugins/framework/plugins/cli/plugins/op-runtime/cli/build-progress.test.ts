import { expect, test } from "bun:test";
import { foldBuildProgress, type BuildProgressRecord } from "./build-progress";

const base = { runId: "r1", pid: 42, worktree: "wt" };
const at = (s: number): string =>
  new Date(Date.UTC(2026, 8, 16, 22, 0, s)).toISOString();

// A heartbeat is a timer: it proves the process exists, not that the build is
// getting anywhere. The build lock's stall limit reads `lastAdvanceAt`, so a
// heartbeat moving it would let a build wedged on a hung child hold the lock
// forever.
test("a pending heartbeat moves lastActivityAt but not lastAdvanceAt", () => {
  const records: BuildProgressRecord[] = [
    { ...base, t: at(0), phase: "run", buildId: "b1", footprintMb: 1 },
    {
      ...base,
      t: at(1),
      phase: "enter",
      token: 1,
      id: "checks",
      step: "s",
      label: "checks",
      footprintMb: 1,
    },
    {
      ...base,
      t: at(31),
      phase: "pending",
      elapsedMs: 31_000,
      inFlight: ["checks"],
      footprintMb: 1,
      peakFootprintMb: 1,
    },
  ];
  const [run] = foldBuildProgress(records);
  expect(run!.lastActivityAt).toBe(at(31));
  expect(run!.lastAdvanceAt).toBe(at(1));
  expect(run!.outstanding.map((o) => o.label)).toEqual(["checks"]);
});

test("a leave advances the run", () => {
  const records: BuildProgressRecord[] = [
    { ...base, t: at(0), phase: "run", buildId: "b1", footprintMb: 1 },
    {
      ...base,
      t: at(1),
      phase: "enter",
      token: 1,
      id: "a",
      step: "s",
      label: "a",
      footprintMb: 1,
    },
    {
      ...base,
      t: at(9),
      phase: "leave",
      token: 1,
      id: "a",
      durationMs: 8_000,
      footprintMb: 1,
    },
  ];
  expect(foldBuildProgress(records)[0]!.lastAdvanceAt).toBe(at(9));
});
