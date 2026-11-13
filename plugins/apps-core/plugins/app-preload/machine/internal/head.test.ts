import { describe, expect, test } from "bun:test";
import { renderAppPreloadHead } from "./head";

const apps = [
  { plugin: "apps.website.shell", basePath: "/about", launch: "tab" as const },
  { plugin: "apps.home.shell", basePath: "/home", launch: "tab" as const },
  { plugin: "menu-bar", basePath: "/home/menu-bar", launch: "tab" as const },
  {
    plugin: "apps.desktop.shell",
    basePath: "/desktop",
    launch: "surface" as const,
  },
];
const preloads = {
  v: 1 as const,
  apps: {
    "apps/plugins/website/": ["/artifacts/a.js", "/artifacts/b.js"],
    "apps/plugins/home/": ["/artifacts/h.js"],
  },
};

describe("renderAppPreloadHead", () => {
  const head = renderAppPreloadHead(apps, preloads);

  test("each app's base path preloads its own root's modules, in order", () => {
    expect(head["/about"]).toBe(
      '<link rel="modulepreload" href="/artifacts/a.js">' +
        '<link rel="modulepreload" href="/artifacts/b.js">',
    );
    expect(head["/home"]).toBe(
      '<link rel="modulepreload" href="/artifacts/h.js">',
    );
  });

  test("a nested app outside every app root gets its own empty key, never its parent's list", () => {
    expect(head["/home/menu-bar"]).toBe("");
  });

  test("an app with no deferred modules gets an empty key", () => {
    expect(head["/desktop"]).toBe("");
  });

  test("each tab app is keyed under a surface-mode app's base path too", () => {
    expect(head["/desktop/about"]).toBe(head["/about"]);
    expect(head["/desktop/home"]).toBe(head["/home"]);
    expect(head["/desktop/desktop"]).toBeUndefined();
  });

  test("no catch-all entry: a page outside every app preloads nothing", () => {
    expect(head[""]).toBeUndefined();
  });
});
