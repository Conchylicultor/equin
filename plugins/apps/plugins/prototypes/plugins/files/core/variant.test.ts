import { describe, expect, test } from "bun:test";
import {
  parseVariantQuery,
  picksOfVariantParam,
  VARIANT_QUERY_PATTERN,
  variantParam,
} from "./variant";

describe("written variant", () => {
  test("parses choices and colors, lowercasing a hex", () => {
    expect(parseVariantQuery("?pane=floating&accent=#10B981")).toEqual({
      pane: "floating",
      accent: "#10b981",
    });
  });
  test("the pattern stops at the variant's end", () => {
    const m = VARIANT_QUERY_PATTERN.exec("see ?pane=floating&x. next");
    expect(m?.[0]).toBe("?pane=floating");
  });
  test("leaves out the reserved cache-bust", () => {
    expect(parseVariantQuery("?v=3&pane=flush")).toEqual({ pane: "flush" });
  });
  test("throws on text that is not one", () => {
    expect(() => parseVariantQuery("?pane")).toThrow();
  });
});

describe("variant param", () => {
  test("round-trips picks", () => {
    const picks = { pane: "floating", accent: "#10b981" };
    const param = variantParam(picks);
    expect(param).toBe("pane.floating~accent.#10b981");
    expect(picksOfVariantParam(param)).toEqual(picks);
  });
  test("no picks is `defaults`, distinct from an absent key", () => {
    expect(variantParam({})).toBe("defaults");
    expect(picksOfVariantParam("defaults")).toEqual({});
  });
  test("drops what is not a pick", () => {
    expect(picksOfVariantParam("pane.floating~bad~V.x~v.1")).toEqual({
      pane: "floating",
    });
  });
});
