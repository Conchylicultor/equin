import { expect, test } from "bun:test";
import { clusterRing, clusterSizePx, conicSlices, dropFill } from "./pin-paint";

test("a single colour fills the drop solid; several slice it from the visual top", () => {
  expect(dropFill(["#f97316"])).toBe("#f97316");
  expect(dropFill(["#f00", "#0f0", "#00f"])).toBe(
    "conic-gradient(from 45deg, #f00 0deg 120deg, #0f0 120deg 240deg, #00f 240deg 360deg)",
  );
  expect(() => dropFill([])).toThrow();
});

test("conic slices are proportional to their weights", () => {
  expect(
    conicSlices([
      ["#a", 3],
      ["#b", 1],
    ]),
  ).toBe("conic-gradient(from 0deg, #a 0deg 270deg, #b 270deg 360deg)");
});

test("a cluster ring spreads each place over its colours, heaviest first", () => {
  const { ring, done } = clusterRing([
    { colors: ["#a"], done: true },
    { colors: ["#a", "#b"], done: false },
    { colors: ["#c"], done: true },
  ]);
  expect(ring).toEqual([
    ["#a", 1.5],
    ["#c", 1],
    ["#b", 0.5],
  ]);
  expect(done).toBe(2);
});

test("cluster size steps with the count", () => {
  expect(clusterSizePx(3)).toBe(40);
  expect(clusterSizePx(10)).toBe(48);
  expect(clusterSizePx(25)).toBe(56);
});
