import { describe, expect, test } from "bun:test";
import { selectorPreludes } from "./no-unanchored-has";

describe("selectorPreludes", () => {
  test("rule preludes, nested ones included; at-rules and comments skipped", () => {
    const css = `/* :has(.x) */ @layer base { .a { color: red; &:has(.b) { x: y } } }`;
    expect(selectorPreludes(css).map((r) => r.prelude)).toEqual([
      ".a",
      "&:has(.b)",
    ]);
  });

  test("a nested rule resolves against its parent", () => {
    const css = `.a:has(.x) { color: red; > * { x: y } @media (x) { &.b { x: y } } } .c { x: y }`;
    expect(selectorPreludes(css).map((r) => r.resolved)).toEqual([
      ".a:has(.x)",
      ":is(.a:has(.x)) > *",
      ":is(.a:has(.x)).b",
      ".c",
    ]);
  });
});
