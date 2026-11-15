import { describe, expect, it } from "bun:test";
import {
  canPan,
  fitAxisScale,
  initialZoom,
  isAtFit,
  visibleBox,
  wholeFit,
  zoomReducer,
  type ZoomAction,
  type ZoomState,
} from "./zoom-model";

const TALL = { width: 1400, height: 4000 };
const PANE = { width: 700, height: 800 };

function run(state: ZoomState, ...actions: ZoomAction[]): ZoomState {
  return actions.reduce(zoomReducer, state);
}

const measured = run(initialZoom(TALL), { type: "measure", viewport: PANE });

describe("zoom model", () => {
  it("starts fitted to the width, top first", () => {
    expect(measured.view).toEqual({ scale: 0.5, x: 0, y: 0 });
    expect(isAtFit(measured, "width")).toBe(true);
    expect(canPan(measured)).toBe(true);
    expect(visibleBox(measured)).toEqual({
      left: 0,
      top: 0,
      width: 700,
      height: 800,
    });
  });

  it("fit height shows the whole tall picture, centred, framed to it", () => {
    const s = run(measured, { type: "fit", fit: "height" });
    expect(s.view.scale).toBeCloseTo(0.2);
    expect(canPan(s)).toBe(false);
    expect(visibleBox(s)).toEqual({
      left: 210,
      top: 0,
      width: 280,
      height: 800,
    });
    expect(wholeFit(TALL, PANE)).toBe("height");
  });

  it("never zooms out past the whole picture", () => {
    const s = run(measured, { type: "zoom-by", factor: 0.01, x: 0, y: 0 });
    expect(s.view.scale).toBeCloseTo(0.2);
    expect(s.fit).toBeNull();
  });

  it("1:1 is the real size, around the centre", () => {
    const s = run(measured, { type: "actual-size" });
    expect(s.view.scale).toBe(1);
  });

  it("pans within the picture only", () => {
    const s = run(measured, {
      type: "pan",
      from: measured.view,
      dx: 0,
      dy: -100_000,
    });
    expect(s.view.y).toBe(PANE.height - TALL.height * 0.5);
    expect(s.view.x).toBe(0);
  });

  it("a resize re-applies the fit, keeping the reader's place", () => {
    const scrolled = {
      ...measured,
      view: { ...measured.view, y: -400 },
    };
    const s = run(scrolled, {
      type: "measure",
      viewport: { width: 1400, height: 800 },
    });
    expect(s.view).toEqual({ scale: 1, x: 0, y: -800 });
  });

  it("fit width may enlarge a small picture", () => {
    expect(
      fitAxisScale("width", { width: 200, height: 100 }, PANE),
    ).toBeCloseTo(3.5);
  });
});
