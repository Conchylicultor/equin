import { describe, expect, test } from "bun:test";
import { centerCard, placeCard, sideOrder } from "./placement";

const frame = { width: 1000, height: 800 };
const card = { width: 300, height: 150 };

describe("placeCard", () => {
  test("below the target, centered on it", () => {
    const at = placeCard(
      { x: 400, y: 100, width: 200, height: 40 },
      card,
      frame,
      sideOrder("bottom"),
    );
    expect(at).toEqual({ x: 350, y: 154 });
  });

  test("flips above when there is no room below", () => {
    const at = placeCard(
      { x: 400, y: 700, width: 200, height: 40 },
      card,
      frame,
      sideOrder("bottom"),
    );
    expect(at.y).toBe(700 - 14 - 150);
  });

  test("clamps inside the frame's margin", () => {
    const at = placeCard(
      { x: 960, y: 10, width: 30, height: 30 },
      card,
      frame,
      sideOrder("bottom"),
    );
    expect(at.x).toBe(1000 - 300 - 12);
  });

  test("a side card sits beside the target's start", () => {
    const at = placeCard(
      { x: 100, y: 300, width: 200, height: 400 },
      card,
      frame,
      sideOrder("right"),
    );
    expect(at).toEqual({ x: 314, y: 300 + 100 - 40 });
  });

  test("centered", () => {
    expect(centerCard(card, frame)).toEqual({ x: 350, y: 325 });
  });
});
