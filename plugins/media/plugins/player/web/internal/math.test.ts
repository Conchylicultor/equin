import { describe, expect, test } from "bun:test";
import {
  DIAL_PX_PER_STEP,
  RATE_MAX,
  RATE_MIN,
  bufferedEnd,
  clickRate,
  dialTicks,
  digitTarget,
  dragRate,
  formatTime,
  fractionAt,
  keyRate,
  rateReadout,
  rateShort,
  rulerOffset,
  seekKeyTarget,
  skipSeconds,
  skipTarget,
  snapRate,
  toggleMute,
  volumeGlyph,
  volumeTarget,
  wheelRate,
} from "./math";

describe("formatTime", () => {
  test("minutes and seconds", () => {
    expect(formatTime(0)).toBe("0:00");
    expect(formatTime(5.9)).toBe("0:05");
    expect(formatTime(65)).toBe("1:05");
  });
  test("hours pad the minutes", () => {
    expect(formatTime(3600 + 62)).toBe("1:01:02");
  });
  test("an unknown duration reads 0:00", () => {
    expect(formatTime(Number.NaN)).toBe("0:00");
    expect(formatTime(Number.POSITIVE_INFINITY)).toBe("0:00");
  });
});

describe("seek maths", () => {
  test("fractionAt clamps to the track", () => {
    expect(fractionAt(150, 100, 200)).toBe(0.25);
    expect(fractionAt(50, 100, 200)).toBe(0);
    expect(fractionAt(400, 100, 200)).toBe(1);
    expect(fractionAt(10, 0, 0)).toBe(0);
  });
  test("bufferedEnd takes the range the playhead is in", () => {
    const ranges = {
      length: 2,
      start: (i: number) => [0, 30][i]!,
      end: (i: number) => [10, 40][i]!,
    };
    expect(bufferedEnd(ranges, 5)).toBe(10);
    expect(bufferedEnd(ranges, 29.6)).toBe(40);
  });
  test("skips and digit jumps stay within the media", () => {
    expect(skipTarget(2, -5, 60)).toBe(0);
    expect(skipTarget(58, 5, 60)).toBe(60);
    expect(digitTarget(3, 60)).toBe(18);
    expect(digitTarget(3, Number.NaN)).toBe(0);
  });
  test("a skip is 5 s of watching: media time scaled by the rate", () => {
    expect(skipSeconds(1)).toBe(5);
    expect(skipSeconds(0.25)).toBe(1.25);
    expect(skipSeconds(2)).toBe(10);
    expect(seekKeyTarget("ArrowLeft", 30, 60, 0.5)).toBe(27.5);
    expect(seekKeyTarget("PageUp", 30, 60, 0.5)).toBe(36);
  });
});

describe("volume mapping", () => {
  test("0 mutes, the ends clamp", () => {
    expect(volumeTarget(0)).toEqual({ volume: 0, muted: true });
    expect(volumeTarget(-0.2)).toEqual({ volume: 0, muted: true });
    expect(volumeTarget(1.3)).toEqual({ volume: 1, muted: false });
    expect(volumeTarget(0.4)).toEqual({ volume: 0.4, muted: false });
  });
  test("unmuting a level of 0 comes back at half", () => {
    expect(toggleMute(0.7, false)).toEqual({ volume: 0.7, muted: true });
    expect(toggleMute(0.7, true)).toEqual({ volume: 0.7, muted: false });
    expect(toggleMute(0, true)).toEqual({ volume: 0.5, muted: false });
  });
  test("the glyph follows the level", () => {
    expect(volumeGlyph(0)).toBe("off");
    expect(volumeGlyph(0.49)).toBe("down");
    expect(volumeGlyph(0.5)).toBe("up");
  });
});

describe("speed dial", () => {
  test("snaps to the step and clamps to the range", () => {
    expect(snapRate(1.07)).toBe(1.05);
    expect(snapRate(1.13)).toBe(1.15);
    expect(snapRate(0.1)).toBe(RATE_MIN);
    expect(snapRate(9)).toBe(RATE_MAX);
  });
  test("the needle sits over the speed", () => {
    expect(rulerOffset(RATE_MIN)).toBe(0);
    expect(rulerOffset(1)).toBeCloseTo(-15 * DIAL_PX_PER_STEP);
  });
  test("dragging right slows down, unsnapped and clamped", () => {
    expect(dragRate(1, DIAL_PX_PER_STEP)).toBeCloseTo(0.95);
    expect(dragRate(1, -DIAL_PX_PER_STEP / 2)).toBeCloseTo(1.025);
    expect(dragRate(1, 10_000)).toBe(RATE_MIN);
  });
  test("a click picks the speed under the pointer", () => {
    expect(clickRate(1, 4 * DIAL_PX_PER_STEP)).toBe(1.2);
    expect(clickRate(1, -2.4 * DIAL_PX_PER_STEP)).toBe(0.9);
  });
  test("the wheel moves half a step per ruler pixel along its larger axis", () => {
    expect(wheelRate(1, 0, 2 * DIAL_PX_PER_STEP)).toBeCloseTo(1.05);
    expect(wheelRate(1, -2 * DIAL_PX_PER_STEP, 1)).toBeCloseTo(0.95);
  });
  test("keys step and jump", () => {
    expect(keyRate(1, "ArrowRight")).toBe(1.05);
    expect(keyRate(1, "ArrowDown")).toBe(0.95);
    expect(keyRate(RATE_MAX, "ArrowUp")).toBe(RATE_MAX);
    expect(keyRate(1, "Home")).toBe(RATE_MIN);
    expect(keyRate(1, "End")).toBe(RATE_MAX);
    expect(keyRate(1, "a")).toBeNull();
  });
  test("ticks: majors every 0.5, mids every 0.25", () => {
    const ticks = dialTicks();
    expect(ticks).toHaveLength(56);
    expect(ticks[0]).toEqual({ rate: 0.25, x: 0, kind: "mid" });
    expect(ticks.find((t) => t.rate === 1)?.kind).toBe("major");
    expect(ticks.find((t) => t.rate === 1.25)?.kind).toBe("mid");
    expect(ticks.find((t) => t.rate === 1.3)?.kind).toBe("minor");
  });
  test("readouts", () => {
    expect(rateReadout(1.5)).toBe("1.50×");
    expect(rateShort(1.5)).toBe("1.5×");
    expect(rateShort(2)).toBe("2×");
  });
});
