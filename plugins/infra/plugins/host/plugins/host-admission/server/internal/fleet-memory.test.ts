import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppPath } from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  cpuBudget,
  laneCapacity,
  PER_UNIT_BYTES,
  type FleetAdmission,
  type FleetMemoryReading,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import {
  claimUnmeasuredEpisode,
  fleetCapacity,
  publishFleetMemory,
} from "./fleet-memory";

// The feed against a throwaway directory — never the host's real reading,
// which every cpu grant on the box is sized from.

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir(): AppPath {
  const d = mkdtempSync(join(tmpdir(), "fleet-memory-"));
  dirs.push(d);
  return d as AppPath;
}

// A reading of THIS host that leaves room for exactly `slots` (≤ B) slots.
function readingFor(slots: number, sampledAt = Date.now()): FleetMemoryReading {
  return {
    sampledAt,
    ramBytes: 1_000e9,
    wiredBytes: 0,
    otherBytes: 1_000e9 - slots * PER_UNIT_BYTES - 1,
    opsBytes: 0,
    heldUnits: 0,
    holders: [],
  };
}

function nextMove(): {
  onMove: (c: number) => void;
  moved: Promise<number>;
} {
  let resolve!: (c: number) => void;
  const moved = new Promise<number>((r) => (resolve = r));
  return { onMove: (c) => resolve(c), moved };
}

const B = cpuBudget().B;

test("a waiter hears the window widen when a new reading is written", async () => {
  if (B < 3) return; // the host's own ceiling bounds the window
  const dir = tempDir();
  await publishFleetMemory(readingFor(1), dir);
  const seen: FleetAdmission[] = [];
  const feed = fleetCapacity("interactive", (a) => seen.push(a), dir);
  const { onMove, moved } = nextMove();
  const follow = await feed.follow(onMove, (err) => {
    throw err;
  });
  expect(follow.capacity).toBe(laneCapacity(1, "interactive"));

  await publishFleetMemory(readingFor(3), dir);
  expect(await moved).toBe(3);
  expect(seen.map((a) => a.kind)).toEqual(["measured", "measured"]);
  await follow.stop();
});

test("no reading: the unmeasured floor, and a first reading moves it", async () => {
  const dir = tempDir();
  const seen: FleetAdmission[] = [];
  const feed = fleetCapacity("background", (a) => seen.push(a), dir);
  const { onMove, moved } = nextMove();
  const follow = await feed.follow(onMove, (err) => {
    throw err;
  });
  expect(follow.capacity).toBe(1);
  expect(seen[0]).toMatchObject({ kind: "unmeasured", cause: "absent" });

  await publishFleetMemory(readingFor(B), dir);
  expect(await moved).toBe(laneCapacity(B, "background"));
  await follow.stop();
});

test("a reading whose lease runs out turns the feed unmeasured with no write", async () => {
  if (B < 3) return;
  const dir = tempDir();
  // Written 119.8 s ago: its 120 s lease ends in ~200 ms.
  await publishFleetMemory(readingFor(B, Date.now() - 119_800), dir);
  const seen: FleetAdmission[] = [];
  const feed = fleetCapacity("interactive", (a) => seen.push(a), dir);
  const { onMove, moved } = nextMove();
  const follow = await feed.follow(onMove, (err) => {
    throw err;
  });
  expect(follow.capacity).toBe(B);
  expect(await moved).toBe(2);
  expect(seen.at(-1)).toMatchObject({ kind: "unmeasured", cause: "stale" });
  await follow.stop();
});

test("a malformed reading fails the follow, loudly", async () => {
  const dir = tempDir();
  await publishFleetMemory(readingFor(1), dir);
  const feed = fleetCapacity("interactive", () => {}, dir);
  let fail!: (err: unknown) => void;
  const failed = new Promise<unknown>((r) => (fail = r));
  const follow = await feed.follow(() => {}, fail);
  await Bun.write(join(dir, "fleet-memory.json"), "{not json");
  expect(await failed).toBeInstanceOf(SyntaxError);
  await follow.stop();
});

test("an unmeasured episode is claimed once host-wide, a new one again", async () => {
  const dir = tempDir();
  const stale = (sampledAt: number) =>
    ({
      kind: "unmeasured",
      cause: "stale",
      ageMs: 200_000,
      sampledAt,
      slots: 2,
    }) as const;
  expect(await claimUnmeasuredEpisode(stale(1), dir)).toBe(true);
  expect(await claimUnmeasuredEpisode(stale(1), dir)).toBe(false);
  expect(await claimUnmeasuredEpisode(stale(2), dir)).toBe(true);
  const absent = {
    kind: "unmeasured",
    cause: "absent",
    ageMs: null,
    sampledAt: null,
    slots: 2,
  } as const;
  expect(await claimUnmeasuredEpisode(absent, dir)).toBe(true);
  expect(await claimUnmeasuredEpisode(absent, dir)).toBe(false);
});
