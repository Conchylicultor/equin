import { describe, expect, test } from "bun:test";
import { LABELS_HIDDEN, stepLabels, type LabelState } from "./labels";

const settle = (s: LabelState, r: number) => stepLabels(s, r, Infinity);
const shown = (s: LabelState) => ({ isl: s.isl.on, dist: s.dist.on });

describe("stepLabels", () => {
  test("at island-fit both groups show", () => {
    expect(shown(settle(LABELS_HIDDEN, 1))).toEqual({ isl: true, dist: true });
  });

  test("zoomed far out: island names only", () => {
    expect(shown(settle(LABELS_HIDDEN, 0.3))).toEqual({
      isl: true,
      dist: false,
    });
  });

  test("zoomed in close: neither", () => {
    expect(shown(settle(LABELS_HIDDEN, 2))).toEqual({
      isl: false,
      dist: false,
    });
  });

  test("districts: on inside [0.9, 1.3], off only outside [0.8, 1.4]", () => {
    let s = settle(LABELS_HIDDEN, 0.85);
    expect(s.dist.on).toBe(false);
    s = settle(s, 0.95);
    expect(s.dist.on).toBe(true);
    s = settle(s, 0.82);
    expect(s.dist.on).toBe(true);
    s = settle(s, 0.79);
    expect(s.dist.on).toBe(false);
    s = settle(s, 1.35);
    expect(s.dist.on).toBe(false);
    s = settle(s, 1.25);
    expect(s.dist.on).toBe(true);
    s = settle(s, 1.38);
    expect(s.dist.on).toBe(true);
    s = settle(s, 1.41);
    expect(s.dist.on).toBe(false);
  });

  test("islands: on at r ≤ 1.3, off above 1.4", () => {
    let s = settle(LABELS_HIDDEN, 1.35);
    expect(s.isl.on).toBe(false);
    s = settle(s, 1.3);
    expect(s.isl.on).toBe(true);
    s = settle(s, 1.4);
    expect(s.isl.on).toBe(true);
    s = settle(s, 1.41);
    expect(s.isl.on).toBe(false);
  });

  test("the fade runs on frame time and completes with the zoom held still", () => {
    let s = stepLabels(LABELS_HIDDEN, 1, 0.1);
    expect(s.isl.p).toBeCloseTo(1 / 3);
    s = stepLabels(s, 1, 0.1);
    s = stepLabels(s, 1, 0.1);
    s = stepLabels(s, 1, 0.1);
    expect(s.isl.p).toBe(1);
    s = stepLabels(s, 2, 0.15);
    expect(s.isl).toEqual({ on: false, p: 0.5 });
    s = stepLabels(s, 2, 0.15);
    expect(s.isl.p).toBeCloseTo(0);
  });
});
