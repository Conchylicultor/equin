import { describe, expect, test } from "bun:test";
import { unanchoredHas } from "./unanchored-has";

const compounds = (sel: string) => unanchoredHas(sel).map((f) => f.compound);

describe("unanchoredHas: the compound carrying the :has()", () => {
  test("a bare :has() compound is unanchored", () => {
    expect(unanchoredHas(":has(.x)")).toEqual([
      { compound: ":has(.x)", at: "has" },
    ]);
    expect(compounds(".a :has(.x)")).toEqual([":has(.x)"]);
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

  test(":is/:where anchor when every alternative ends anchored; :not never does", () => {
    expect(compounds(":where(.group\\/x):has(.y)")).toEqual([]);
    expect(compounds(":is(.a, [b]):has(.y)")).toEqual([]);
    expect(compounds(":is(.a, :hover):has(.y)")).toEqual([
      ":is(.a, :hover):has(.y)",
    ]);
    expect(compounds(":not(.a):has(.y)")).toEqual([":not(.a):has(.y)"]);
  });

  test("an anchor carries into :not/:is on the same element, not across a combinator", () => {
    expect(
      compounds(".cp-panel:not(:has([data-cp-icon])) .cp-setting"),
    ).toEqual([]);
    // `.b :has(.x)`'s last compound IS `.a`'s element; its first is another.
    expect(compounds(".a:is(.b :has(.x))")).toEqual([]);
    expect(compounds(".a:is(:has(.x) .b)")).toEqual([":has(.x)"]);
    expect(compounds(".a:is(:has(.x))")).toEqual([]);
  });

  test("a :has() argument is not itself a subject", () => {
    expect(compounds(".a:has(> :not(.b))")).toEqual([]);
  });
});

describe("unanchoredHas: compounds after the :has()", () => {
  test("a universal or pseudo-only follower is caught", () => {
    expect(unanchoredHas(".a:has(.x) *")).toEqual([
      { compound: "*", at: "after-has" },
    ]);
    expect(compounds(".a:has(.x) > :first-child")).toEqual([":first-child"]);
    expect(compounds(".a:has(.x) ~ :not(.b)")).toEqual([":not(.b)"]);
    expect(compounds(".a:has(.x) .b *")).toEqual(["*"]);
  });

  test("a named follower passes", () => {
    expect(compounds("[data-host]:has(:active) .cls")).toEqual([]);
    expect(compounds(".a:has(> [x]) > [y]:hover")).toEqual([]);
    expect(compounds(".a:has(.x) .b:not(:hover)")).toEqual([]);
  });

  test("a :has() nested in a same-element pseudo still starts the run", () => {
    expect(compounds(".a:not(:has(.x)) *")).toEqual(["*"]);
    expect(compounds(":is(.a:has(.x)) > *")).toEqual(["*"]);
  });

  test("inside an argument, a follower needs its OWN anchor (group-has-* shape)", () => {
    expect(compounds(".cls:is(:where(.group\\/x):has(.y) *)")).toEqual(["*"]);
    expect(compounds(".cls:is(:where(.peer):has(.y) ~ *)")).toEqual(["*"]);
    expect(compounds(".cls:is(:where(.g):not(*:has(.y)) *)")).toEqual(["*"]);
  });

  test("the old wide-table rules are caught", () => {
    expect(
      compounds(
        ":where([data-scroll-x-host]:has([data-scrolls-x]) :has([data-scrolls-x]))",
      ),
    ).toEqual([":has([data-scrolls-x])"]);
    expect(
      compounds(
        ":where(:is([h]:has([t]), [h]:has([t]) :has([t])) > :not([t]):not(:has([t])))",
      ),
    ).toEqual([":has([t])", ":not([t]):not(:has([t]))", ":has([t])"]);
  });

  test(":nth-child(… of S) is not a same-element argument", () => {
    expect(
      compounds(
        ".cls>.contents:nth-child(1 of :is([data-s],.contents:has(>[data-s])))>*",
      ),
    ).toEqual([]);
  });
});
