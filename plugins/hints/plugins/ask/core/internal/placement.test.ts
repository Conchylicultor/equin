import { describe, expect, test } from "bun:test";
import { CORNER_MARGIN, TOP_RIGHT_CORNER_Y, placeAfterDrag } from "./placement";

const viewport = { width: 1200, height: 800 };
const size = { width: 380, height: 500 };

describe("placeAfterDrag", () => {
  test("a drop in the open stays exactly where it was dropped", () => {
    expect(placeAfterDrag({ left: 300, top: 120, ...size }, viewport)).toEqual({
      h: "left",
      hx: 300,
      v: "top",
      vy: 120,
    });
  });

  test("anchors to the edges nearest the card's centre", () => {
    // Centre at (890, 530): right half, bottom half.
    expect(placeAfterDrag({ left: 700, top: 280, ...size }, viewport)).toEqual({
      h: "right",
      hx: 1200 - 700 - 380,
      v: "bottom",
      vy: 800 - 280 - 500,
    });
  });

  test("a drop near a corner snaps into it", () => {
    expect(
      placeAfterDrag({ left: 30, top: 800 - 500 - 40, ...size }, viewport),
    ).toEqual({ h: "left", hx: CORNER_MARGIN, v: "bottom", vy: CORNER_MARGIN });
  });

  test("the top-right corner sits below the action bar", () => {
    const short = { width: 380, height: 200 };
    expect(
      placeAfterDrag({ left: 1200 - 380 - 20, top: 40, ...short }, viewport),
    ).toEqual({
      h: "right",
      hx: CORNER_MARGIN,
      v: "top",
      vy: TOP_RIGHT_CORNER_Y,
    });
  });

  test("near one edge but far from the corner does not snap", () => {
    const at = placeAfterDrag({ left: 20, top: 100, ...size }, viewport);
    expect(at).toEqual({ h: "left", hx: 20, v: "top", vy: 100 });
  });

  test("a drop past the viewport is pulled back inside it", () => {
    const at = placeAfterDrag({ left: -200, top: 100, ...size }, viewport);
    expect(at.h).toBe("left");
    expect(at.hx).toBe(8);
    const below = placeAfterDrag({ left: 400, top: 700, ...size }, viewport);
    expect(below).toMatchObject({ v: "bottom", vy: 8 });
  });
});
