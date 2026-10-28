import { expect, test } from "bun:test";
import { formatOrdinal } from "./format";

test("formatOrdinal draws the digits ungrouped", () => {
  expect(formatOrdinal(3)).toBe("3");
  expect(formatOrdinal(1204)).toBe("1204");
  expect(() => formatOrdinal(Number.NaN)).toThrow();
});
