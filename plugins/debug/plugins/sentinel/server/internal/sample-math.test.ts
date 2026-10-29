import { describe, expect, test } from "bun:test";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";
import {
  countBuildProcesses,
  counterDelta,
  FILL_MIN_SPAN_MS,
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
      "/bin/zsh ./equin build",
      `/bin/zsh ./${LEGACY_IDS.cliShim} build`, // the legacy name, still a shim
      `bun /repo/${LEGACY_IDS.cliShim} check type-check`,
      `${LEGACY_IDS.cliShim} push -m msg`,
      `vim ${LEGACY_IDS.cliShim}-notes.md`, // not a CLI invocation
      `vite serve dev/${LEGACY_IDS.cliShim}/web`, // path mention only, no CLI verb after the name
      `grep ${LEGACY_IDS.cliShim} build.log`, // the shim name is a grep arg... matches shape
    ].join("\n");
    // The grep line legitimately matches the loose shape — the count is a
    // pressure gauge, not an exact census; one-off false positives are noise
    // the detector's dwell absorbs.
    expect(countBuildProcesses(ps)).toBe(5);
  });
  test("empty output → 0", () => {
    expect(countBuildProcesses("")).toBe(0);
  });
});

describe("pushFreeSpace", () => {
  test("is null until the window spans its minimum, then the fall per second", () => {
    const window: FreeSpacePoint[] = [];
    const half = FILL_MIN_SPAN_MS / 2;
    expect(
      pushFreeSpace(window, { wall: 0, freeBytes: FILL_MIN_SPAN_MS }),
    ).toBeNull();
    expect(
      pushFreeSpace(window, { wall: half, freeBytes: FILL_MIN_SPAN_MS - half }),
    ).toBeNull();
    expect(
      pushFreeSpace(window, { wall: FILL_MIN_SPAN_MS, freeBytes: 0 }),
    ).toBe(1_000);
  });

  test("a burst that stops reads as its size spread over the window", () => {
    const window: FreeSpacePoint[] = [];
    const GIB = 1024 ** 3;
    // 5 GiB written in the first two minutes, then nothing.
    pushFreeSpace(window, { wall: 0, freeBytes: 100 * GIB });
    pushFreeSpace(window, { wall: 120_000, freeBytes: 95 * GIB });
    const rate = pushFreeSpace(window, {
      wall: FILL_WINDOW_MS,
      freeBytes: 95 * GIB,
    });
    expect(rate! * 60).toBeCloseTo((5 * GIB * 60_000) / FILL_WINDOW_MS);
    expect(rate! * 60).toBeLessThan(GIB);
  });

  test("measures across the last window only", () => {
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
    expect(
      pushFreeSpace(window, {
        wall: FILL_MIN_SPAN_MS,
        freeBytes: FILL_MIN_SPAN_MS,
      }),
    ).toBe(-1_000);
  });
});
