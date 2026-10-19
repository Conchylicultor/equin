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
});
const defaultTheme = defineTheme({
  id: DEFAULT_THEME_ID,
  label: "Default",
  fragments: [],
});
const ink = defineTheme({
  id: "ink",
  label: "Ink",
  fragments: [palette.fragment({ light: { primary: "black" }, dark: {} })],
});
const sources = {
  groups: [palette],
  themesById: new Map<string, Theme>([defaultTheme, ink].map((t) => [t.id, t])),
  subThemes: [],
  fixedThemes: [],
};
const apps = [
  { id: "home", basePath: "/home" },
  { id: "pages", basePath: "/pages" },
];

describe("renderThemeHead", () => {
  it("roots each app with its own theme at its base path, the desktop's everywhere else", () => {
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

    expect(head["/pages"]).toContain(
      '<style id="theme-engine-palette">:root {\n  --primary: black;',
    );
    // Its own scope block is not painted where it owns :root…
    expect(head["/pages"]).not.toContain("theme-scope-app:pages");
    // …but is everywhere else.
    expect(head[""]).toContain(
      '<style id="theme-engine-palette">:root {\n  --primary: blue;',
    );
    expect(head[""]).toContain('<style id="theme-scope-app:pages-palette">');
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
