import { describe, it, expect } from "bun:test";

import { both, defineTokenGroup } from "./define-token-group";
import { defineSubTheme, subThemeBlockValues } from "./sub-theme";

const type = defineTokenGroup("type", {
  body: { default: "14px" },
  title: { default: "16px" },
});
const palette = defineTokenGroup("palette", {
  primary: { default: "blue", darkDefault: "navy" },
});

describe("defineSubTheme", () => {
  it("keeps the fragments as written and marks the result a sub-theme", () => {
    const sub = defineSubTheme({
      id: "reading",
      label: "Reading",
      fragments: [type.fragment(both({ body: "18px" }))],
    });
    expect(sub.kind).toBe("sub-theme");
    expect(sub.fragments).toEqual([
      { groupId: "type", light: { body: "18px" }, dark: { body: "18px" } },
    ]);
  });

  it("allows different values per mode, as long as both modes name the same tokens", () => {
    expect(() =>
      defineSubTheme({
        id: "tinted",
        label: "Tinted",
        fragments: [
          palette.fragment({
            light: { primary: "red" },
            dark: { primary: "maroon" },
          }),
        ],
      }),
    ).not.toThrow();
  });

  it("refuses a token set in one mode only, which would leak its light value onto a dark page", () => {
    expect(() =>
      defineSubTheme({
        id: "leaky",
        label: "Leaky",
        fragments: [palette.fragment({ light: { primary: "red" }, dark: {} })],
      }),
    ).toThrow(/names different tokens in light \(primary\) and dark \(\)/);
  });

  it("refuses an empty value — leaving the token out is how to keep the surrounding one", () => {
    expect(() =>
      defineSubTheme({
        id: "blank",
        label: "Blank",
        fragments: [type.fragment(both({ body: "" }))],
      }),
    ).toThrow(/token "body" of group "type" is empty/);
  });

  it("refuses two fragments for one group", () => {
    expect(() =>
      defineSubTheme({
        id: "twice",
        label: "Twice",
        fragments: [
          type.fragment(both({ body: "18px" })),
          type.fragment(both({ title: "30px" })),
        ],
      }),
    ).toThrow(/two fragments for token group "type"/);
  });

  it("refuses an id that cannot sit in a CSS selector and a style id", () => {
    expect(() =>
      defineSubTheme({ id: "Equin Doc", label: "x", fragments: [] }),
    ).toThrow(/must be kebab-case/);
    expect(() =>
      defineSubTheme({ id: "tweakcn:x", label: "x", fragments: [] }),
    ).toThrow(/must be kebab-case/);
  });
});

describe("subThemeBlockValues", () => {
  const density = defineTokenGroup("density", {
    padX: { default: "12px" },
    paneStart: { default: "var(--pad-x)" },
    paneInner: { default: "calc(var(--pane-start) / 2)" },
    padXWide: { default: "var(--pad-x-wide)" },
    gap: { default: "4px", darkDefault: "5px" },
  });

  it("re-declares every token derived from a named one, transitively, at its default", () => {
    expect(subThemeBlockValues(density, { padX: "40px" }, "light")).toEqual({
      padX: "40px",
      paneStart: "var(--pad-x)",
      paneInner: "calc(var(--pane-start) / 2)",
    });
  });

  it("keeps a derived token the sub-theme names itself, and re-derives what reads it", () => {
    expect(
      subThemeBlockValues(density, { padX: "40px", paneStart: "8px" }, "dark"),
    ).toEqual({
      padX: "40px",
      paneStart: "8px",
      paneInner: "calc(var(--pane-start) / 2)",
    });
  });

  it("follows a var read as another var's fallback, and a chain in schema order", () => {
    const chain = defineTokenGroup("chain", {
      c: { default: "calc(var(--b) * 2)" },
      a: { default: "1px" },
      b: { default: "var(--missing, var(--a))" },
      d: { default: "var( --c )" },
    });
    const out = subThemeBlockValues(chain, { a: "2px" }, "light");
    expect(out).toEqual({
      a: "2px",
      b: "var(--missing, var(--a))",
      c: "calc(var(--b) * 2)",
      d: "var( --c )",
    });
    expect(Object.keys(out)).toEqual(["a", "b", "c", "d"]);
  });

  it("matches the variable name exactly, not a prefix", () => {
    expect(subThemeBlockValues(density, { gap: "6px" }, "dark")).toEqual({
      gap: "6px",
    });
    expect(
      subThemeBlockValues(density, { padX: "1px" }, "light"),
    ).not.toHaveProperty("padXWide");
  });
});
