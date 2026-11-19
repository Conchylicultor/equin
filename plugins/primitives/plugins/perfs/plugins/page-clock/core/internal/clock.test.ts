import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  asEpochMs,
  clockOffset,
  epochNow,
  epochToPerf,
  perfNow,
  perfToEpoch,
  perfToEpochAlong,
  readClocks,
} from "./clock";

// A simulated device: the wall clock always runs, the performance timeline
// only while awake (CLOCK_MONOTONIC on Android, mach_absolute_time on macOS).
const LOADED_AT = 1_763_500_000_000;
const device = { wall: LOADED_AT, perf: 0 };
const spies: { mockRestore(): void }[] = [];
beforeEach(() => {
  device.wall = LOADED_AT;
  device.perf = 0;
  spies.push(
    spyOn(Date, "now").mockImplementation(() => device.wall),
    spyOn(performance, "now").mockImplementation(() => device.perf),
  );
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("page-clock", () => {
  test("a stamp taken since the last wake lands where it happened on the wall clock", () => {
    device.wall += 1000;
    device.perf += 1000;
    device.wall += 3_600_000; // asleep an hour
    device.wall += 500;
    device.perf += 500;
    const stamp = perfNow();
    const wall = epochNow();
    device.wall += 2000;
    device.perf += 2000;
    expect(perfToEpoch(stamp)).toBe(wall);
    expect(epochToPerf(wall)).toBe(stamp);
    // timeOrigin + stamp: an hour behind.
    expect(LOADED_AT + stamp).toBe(wall - 3_600_000);
  });

  test("a later conversion takes the offset read when the stamps were taken", () => {
    const stamp = perfNow();
    const offset = clockOffset();
    device.wall += 3_600_000; // asleep after the stamp
    expect(perfToEpoch(stamp, offset)).toBe(asEpochMs(LOADED_AT));
    expect(epochToPerf(asEpochMs(LOADED_AT), offset)).toBe(stamp);
  });

  test("along a record, a stamp takes the next reading after it", () => {
    const readings = [readClocks()];
    device.wall += 400;
    device.perf += 400;
    const beforeSleep = perfNow();
    const beforeWall = epochNow();
    device.wall += 600;
    device.perf += 600;
    readings.push(readClocks());
    device.wall += 3_600_000; // asleep
    device.wall += 300;
    device.perf += 300;
    const afterWake = perfNow();
    const afterWall = epochNow();
    device.wall += 700;
    device.perf += 700;
    readings.push(readClocks());
    expect(perfToEpochAlong(beforeSleep, readings)).toBe(beforeWall);
    expect(perfToEpochAlong(afterWake, readings)).toBe(afterWall);
    expect(() => perfToEpochAlong(afterWake, [])).toThrow();
  });
});
