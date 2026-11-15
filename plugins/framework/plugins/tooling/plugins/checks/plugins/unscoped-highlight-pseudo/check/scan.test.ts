import { describe, expect, test } from "bun:test";
import { compoundBefore, unscopedHighlights } from "./scan";

const found = (src: string) => unscopedHighlights(src).map((h) => h.text);

describe("compoundBefore", () => {
  test("reads back to the compound's start, brackets and parens included", () => {
    const at = (s: string) => compoundBefore(s, s.indexOf("::highlight("));
    expect(at(".a .b::highlight(x) {}")).toBe(".b");
    expect(at('[data-x="a b"]::highlight(x) {}')).toBe('[data-x="a b"]');
    expect(at(".p :is(.a, .b)::highlight(x) {}")).toBe(":is(.a, .b)");
    expect(at("::highlight(x) {}")).toBe("");
  });
});

describe("unscopedHighlights", () => {
  test("flags a rule on every element", () => {
    expect(found("::highlight(x) { color: red; }")).toEqual(["::highlight(x)"]);
    expect(found("*::highlight(x) {}")).toEqual(["*::highlight(x)"]);
    expect(found(".a ::highlight(x) {}")).toEqual(["::highlight(x)"]);
    expect(found(".a > ::highlight(x) {}")).toEqual(["::highlight(x)"]);
    expect(found(".a::highlight(y), ::highlight(x) {}")).toEqual([
      "::highlight(x)",
    ]);
    expect(found("}\n::highlight(x) {}")).toEqual(["::highlight(x)"]);
  });
  test("passes a rule scoped to an element", () => {
    expect(found("[data-lexical-editor]::highlight(x) {}")).toEqual([]);
    expect(found(".host::highlight(x) {}")).toEqual([]);
    expect(found(".a :is(.b, .c)::highlight(x) {}")).toEqual([]);
    expect(found(".a { &::highlight(x) {} }")).toEqual([]);
  });
});
