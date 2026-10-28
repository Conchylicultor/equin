import { expect, test } from "bun:test";
import { formatUsd } from "./format";

test("formatUsd draws US dollars to the cent", () => {
  expect(formatUsd(42.17)).toBe("$42.17");
  expect(formatUsd(0)).toBe("$0.00");
  expect(formatUsd(1234.5)).toBe("$1,234.50");
  expect(formatUsd(0.004)).toBe("$0.00");
});
