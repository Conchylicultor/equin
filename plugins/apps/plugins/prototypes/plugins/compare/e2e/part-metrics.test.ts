import { describe, expect, test } from "bun:test";
import { normalizeBoxShadow } from "./part-metrics";

const REAL =
  "rgba(0, 0, 0, 0.42) 0px 16px 44px 0px, rgba(255, 255, 255, 0.12) 0px 1px 0px 0px inset";
const PLACEHOLDER = "rgba(0, 0, 0, 0) 0px 0px 0px 0px";

describe("normalizeBoxShadow", () => {
  test("drops transparent placeholder layers", () => {
    const app = `${[PLACEHOLDER, PLACEHOLDER, PLACEHOLDER, PLACEHOLDER].join(", ")}, ${REAL}`;
    expect(normalizeBoxShadow(app)).toBe(normalizeBoxShadow(REAL));
    expect(normalizeBoxShadow(REAL)).toBe(REAL);
  });
  test("nothing visible reads none", () => {
    expect(normalizeBoxShadow(`${PLACEHOLDER}, ${PLACEHOLDER}`)).toBe("none");
    expect(normalizeBoxShadow("none")).toBe("none");
  });
  test("modern colour functions with a slash alpha", () => {
    expect(normalizeBoxShadow("oklab(0 0 0 / 0) 0px 0px 0px 0px")).toBe("none");
    expect(normalizeBoxShadow("oklab(0 0 0 / 0.3) 0px 2px 4px 0px")).toBe(
      "oklab(0 0 0 / 0.3) 0px 2px 4px 0px",
    );
  });
});
