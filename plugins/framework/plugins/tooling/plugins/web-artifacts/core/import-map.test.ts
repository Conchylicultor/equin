import { describe, expect, test } from "bun:test";
import { barrelKindOf, isBrowserUnreachableDynamic } from "./constants";
import {
  buildImportMap,
  diffImportMaps,
  findUnmappedDynamicWarnings,
  findUnmappedSpecifiers,
} from "./import-map";

describe("buildImportMap", () => {
  test("sorts entries deterministically", () => {
    const map = buildImportMap([
      { specifier: "react", url: "/artifacts/v/react.js" },
      { specifier: "@plugins/tasks/web", url: "/artifacts/tasks.web.abc/index.js" },
    ]);
    expect(Object.keys(map.imports)).toEqual(["@plugins/tasks/web", "react"]);
    expect(map.imports["react"]).toBe("/artifacts/v/react.js");
  });

  test("duplicate specifier with conflicting URL throws", () => {
    expect(() =>
      buildImportMap([
        { specifier: "react", url: "/a.js" },
        { specifier: "react", url: "/b.js" },
      ]),
    ).toThrow(/duplicate specifier "react"/);
  });

  test("duplicate specifier with identical URL is tolerated", () => {
    const map = buildImportMap([
      { specifier: "react", url: "/a.js" },
      { specifier: "react", url: "/a.js" },
    ]);
    expect(map.imports["react"]).toBe("/a.js");
  });
});

describe("findUnmappedSpecifiers", () => {
  const map = buildImportMap([
    { specifier: "@plugins/shell/web", url: "/artifacts/shell.web.x/index.js" },
    { specifier: "react", url: "/artifacts/v/react.js" },
  ]);

  test("fully mapped emit set → empty", () => {
    const missing = findUnmappedSpecifiers(
      [{ importer: "tasks.web", specifiers: ["@plugins/shell/web", "react"] }],
      map,
    );
    expect(missing).toEqual([]);
  });

  test("unmapped specifier is reported with its importer", () => {
    const missing = findUnmappedSpecifiers(
      [{ importer: "tasks.web", specifiers: ["@plugins/gone/web", "react"] }],
      map,
    );
    expect(missing).toEqual([{ specifier: "@plugins/gone/web", importer: "tasks.web" }]);
  });

  test("relative specifiers are exempt (resolved against the artifact URL)", () => {
    const missing = findUnmappedSpecifiers(
      [{ importer: "vendors", specifiers: ["./chunks/chunk-abc.js"] }],
      map,
    );
    expect(missing).toEqual([]);
  });
});

describe("findUnmappedDynamicWarnings (compose-warning exemption)", () => {
  const map = buildImportMap([
    { specifier: "@plugins/shell/web", url: "/artifacts/shell.web.x/index.js" },
  ]);

  test("browser-unreachable kinds (prewarm) are exempt — silent", () => {
    const warned = findUnmappedDynamicWarnings(
      [
        {
          importer: "infra.asset-mirror.core",
          specifiers: [
            "@plugins/apps/plugins/sonata/plugins/audio/plugins/piano/prewarm",
            "@plugins/apps/plugins/sonata/plugins/audio/plugins/soundfont/prewarm",
          ],
        },
      ],
      map,
    );
    expect(warned).toEqual([]);
  });

  test("a NEW unmapped dynamic import of a non-exempt kind still warns", () => {
    const warned = findUnmappedDynamicWarnings(
      [
        {
          importer: "some.plugin.web",
          specifiers: [
            "@plugins/some/plugins/new-thing/core", // non-exempt → must warn
            "@plugins/other/prewarm", // exempt kind → silent
          ],
        },
      ],
      map,
    );
    expect(warned).toEqual([
      { specifier: "@plugins/some/plugins/new-thing/core", importer: "some.plugin.web" },
    ]);
  });

  test("mapped specifiers never warn, exempt or not", () => {
    const warned = findUnmappedDynamicWarnings(
      [{ importer: "a.web", specifiers: ["@plugins/shell/web"] }],
      map,
    );
    expect(warned).toEqual([]);
  });
});

describe("exemption predicate helpers", () => {
  test("barrelKindOf extracts the last segment of @plugins specifiers only", () => {
    expect(barrelKindOf("@plugins/a/plugins/b/prewarm")).toBe("prewarm");
    expect(barrelKindOf("@plugins/a/core")).toBe("core");
    expect(barrelKindOf("react-dom/client")).toBeNull();
    expect(barrelKindOf("@plugins/solo")).toBeNull();
  });

  test("isBrowserUnreachableDynamic matches declared kinds, not substrings", () => {
    expect(isBrowserUnreachableDynamic("@plugins/x/prewarm")).toBe(true);
    expect(isBrowserUnreachableDynamic("@plugins/x/lint")).toBe(true);
    expect(isBrowserUnreachableDynamic("@plugins/x/facet")).toBe(true);
    // A co-built leaf IS a browser load (served from its host artifact).
    expect(isBrowserUnreachableDynamic("@plugins/x/exhibits")).toBe(false);
    expect(isBrowserUnreachableDynamic("@plugins/x/core")).toBe(false);
    expect(isBrowserUnreachableDynamic("@plugins/prewarm/web")).toBe(false);
    expect(isBrowserUnreachableDynamic("prewarm")).toBe(false);
  });
});

describe("diffImportMaps", () => {
  test("identical maps → empty diff", () => {
    const m = { react: "/a.js", "@plugins/tasks/web": "/b.js" };
    expect(diffImportMaps(m, { ...m })).toEqual({ missing: [], extra: [], changed: [] });
  });

  test("stale URL is reported as changed", () => {
    const diff = diffImportMaps(
      { "@plugins/tasks/web": "/artifacts/tasks.web.old/index.js" },
      { "@plugins/tasks/web": "/artifacts/tasks.web.new/index.js" },
    );
    expect(diff.changed).toEqual([
      {
        specifier: "@plugins/tasks/web",
        deployed: "/artifacts/tasks.web.old/index.js",
        expected: "/artifacts/tasks.web.new/index.js",
      },
    ]);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
  });

  test("missing and extra specifiers are reported sorted", () => {
    const diff = diffImportMaps(
      { gone: "/g.js", react: "/a.js" },
      { added: "/n.js", react: "/a.js" },
    );
    expect(diff.missing).toEqual(["added"]);
    expect(diff.extra).toEqual(["gone"]);
    expect(diff.changed).toEqual([]);
  });
});
