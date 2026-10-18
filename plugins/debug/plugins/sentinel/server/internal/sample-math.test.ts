import { describe, expect, test } from "bun:test";
import {
  countBuildProcesses,
  counterDelta,
  FILL_WINDOW_MS,
  mapPgStatsRow,
  pushFreeSpace,
  type FreeSpacePoint,
} from "./sample-math";

describe("mapPgStatsRow", () => {
  // The int8 counts and the numeric sum arrive as STRINGS from node-postgres;
  // blk_read_time is a float8 and arrives as a number. See PgStatsRowSchema.
  test("converts pg's string counts and defaults the nullable columns", () => {
    expect(
      mapPgStatsRow({
        locks_waiting: "3",
        blk_read_time: 1234.5,
        xact_commit: "42",
        wait_events: { IO: 4, LWLock: 1 },
        active_backends: "7",
        total_backends: "31",
      }),
    ).toEqual({
      locksWaiting: 3,
      blkReadTimeMs: 1234.5,
      xactCommit: 42,
      waitEvents: { IO: 4, LWLock: 1 },
      activeBackends: 7,
      totalBackends: 31,
    });
    // Only the three genuinely-nullable columns can be null: a `sum` over no
    // rows, and a `json_object_agg` with nothing to aggregate.
    expect(
      mapPgStatsRow({
        locks_waiting: "0",
        blk_read_time: null,
        xact_commit: null,
        wait_events: null,
        active_backends: "0",
        total_backends: "0",
      }),
    ).toEqual({
      locksWaiting: 0,
      blkReadTimeMs: 0,
      xactCommit: 0,
      waitEvents: {},
      activeBackends: 0,
      totalBackends: 0,
    });
  });
});

describe("counterDelta", () => {
  test("null baseline → null (first tick)", () => {
    expect(counterDelta(null, 100)).toBeNull();
  });
  test("normal advance", () => {
    expect(counterDelta(100, 250)).toBe(150);
  });
  test("counter reset (pg restart) → null, not a bogus negative spike", () => {
    expect(counterDelta(500, 20)).toBeNull();
  });
});

describe("countBuildProcesses", () => {
  test("counts CLI build/check/push invocations, ignores noise", () => {
    const ps = [
      "/bin/zsh ./singularity build",
      "bun /repo/singularity check type-check",
      "singularity push -m msg",
      "vim singularity-notes.md", // not a CLI invocation
      "vite serve dev/singularity/web", // path mention only, no CLI verb after the name
      "grep singularity build.log", // 'singularity' is a grep arg... matches shape
    ].join("\n");
    // The grep line legitimately matches the loose shape — the count is a
    // pressure gauge, not an exact census; one-off false positives are noise
    // the detector's dwell absorbs.
    expect(countBuildProcesses(ps)).toBe(4);
  });
  test("empty output → 0", () => {
    expect(countBuildProcesses("")).toBe(0);
  });
});

describe("pushFreeSpace", () => {
  test("is null until the window spans a minute, then the fall per second", () => {
    const window: FreeSpacePoint[] = [];
    expect(pushFreeSpace(window, { wall: 0, freeBytes: 1_000_000 })).toBeNull();
    expect(
      pushFreeSpace(window, { wall: 30_000, freeBytes: 970_000 }),
    ).toBeNull();
    expect(pushFreeSpace(window, { wall: 60_000, freeBytes: 940_000 })).toBe(
      1_000,
    );
  });

  test("measures across the last two minutes only", () => {
    const window: FreeSpacePoint[] = [];
    // A fall long ago, then a flat disk: the old fall leaves the window.
    pushFreeSpace(window, { wall: 0, freeBytes: 2_000_000 });
    pushFreeSpace(window, { wall: 10_000, freeBytes: 1_000_000 });
    for (let wall = 20_000; wall <= FILL_WINDOW_MS + 20_000; wall += 5_000)
      pushFreeSpace(window, { wall, freeBytes: 1_000_000 });
    expect(
      pushFreeSpace(window, {
        wall: FILL_WINDOW_MS + 25_000,
        freeBytes: 1_000_000,
      }),
    ).toBe(0);
    expect(window[0]!.wall).toBeGreaterThanOrEqual(25_000);
  });

  test("reads negative while space comes back", () => {
    const window: FreeSpacePoint[] = [];
    pushFreeSpace(window, { wall: 0, freeBytes: 0 });
    expect(pushFreeSpace(window, { wall: 100_000, freeBytes: 100_000 })).toBe(
      -1_000,
    );
  });
});
