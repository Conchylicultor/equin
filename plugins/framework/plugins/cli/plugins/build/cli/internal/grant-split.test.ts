import { expect, test } from "bun:test";
import { checkPassUnits, frontendUnits } from "./grant-split";

test("a one-unit build runs its checks, then its frontend", () => {
  expect(checkPassUnits(1)).toBe(1);
  // One unit for the frontend too: it waits for the checks to hand it back.
  expect(frontendUnits(1, true)).toBe(1);
});

test("from two units up the check pass and the frontend never share a unit", () => {
  for (let units = 2; units <= 18; units++) {
    expect(checkPassUnits(units) + frontendUnits(units, true)).toBe(units);
    expect(frontendUnits(units, true)).toBeGreaterThanOrEqual(1);
  }
  expect([checkPassUnits(9), frontendUnits(9, true)]).toEqual([5, 4]);
});

test("with nothing validating beside it the frontend takes the whole grant", () => {
  expect(frontendUnits(9, false)).toBe(9);
  expect(frontendUnits(1, false)).toBe(1);
});
