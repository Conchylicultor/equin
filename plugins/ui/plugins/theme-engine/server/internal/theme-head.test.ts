import { describe, it, expect } from "bun:test";

import {
  DEFAULT_THEME_ID,
  defineTheme,
  defineTokenGroup,
  type Theme,
} from "../../core";
import { renderThemeHead } from "./theme-head";
import { ROOT_SCHEME_SELECTORS } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";

const script = (scheme: string) =>
  `<script>document.documentElement.setAttribute("data-color-scheme",${scheme})</script>`;
const DARK_SCRIPT = script('"dark"');
const LIGHT_SCRIPT = script('"light"');
const SYSTEM_SCRIPT = script(
  'matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"',
);

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
      dark: { background: "charcoal" },
    }),
  ],
});
const sources = {
  groups: [palette],
  themesById: new Map<string, Theme>([defaultTheme, ink].map((t) => [t.id, t])),
};
const apps = [
  { id: "home", basePath: "/home", colorMode: "dark" as const },
  { id: "pages", basePath: "/pages", colorMode: "dark" as const },
];

describe("renderThemeHead", () => {
  it("paints :root on every path, and an app's scope and canvas only on the path that opens it", () => {
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
        `<style id="theme-engine-palette">${ROOT_SCHEME_SELECTORS.light} {\n  --primary: blue;`,
      );
    }
    // …and the app's own theme is on its scope, only where a page opens it:
    // everywhere else the browser paints it in its first commit.
    expect(head["/pages"]).toContain(
      '<style id="theme-scope-app:pages-palette">[data-theme-scope="app:pages"] {\n  --primary: black;',
    );
    expect(head[""]).not.toContain("theme-scope-app:pages");
    // Only the canvas follows the app the path opens, in its (dark) scheme.
    expect(head["/pages"]).toContain(
      '<style id="theme-engine-canvas">body {\n  background-color: charcoal;',
    );
    expect(head[""]).toContain(
      '<style id="theme-engine-canvas">body {\n  background-color: white;',
    );
  });

  it('paints a surface-mode app\'s scope on the "" entry only, giving it no entry of its own', () => {
    const head = renderThemeHead(
      sources,
      [...apps, { id: "desktop", colorMode: "light" }],
      {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode: "dark",
        scopes: [
          { scopeId: "app:desktop", themeId: "ink" },
          { scopeId: "app:pages", themeId: "ink" },
        ],
      },
    );
    expect(Object.keys(head).sort()).toEqual(["", "/pages"]);
    expect(head[""]).toContain('<style id="theme-scope-app:desktop-palette">');
    // A tab app's page carries its own scope, not the desktop's.
    expect(head["/pages"]).not.toContain("theme-scope-app:desktop");
    expect(head["/pages"]).toContain(
      '<style id="theme-scope-app:pages-palette">',
    );
  });

  it("ends every entry with the desktop's scheme on <html>, resolving system in the page", () => {
    const render = (colorMode: "light" | "dark" | "system") =>
      renderThemeHead(sources, apps, {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode,
        scopes: [],
      })[""];
    expect(render("dark")).toEndWith(DARK_SCRIPT);
    expect(render("light")).toEndWith(LIGHT_SCRIPT);
    expect(render("system")).toEndWith(SYSTEM_SCRIPT);
  });

  it("paints the canvas of an app whose scheme differs from the global one in its scheme, <html> keeping the desktop's", () => {
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
      `<style id="theme-engine-palette">${ROOT_SCHEME_SELECTORS.light} {\n  --primary: blue;`,
    );
    expect(head["/home/panel"]).not.toContain("theme-scope-");
    // …its canvas in its own scheme; <html> keeps the desktop's on every path.
    expect(head["/home/panel"]).toContain(
      "@media (prefers-color-scheme: dark)",
    );
    expect(head["/home/panel"]).toEndWith(DARK_SCRIPT);
    expect(head["/pages"]).toEndWith(DARK_SCRIPT);
  });

  it("paints a themed app's canvas in its own scheme", () => {
    const head = renderThemeHead(
      sources,
      [{ id: "pages", basePath: "/pages", colorMode: "light" }],
      {
        baseThemeId: DEFAULT_THEME_ID,
        colorMode: "dark",
        scopes: [{ scopeId: "app:pages", themeId: "ink" }],
      },
    );
    expect(head["/pages"]).not.toContain("@media (prefers-color-scheme");
    expect(head["/pages"]).toEndWith(DARK_SCRIPT);
    expect(head[""]).toEndWith(DARK_SCRIPT);
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
