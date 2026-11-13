import { describe, expect, test } from "bun:test";
import { sharedWork } from "@plugins/packages/plugins/shared-work/core";
import {
  newSharedWallMeter,
  sharedWallWithin,
  withSharedWallMeter,
} from "./shared-wall";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("shared wall", () => {
  test("times the outermost shared work a unit starts, not the work nested in it", async () => {
    const meter = newSharedWallMeter();
    const t0 = performance.now();
    await withSharedWallMeter(meter, async () => {
      await sharedWork("tree", async () => {
        await sleep(20);
        await sharedWork("records", () => sleep(20));
      });
      await sleep(10); // the unit's own
    });
    const t1 = performance.now();
    expect(meter.intervals.map((i) => i.name)).toEqual(["tree"]);
    const { totalMs, byName } = sharedWallWithin(meter, t0, t1);
    expect(byName.tree).toBeGreaterThanOrEqual(35);
    expect(totalMs).toBe(byName.tree!);
    expect(t1 - t0 - totalMs).toBeGreaterThanOrEqual(8);
  });

  test("work still running when the unit ends counts up to its end", async () => {
    const meter = newSharedWallMeter();
    let release!: () => void;
    const t0 = performance.now();
    void withSharedWallMeter(meter, () =>
      sharedWork("slow", () => new Promise<void>((r) => (release = r))),
    );
    await sleep(15);
    const t1 = performance.now();
    expect(sharedWallWithin(meter, t0, t1).byName.slow).toBeGreaterThanOrEqual(
      10,
    );
    release();
  });

  test("shared work outside any unit is timed nowhere", async () => {
    const meter = newSharedWallMeter();
    await sharedWork("tree", () => sleep(5));
    expect(meter.intervals).toEqual([]);
  });

  test("clips to the window and gives an overlap to the earlier work", () => {
    const meter = {
      intervals: [
        { name: "a", start: 0, end: 50 },
        { name: "b", start: 40, end: 200 },
      ],
    };
    const { totalMs, byName } = sharedWallWithin(meter, 10, 100);
    expect(byName).toEqual({ a: 40, b: 50 });
    expect(totalMs).toBe(90);
  });
});
