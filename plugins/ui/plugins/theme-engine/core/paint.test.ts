import { describe, it, expect } from "bun:test";

import { both, defineTokenGroup } from "./define-token-group";
import { defineFixedTheme } from "./fixed-theme";
import {
  CANVAS_STYLE_ID,
  paintThemeStyles,
  themePainter,
  themeStyleId,
} from "./paint";
import { defineSubTheme } from "./sub-theme";
import { DEFAULT_THEME_ID, defineTheme, type Theme } from "./theme";

const palette = defineTokenGroup("palette", {
  primary: { default: "blue" },
  background: { default: "white", darkDefault: "black" },
});
const shape = defineTokenGroup("shape", {
  radius: { default: "0.5rem" },
  pad: { default: "var(--radius)" },
});
const groups = [palette, shape];

const defaultTheme = defineTheme({
  id: DEFAULT_THEME_ID,
  label: "Default",
  fragments: [],
});
const red = defineTheme({
  id: "red",
  label: "Red",
  fragments: [palette.fragment({ light: { primary: "red" }, dark: {} })],
});
const card = defineSubTheme({
  id: "card",
  label: "Card",
  fragments: [shape.fragment(both({ radius: "1rem" }))],
});
const chrome = defineFixedTheme({
  id: "chrome",
  label: "Chrome",
  scheme: "dark",
  fragments: [palette.fragment({ light: {}, dark: { primary: "grey" } })],
});

const themesById = new Map<string, Theme>(
  [defaultTheme, red].map((t) => [t.id, t]),
);
const sources = {
  groups,
  themesById,
  subThemes: [card],
  fixedThemes: [chrome],
};

describe("paintThemeStyles", () => {
  it("paints the root, other apps, sub-themes and fixed themes, in mount order", () => {
    const styles = paintThemeStyles(sources, {
      baseThemeId: "red",
      canvasThemeId: "red",
      appThemes: [{ appId: "home", themeId: DEFAULT_THEME_ID }],
    });
    expect(Object.keys(styles)).toEqual([
      "theme-engine-palette",
      "theme-engine-shape",
      "theme-scope-app:home-palette",
      "theme-scope-app:home-shape",
      "theme-engine-canvas",
      "theme-scope-sub:card-shape",
      "theme-scope-fixed:chrome-palette",
      "theme-scope-fixed:chrome-shape",
    ]);
    expect(styles["theme-engine-palette"]).toBe(
      ":root {\n  --primary: red;\n  --background: white;\n}\n.dark {\n  --primary: blue;\n  --background: black;\n}",
    );
    expect(styles["theme-scope-app:home-palette"]).toStartWith(
      '[data-theme-scope="app:home"] {\n  --primary: blue;',
    );
  });

  it("paints the canvas on <body> alone, from the canvas theme's --background", () => {
    const styles = paintThemeStyles(sources, {
      baseThemeId: DEFAULT_THEME_ID,
      appThemes: [],
      canvasThemeId: "red",
    });
    expect(styles[CANVAS_STYLE_ID]).toBe(
      "body {\n  background-color: white;\n}\n.dark body {\n  background-color: black;\n}",
    );
    // The canvas never re-roots the tokens: :root stays the base theme's.
    expect(styles["theme-engine-palette"]).toStartWith(
      ":root {\n  --primary: blue;",
    );
  });

  it("writes a sub-theme's named tokens plus the ones derived from them, nothing else", () => {
    const styles = paintThemeStyles(sources, {
      baseThemeId: DEFAULT_THEME_ID,
      canvasThemeId: DEFAULT_THEME_ID,
      appThemes: [],
    });
    expect(styles[themeStyleId("shape", "sub:card")]).toBe(
      '[data-theme-scope="sub:card"] {\n  --radius: 1rem;\n  --pad: var(--radius);\n}\n.dark [data-theme-scope="sub:card"] {\n  --radius: 1rem;\n  --pad: var(--radius);\n}',
    );
  });

  it("wears a fixed theme's scheme in both modes", () => {
    const styles = paintThemeStyles(sources, {
      baseThemeId: DEFAULT_THEME_ID,
      canvasThemeId: DEFAULT_THEME_ID,
      appThemes: [],
    });
    expect(styles["theme-scope-fixed:chrome-palette"]).toBe(
      '[data-theme-scope="fixed:chrome"] {\n  --primary: grey;\n  --background: black;\n}\n.dark [data-theme-scope="fixed:chrome"] {\n  --primary: grey;\n  --background: black;\n}',
    );
  });

  it("paints Default for a selection naming no theme, as the browser does", () => {
    const missing = paintThemeStyles(sources, {
      baseThemeId: "gone",
      canvasThemeId: "gone",
      appThemes: [],
    });
    const fallback = paintThemeStyles(sources, {
      baseThemeId: DEFAULT_THEME_ID,
      canvasThemeId: DEFAULT_THEME_ID,
      appThemes: [],
    });
    expect(missing).toEqual(fallback);
  });

  it("applies the theme's color adjustment", () => {
    const tinted: Theme = {
      id: "tinted",
      label: "Tinted",
      source: "custom",
      fragments: [
        palette.fragment({
          light: { primary: "oklch(0.5 0.1 100)" },
          dark: {},
        }),
      ],
      colorAdjust: { hueShift: 10, saturationScale: 1, lightnessScale: 1 },
    };
    const styles = paintThemeStyles(
      { ...sources, themesById: new Map([...themesById, ["tinted", tinted]]) },
      { baseThemeId: "tinted", canvasThemeId: "tinted", appThemes: [] },
    );
    expect(styles["theme-engine-palette"]).toContain(
      "--primary: oklch(0.5000 0.1000 110.00);",
    );
  });

  it("paints an `initial` default as the CSS-wide keyword, leaving the var unset", () => {
    const optIn = defineTokenGroup("opt-in", {
      inset: { default: "initial" },
    });
    const styles = paintThemeStyles(
      { ...sources, groups: [optIn, palette] },
      {
        baseThemeId: DEFAULT_THEME_ID,
        canvasThemeId: DEFAULT_THEME_ID,
        appThemes: [],
      },
    );
    // `--inset: initial` is the guaranteed-invalid value: every
    // `var(--inset, fallback)` takes its fallback, i.e. the consumer's own.
    expect(styles["theme-engine-opt-in"]).toBe(
      ":root {\n  --inset: initial;\n}\n.dark {\n  --inset: initial;\n}",
    );
  });
});

describe("themePainter", () => {
  it("paints each selection exactly as paintThemeStyles does, in its order, whatever it painted before", () => {
    const painter = themePainter(sources);
    const selections = [
      {
        baseThemeId: DEFAULT_THEME_ID,
        canvasThemeId: DEFAULT_THEME_ID,
        appThemes: [{ appId: "a", themeId: "red" }],
      },
      { baseThemeId: "red", canvasThemeId: "red", appThemes: [] },
      {
        baseThemeId: DEFAULT_THEME_ID,
        canvasThemeId: DEFAULT_THEME_ID,
        appThemes: [
          { appId: "b", themeId: "red" },
          { appId: "a", themeId: "red" },
        ],
      },
      {
        baseThemeId: "missing",
        canvasThemeId: "missing",
        appThemes: [{ appId: "a", themeId: "missing" }],
      },
    ];
    for (const selection of selections) {
      const shared = painter.paint(selection);
      const alone = paintThemeStyles(sources, selection);
      expect(shared).toEqual(alone);
      expect(Object.keys(shared)).toEqual(Object.keys(alone));
    }
  });
});
