import { describe, expect, test } from "bun:test";
import { selectorPreludes, unanchoredHas } from "./no-unanchored-has";

describe("unanchoredHas", () => {
  test("a bare :has() compound is unanchored", () => {
    expect(unanchoredHas(":has(.x)")).toEqual([":has(.x)"]);
    expect(unanchoredHas(".a :has(.x)")).toEqual([":has(.x)"]);
  });

  test("the old wide-table rules are both caught", () => {
    expect(
      unanchoredHas(
        ":where([data-scroll-x-host]:has([data-scrolls-x]) :has([data-scrolls-x]))",
      ),
    ).toEqual([":has([data-scrolls-x])"]);
    expect(
      unanchoredHas(
        ":where(:is([h]:has([t]), [h]:has([t]) :has([t])) > :not([t]):not(:has([t])))",
      ),
    ).toEqual([":has([t])", ":has([t])"]);
  });

  test("a class, attribute, type, id or & anchors it", () => {
    for (const sel of [
      ".focus-ring-within:has(:focus-visible)",
      "[data-copy-text]:not([data-copy-text='']):has(> *)",
      "label:has(input)",
      "#x:has(.y)",
      "&:has(:focus-visible)",
      ".chord-box:has(.chord-box-hit:enabled:hover)",
    ])
      expect(unanchoredHas(sel)).toEqual([]);
  });

  test("an anchor carries into :not/:is on the same element, not across a combinator", () => {
    expect(
      unanchoredHas(".cp-panel:not(:has([data-cp-icon])) .cp-setting"),
    ).toEqual([]);
    // `.b :has(.x)`'s last compound IS `.a`'s element; its first is another.
    expect(unanchoredHas(".a:is(.b :has(.x))")).toEqual([]);
    expect(unanchoredHas(".a:is(:has(.x) .b)")).toEqual([":has(.x)"]);
    expect(unanchoredHas(".a:is(:has(.x))")).toEqual([]);
  });

  test("a :has() argument is not itself a subject", () => {
    expect(unanchoredHas(".a:has(> :not(.b))")).toEqual([]);
  });
});

describe("selectorPreludes", () => {
  test("rule preludes, nested ones included; at-rules and comments skipped", () => {
    const css = `/* :has(.x) */ @layer base { .a { color: red; &:has(.b) { x: y } } }`;
    expect(selectorPreludes(css)).toEqual([".a", "&:has(.b)"]);
  });
});
