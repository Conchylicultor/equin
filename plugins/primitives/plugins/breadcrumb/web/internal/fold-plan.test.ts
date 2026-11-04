import { describe, it, expect } from "bun:test";
import { EXPAND_MARGIN_PX, SUBPIXEL_PX, planFold } from "./fold-plan";

const W = 60;
const FOLD = 30;
const five = [W, W, W, W, W];

describe("planFold", () => {
  it("leaves the trail unchanged with no deficit and nothing hidden", () => {
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: 0,
        free: 0,
        widths: five,
        foldUnit: undefined,
      }),
    ).toBe(0);
  });

  it("keeps the fold while there is no room to give anything back", () => {
    expect(
      planFold({
        hidden: 2,
        count: 5,
        deficit: 0,
        free: 0,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(2);
  });

  it("folds the fewest oldest ancestors that cover the deficit", () => {
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: 50,
        free: 0,
        widths: five,
        foldUnit: undefined,
      }),
    ).toBe(1);
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: 130,
        free: 0,
        widths: five,
        foldUnit: undefined,
      }),
    ).toBe(3);
  });

  it("counts the overflow crumb's own width against the first fold", () => {
    // One ancestor gives 60 but the crumb takes 30: net 30 < 50, so two fold.
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: 50,
        free: 0,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(2);
  });

  it("does not charge the overflow crumb again once it is showing", () => {
    expect(
      planFold({
        hidden: 1,
        count: 5,
        deficit: 50,
        free: 0,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(2);
  });

  it("folds everything when the deficit exceeds every ancestor", () => {
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: 10_000,
        free: 0,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(5);
  });

  it("unfolds nearest-first, several at once when they fit", () => {
    // room = 130 - 4 = 126: ancestor 2 (60) -> 66, ancestor 1 (60) -> 6,
    // ancestor 0 would cost 60 - 30 = 30 > 6.
    expect(
      planFold({
        hidden: 3,
        count: 5,
        deficit: 0,
        free: 130,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(1);
  });

  it("respects the expand margin", () => {
    const base = {
      hidden: 2,
      count: 5,
      deficit: 0,
      widths: five,
      foldUnit: FOLD,
    };
    expect(planFold({ ...base, free: W + EXPAND_MARGIN_PX - 1 })).toBe(2);
    expect(planFold({ ...base, free: W + EXPAND_MARGIN_PX })).toBe(1);
  });

  it("refunds the overflow crumb's width on the last unfold", () => {
    const base = {
      hidden: 1,
      count: 5,
      deficit: 0,
      widths: five,
      foldUnit: FOLD,
    };
    // Cost is 60 - 30 = 30, not 60.
    expect(planFold({ ...base, free: FOLD + EXPAND_MARGIN_PX })).toBe(0);
    expect(planFold({ ...base, free: FOLD + EXPAND_MARGIN_PX - 1 })).toBe(1);
  });

  it("shows everything when an unfolding ancestor was never measured", () => {
    expect(
      planFold({
        hidden: 2,
        count: 5,
        deficit: 0,
        free: 0,
        widths: [W, undefined, W, W, W],
        foldUnit: FOLD,
      }),
    ).toBe(0);
  });

  it("does not treat a subpixel deficit as a fold", () => {
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: SUBPIXEL_PX,
        free: 0,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(0);
    expect(
      planFold({
        hidden: 1,
        count: 5,
        deficit: SUBPIXEL_PX,
        free: 0,
        widths: five,
        foldUnit: FOLD,
      }),
    ).toBe(1);
    expect(
      planFold({
        hidden: 0,
        count: 5,
        deficit: SUBPIXEL_PX + 0.5,
        free: 0,
        widths: five,
        foldUnit: undefined,
      }),
    ).toBe(1);
  });
});
