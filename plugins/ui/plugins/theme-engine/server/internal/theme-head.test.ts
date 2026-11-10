import { describe, it, expect } from "bun:test";

import {
  DEFAULT_THEME_ID,
  defineTheme,
  defineTokenGroup,
  type Theme,
} from "../../core";
import { renderThemeHead } from "./theme-head";

const palette = defineTokenGroup("palette", {
  primary: { default: "blue" },
  background: { default: "white" },
});
const defaultTheme = defineTheme({
  id: DEFAULT_THEME_ID,
  label: "Default",
  fragments: [],
});
const ink = defineTheme({
  id: "ink",
  label: "Ink",
  fragments: [
    palette.fragment({
      light: { primary: "black", background: "ivory" },
      dark: {},
    }),
  ],
});
const sources = {
  groups: [palette],
  themesById: new Map<string, Theme>([defaultTheme, ink].map((t) => [t.id, t])),
  subThemes: [],
  fixedThemes: [],
};
const apps = [
  { id: "home", basePath: "/home", colorMode: "dark" as const },
  { id: "pages", basePath: "/pages", colorMode: "dark" as const },
];

describe("renderThemeHead", () => {
  it("paints the same token blocks on every path, the canvas from the app a path opens", () => {
    const head = renderThemeHead(sources, apps, {
      baseThemeId: DEFAULT_THEME_ID,
      colorMode: "dark",
      scopes: [
        { scopeId: "app:pages", themeId: "ink" },
        { scopeId: "app:gone", themeId: "ink" },
      ],
    });
    // An app this composition does not bundle paints nowhere; an app without
    // a document of its own is the "" entry.
    expect(Object.keys(head).sort()).toEqual(["", "/pages"]);

    // :root is the desktop's theme everywhere — never re-rooted on the app…
    for (const entry of [head[""], head["/pages"]]) {
      expect(entry).toContain(
        '<style id="theme-engine-palette">:root {\n  --primary: blue;',
      );
      // …and the app's own theme is on its scope, on every path.
      expect(entry).toContain(
        '<style id="theme-scope-app:pages-palette">[data-theme-scope="app:pages"] {\n  --primary: black;',
      );
    }
    // Only the canvas follows the app the path opens.
    expect(head["/pages"]).toContain(
      '<style id="theme-engine-canvas">body {\n  background-color: ivory;',
    );
    expect(head[""]).toContain(
      '<style id="theme-engine-canvas">body {\n  background-color: white;',
    );
  });

  it("paints a surface-mode app's scope but gives it no entry", () => {
    const head = renderThemeHead(
      sources,
      [...apps, { id: "desktop", colorMode: "light" }],
      {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode: "dark",
        scopes: [{ scopeId: "app:desktop", themeId: "ink" }],
      },
    );
    expect(Object.keys(head)).toEqual([""]);
    expect(head[""]).toContain('<style id="theme-scope-app:desktop-palette">');
  });

  it("ends every entry with the configured .dark class, resolving system in the page", () => {
    const render = (colorMode: "light" | "dark" | "system") =>
      renderThemeHead(sources, apps, {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode,
        scopes: [],
      })[""];
    expect(render("dark")).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",true)</script>',
    );
    expect(render("light")).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",false)</script>',
    );
    expect(render("system")).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches)</script>',
    );
  });

  it("roots an app whose scheme differs from the global one at its base path, in its scheme", () => {
    const head = renderThemeHead(
      sources,
      [...apps, { id: "panel", basePath: "/home/panel", colorMode: "system" }],
      {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode: "dark",
        scopes: [{ scopeId: "app:pages", themeId: "ink" }],
      },
    );
    expect(Object.keys(head).sort()).toEqual(["", "/home/panel", "/pages"]);
    // No theme document of its own: the desktop's theme at :root and canvas…
    expect(head["/home/panel"]).toContain(
      '<style id="theme-engine-palette">:root {\n  --primary: blue;',
    );
    expect(head["/home/panel"]).toContain(
      '<style id="theme-scope-app:pages-palette">',
    );
    // …in its own scheme, while every other entry keeps the global one.
    expect(head["/home/panel"]).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",matchMedia("(prefers-color-scheme: dark)").matches)</script>',
    );
    expect(head["/pages"]).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",true)</script>',
    );
  });

  it("paints a themed app in its own scheme", () => {
    const head = renderThemeHead(
      sources,
      [{ id: "pages", basePath: "/pages", colorMode: "light" }],
      {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode: "dark",
        scopes: [{ scopeId: "app:pages", themeId: "ink" }],
      },
    );
    expect(head["/pages"]).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",false)</script>',
    );
    expect(head[""]).toEndWith(
      '<script>document.documentElement.classList.toggle("dark",true)</script>',
    );
  });

  it("never lets a stored value close its <style> element", () => {
    const hostile: Theme = {
      id: "custom:x",
      label: "x",
      source: "custom",
      fragments: [
        palette.fragment({
          light: { primary: "red</style><script>alert(1)</script>" },
          dark: {},
        }),
      ],
    };
    const head = renderThemeHead(
      {
        ...sources,
        themesById: new Map([...sources.themesById, [hostile.id, hostile]]),
      },
      apps,
      { baseThemeId: hostile.id, colorMode: "light", scopes: [] },
    );
    expect(head[""]).not.toContain("</style><script>alert");
    expect(head[""]).toContain("red\\3c /style>\\3c script>");
  });
});
