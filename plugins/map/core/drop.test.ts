import { expect, test } from "bun:test";
import { dropHeadSvg, dropTipPx, sliceWedges } from "./drop";

test("slice wedges split the disc evenly from the top, clockwise", () => {
  expect(sliceWedges(2, 10, 10)).toEqual([
    "M 10 10 L 10 0 A 10 10 0 0 1 10 20 Z",
    "M 10 10 L 10 20 A 10 10 0 0 1 10 0 Z",
  ]);
  expect(sliceWedges(4, 10, 10)[1]).toBe(
    "M 10 10 L 20 10 A 10 10 0 0 1 10 20 Z",
  );
  expect(() => sliceWedges(1, 10, 10)).toThrow();
});

test("the tip of a turned drop sits a radius plus √2·r below its top", () => {
  expect(dropTipPx(24)).toBe(29);
  expect(dropTipPx(30)).toBe(36);
});

test("a drop head escapes its colours and draws one slice per colour", () => {
  const svg = dropHeadSvg({
    shape: "drop",
    sizePx: 24,
    fills: ['#f00"><script>', "#0f0"],
    ring: "white",
    id: "t",
  });
  expect(svg).not.toContain("<script>");
  expect(svg.match(/<path d="M 12 12/g)?.length).toBe(2);
  expect(() =>
    dropHeadSvg({
      shape: "disc",
      sizePx: 10,
      fills: [],
      ring: "white",
      id: "t",
    }),
  ).toThrow();
});
