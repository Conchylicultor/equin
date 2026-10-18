import { describe, expect, it } from "bun:test";
import {
  detectSnapZone,
  nextSnapAction,
  SNAP_GAP,
  snapRect,
  type SnapAction,
  type SnapZone,
} from "./use-snap";

const snap = (zone: SnapZone | null): SnapAction => ({ type: "snap", zone });
const MINIMIZE: SnapAction = { type: "minimize" };

describe("nextSnapAction", () => {
  it("tiles a free window to halves / maximize and minimizes on down", () => {
    expect(nextSnapAction(null, "left")).toEqual(snap("left"));
    expect(nextSnapAction(null, "right")).toEqual(snap("right"));
    expect(nextSnapAction(null, "up")).toEqual(snap("maximize"));
    expect(nextSnapAction(null, "down")).toEqual(MINIMIZE);
  });

  it("walks the vertical chain: half ↔ quarter ↔ minimize", () => {
    // left half: up -> top-left, down -> bottom-left
    expect(nextSnapAction("left", "up")).toEqual(snap("top-left"));
    expect(nextSnapAction("left", "down")).toEqual(snap("bottom-left"));
    // back to the half from either quarter
    expect(nextSnapAction("top-left", "down")).toEqual(snap("left"));
    expect(nextSnapAction("bottom-left", "up")).toEqual(snap("left"));
    // top of the chain stays; bottom of the chain minimizes
    expect(nextSnapAction("top-left", "up")).toEqual(snap("top-left"));
    expect(nextSnapAction("bottom-left", "down")).toEqual(MINIMIZE);
  });

  it("toggles halves off and flips quarters horizontally", () => {
    expect(nextSnapAction("left", "right")).toEqual(snap(null)); // restore
    expect(nextSnapAction("right", "left")).toEqual(snap(null));
    expect(nextSnapAction("top-left", "right")).toEqual(snap("top-right"));
    expect(nextSnapAction("bottom-right", "left")).toEqual(snap("bottom-left"));
    // already as far as it goes
    expect(nextSnapAction("left", "left")).toEqual(snap("left"));
    expect(nextSnapAction("top-right", "right")).toEqual(snap("top-right"));
  });

  it("maximize caps the vertical chain: down restores, then minimize", () => {
    expect(nextSnapAction("maximize", "down")).toEqual(snap(null));
    expect(nextSnapAction("maximize", "up")).toEqual(snap("maximize"));
    expect(nextSnapAction("maximize", "left")).toEqual(snap("left"));
    expect(nextSnapAction("maximize", "right")).toEqual(snap("right"));
  });
});

describe("detectSnapZone (mockup thresholds)", () => {
  // A 1200 × 800 work area: the corner band is min(120, 20% of 800) = 120.
  const W = 1200;
  const H = 800;

  it("arms a side half within the 10px edge band", () => {
    expect(detectSnapZone(10, 400, W, H)).toBe("left");
    expect(detectSnapZone(11, 400, W, H)).toBeNull();
    expect(detectSnapZone(W - 10, 400, W, H)).toBe("right");
    expect(detectSnapZone(W - 11, 400, W, H)).toBeNull();
    // Past the edge still counts as the edge.
    expect(detectSnapZone(-30, 400, W, H)).toBe("left");
  });

  it("promotes a side to a quarter inside the corner band", () => {
    expect(detectSnapZone(0, 119, W, H)).toBe("top-left");
    expect(detectSnapZone(0, 120, W, H)).toBe("left");
    expect(detectSnapZone(0, H - 119, W, H)).toBe("bottom-left");
    expect(detectSnapZone(W, 50, W, H)).toBe("top-right");
    expect(detectSnapZone(W, H - 50, W, H)).toBe("bottom-right");
  });

  it("caps the corner band at 20% of a short work area", () => {
    // 400px tall → 80px band.
    expect(detectSnapZone(0, 79, W, 400)).toBe("top-left");
    expect(detectSnapZone(0, 80, W, 400)).toBe("left");
  });

  it("maximizes only at the very top (≤ 2px) and never snaps at the bottom", () => {
    expect(detectSnapZone(600, 2, W, H)).toBe("maximize");
    expect(detectSnapZone(600, 3, W, H)).toBeNull();
    expect(detectSnapZone(600, H, W, H)).toBeNull();
  });
});

describe("snapRect (mockup work-area boxes)", () => {
  it("maximize fills the work area edge to edge, above the shelf reserve", () => {
    expect(snapRect("maximize", 1200, 800, 70)).toEqual({
      x: 0,
      y: 0,
      w: 1200,
      h: 730,
    });
  });

  it("halves and quarters keep the 6px gutter inside the work area", () => {
    expect(SNAP_GAP).toBe(6);
    const hw = (1200 - 18) / 2;
    const hh = (730 - 18) / 2;
    expect(snapRect("left", 1200, 800, 70)).toEqual({
      x: 6,
      y: 6,
      w: hw,
      h: 718,
    });
    expect(snapRect("right", 1200, 800, 70)).toEqual({
      x: 12 + hw,
      y: 6,
      w: hw,
      h: 718,
    });
    expect(snapRect("bottom-right", 1200, 800, 70)).toEqual({
      x: 12 + hw,
      y: 12 + hh,
      w: hw,
      h: hh,
    });
    // The bottom tile ends one gutter above the reserve.
    const br = snapRect("bottom-left", 1200, 800, 70);
    expect(br.y + br.h).toBe(730 - 6);
  });
});
