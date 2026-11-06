import { expect, test } from "bun:test";
import { searchBias } from "./search-bias";

test("a city view is the bias box", () => {
  const bounds = {
    low: { lat: 48.8, lng: 2.3 },
    high: { lat: 48.9, lng: 2.4 },
  };
  expect(searchBias(bounds)).toEqual({ kind: "rectangle", ...bounds });
});

test("a view as wide as the world, or across the antimeridian past 180°, has none", () => {
  expect(
    searchBias({ low: { lat: -60, lng: -180 }, high: { lat: 85, lng: 180 } }),
  ).toBeUndefined();
  expect(
    searchBias({ low: { lat: 0, lng: 10 }, high: { lat: 10, lng: -100 } }),
  ).toBeUndefined();
  expect(
    searchBias({ low: { lat: 0, lng: 170 }, high: { lat: 10, lng: -170 } }),
  ).toEqual({
    kind: "rectangle",
    low: { lat: 0, lng: 170 },
    high: { lat: 10, lng: -170 },
  });
});
