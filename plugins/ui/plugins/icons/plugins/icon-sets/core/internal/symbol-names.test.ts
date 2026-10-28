import { describe, expect, it } from "bun:test";
import { readIconSet, symbolBaseNames } from "./symbol-names";

describe("symbolBaseNames (installed sets)", () => {
  const names = new Set(
    symbolBaseNames(
      readIconSet("@iconify-json/material-symbols"),
      readIconSet("@iconify-json/material-symbols-light"),
    ),
  );

  it("offers names drawn in only some styles", () => {
    for (const n of [
      "auto-awesome",
      "auto-mode",
      "auto-fix-high",
      "insights",
      "phone-iphone",
    ]) {
      expect(names.has(n)).toBe(true);
    }
  });

  it("never offers a style variant as a base", () => {
    expect(names.has("forum")).toBe(true);
    expect(names.has("forum-outline")).toBe(false);
    expect(names.has("forum-outline-rounded")).toBe(false);
  });

  it("keeps a glyph whose own name ends like a suffix, without inventing its stem", () => {
    expect(names.has("error-circle-rounded")).toBe(true);
    expect(names.has("error-circle")).toBe(false);
  });
});
