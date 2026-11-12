import { describe, expect, test } from "bun:test";
import boundaryConfig from "./boundary-config";
import { zone } from "./config";
import { checkRuntime } from "./evaluate";
import type { PluginFolder } from "@plugins/framework/plugins/plugin-id/core";
import { buildZoneMap, type PluginDirs, type Resolved } from "./resolve";

// A two-level tree: `alpha`, and `alpha`'s child `beta`. Only `id` and `path`
// are read, so that is all the fake nodes carry.
const tree: PluginDirs = {
  byDir: new Map([
    ["/repo/plugins/alpha", { id: "alpha", path: "alpha" }],
    [
      "/repo/plugins/alpha/plugins/beta",
      { id: "alpha.beta", path: "alpha/plugins/beta" },
    ],
  ]),
};

const zoneMap = buildZoneMap(
  [zone("plugin", { match: "plugins", discover: "plugin-tree" })],
  tree,
);

// Built from a prefix rather than written whole: `alpha` is not a real plugin,
// and `plugin-refs-resolve` rejects a `"plugins/…"` literal that names none.
const PLUGINS = "plugins";
const ALPHA_CORE = `${PLUGINS}/alpha/core/internal/thing.ts`;
const BETA_WEB = `${PLUGINS}/alpha/plugins/beta/web/components/view.tsx`;

const folder = (zone: string, f: PluginFolder, test = false): Resolved => ({
  kind: "folder",
  zone,
  folder: f,
  test,
});

describe("resolveImport — relative specifiers", () => {
  test("into the plugin's own folders", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "../../server/x")).toEqual(
      folder("plugin.alpha", "server"),
    );
    expect(zoneMap.resolveImport(ALPHA_CORE, "../../shared/y")).toEqual(
      folder("plugin.alpha", "shared"),
    );
    expect(zoneMap.resolveImport(ALPHA_CORE, "../../data-dirs/z")).toEqual(
      folder("plugin.alpha", "data-dirs"),
    );
  });

  test("a deep file keeps the folder it sits in", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "./other/deep/file")).toEqual(
      folder("plugin.alpha", "core"),
    );
  });

  test("a child plugin climbing into its parent lands in the parent's zone", () => {
    expect(zoneMap.resolveImport(BETA_WEB, "../../../../web/x")).toEqual(
      folder("plugin.alpha", "web"),
    );
  });

  test("a loose file at the plugin root has no folder", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "../../config")).toEqual({
      kind: "unfoldered",
      zone: "plugin.alpha",
      why: "loose-file",
      name: "config",
    });
  });

  test("a path leaving plugins/ is outside", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "../../../../web/main")).toEqual({
      kind: "outside",
    });
    expect(
      zoneMap.resolveImport(ALPHA_CORE, "../../../../../../outside"),
    ).toEqual({ kind: "outside" });
  });
});

describe("resolveImport — alias specifiers", () => {
  test("the plugin's own alias resolves like any other plugin's", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "@plugins/alpha/web")).toEqual(
      folder("plugin.alpha", "web"),
    );
  });

  test("the longest plugin prefix wins", () => {
    expect(
      zoneMap.resolveImport(ALPHA_CORE, "@plugins/alpha/plugins/beta/core"),
    ).toEqual(folder("plugin.alpha.beta", "core"));
  });

  test("a bare plugin alias names no folder", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "@plugins/alpha")).toMatchObject({
      kind: "unfoldered",
      zone: "plugin.alpha",
    });
  });

  test("a bare npm package is outside", () => {
    expect(zoneMap.resolveImport(ALPHA_CORE, "react")).toEqual({
      kind: "outside",
    });
  });
});

describe("resolveFile — every file in a plugin has a folder or is reported", () => {
  test("a leaf folder is a folder", () => {
    expect(zoneMap.resolveFile(`${PLUGINS}/alpha/check/index.ts`)).toEqual(
      folder("plugin.alpha", "check"),
    );
  });

  test("a loose root file", () => {
    expect(zoneMap.resolveFile(`${PLUGINS}/alpha/foo.ts`)).toEqual({
      kind: "unfoldered",
      zone: "plugin.alpha",
      why: "loose-file",
      name: "foo.ts",
    });
  });

  test("an unknown folder", () => {
    expect(zoneMap.resolveFile(`${PLUGINS}/alpha/misc/a.ts`)).toEqual({
      kind: "unfoldered",
      zone: "plugin.alpha",
      why: "unknown-folder",
      name: "misc",
    });
  });

  test("a file under plugins/ outside any child plugin", () => {
    expect(zoneMap.resolveFile(`${PLUGINS}/alpha/plugins/stray.ts`)).toEqual({
      kind: "unfoldered",
      zone: "plugin.alpha",
      why: "not-in-child-plugin",
      name: "plugins",
    });
    expect(
      zoneMap.resolveFile(`${PLUGINS}/alpha/plugins/gamma/web/x.ts`),
    ).toMatchObject({ kind: "unfoldered", why: "not-in-child-plugin" });
  });

  test("a file outside plugins/ is outside", () => {
    expect(zoneMap.resolveFile("eslint.config.ts")).toEqual({
      kind: "outside",
    });
  });
});

describe("test code", () => {
  test("a test file, a __tests__ file and a testing/ file are test code", () => {
    expect(zoneMap.resolveFile(`${PLUGINS}/alpha/core/a.test.ts`)).toEqual(
      folder("plugin.alpha", "core", true),
    );
    expect(
      zoneMap.resolveFile(`${PLUGINS}/alpha/web/__tests__/fixture.tsx`),
    ).toEqual(folder("plugin.alpha", "web", true));
    expect(
      zoneMap.resolveFile(`${PLUGINS}/alpha/server/testing/index.ts`),
    ).toEqual(folder("plugin.alpha", "server", true));
  });

  test("an ordinary file is not", () => {
    expect(zoneMap.resolveFile(ALPHA_CORE)).toEqual(
      folder("plugin.alpha", "core"),
    );
  });

  test("a testing barrel resolves as test code, by alias or relatively", () => {
    expect(
      zoneMap.resolveImport(
        ALPHA_CORE,
        "@plugins/alpha/plugins/beta/core/testing",
      ),
    ).toEqual(folder("plugin.alpha.beta", "core", true));
    expect(zoneMap.resolveImport(ALPHA_CORE, "../testing")).toEqual(
      folder("plugin.alpha", "core", true),
    );
    expect(zoneMap.resolveImport(ALPHA_CORE, "./x.test")).toEqual(
      folder("plugin.alpha", "core", true),
    );
  });

  test("testing/ anywhere but directly under a runtime folder is reported", () => {
    expect(
      zoneMap.resolveFile(`${PLUGINS}/alpha/core/internal/testing/x.ts`),
    ).toEqual({
      kind: "unfoldered",
      zone: "plugin.alpha",
      why: "misplaced-testing",
      name: "core/internal/testing",
    });
    expect(
      zoneMap.resolveFile(`${PLUGINS}/alpha/e2e/testing/x.ts`),
    ).toMatchObject({ kind: "unfoldered", why: "misplaced-testing" });
    expect(
      zoneMap.resolveFile(`${PLUGINS}/alpha/check/testing/x.ts`),
    ).toMatchObject({ kind: "unfoldered", why: "misplaced-testing" });
  });
});

describe("the folder table", () => {
  test("a leaf folder may import its row", () => {
    expect(checkRuntime(boundaryConfig.folders, "check", "server")).toBe(true);
    expect(checkRuntime(boundaryConfig.folders, "exhibits", "web")).toBe(true);
  });

  test("a leaf folder is denied what its row omits", () => {
    expect(checkRuntime(boundaryConfig.folders, "check", "web")).toBe(false);
    expect(checkRuntime(boundaryConfig.folders, "exhibits", "server")).toBe(
      false,
    );
  });

  test("nothing may import a leaf folder", () => {
    expect(checkRuntime(boundaryConfig.folders, "server", "check")).toBe(false);
    expect(checkRuntime(boundaryConfig.folders, "bin", "lint")).toBe(false);
  });
});
