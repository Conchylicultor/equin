import { beforeAll, describe, expect, test } from "bun:test";
import { init as esInit } from "es-module-lexer/minimal";
import { urlAssetRefs } from "./package-assets";
import {
  linkModuleSource,
  linkSpecifier,
  workerFileOf,
  workerTreeOf,
} from "./worker-link";

beforeAll(async () => {
  await esInit();
});

const vendorEntries = {
  zod: "zod.js",
  "drizzle-orm/pglite": "drizzle-orm__pglite.js",
};
const link = (spec: string, dynamic = false, up = "../") =>
  linkSpecifier({
    spec,
    dynamic,
    up,
    vendorEntries,
    importer: "x.server/index.js",
  });

describe("workerFileOf", () => {
  test("a folder barrel is its artifact's index.js, named by plugin id and kind", () => {
    expect(workerFileOf("@plugins/tasks/plugins/task-category/server")).toBe(
      "tasks.task-category.server/index.js",
    );
    expect(workerFileOf("@plugins/database/core")).toBe(
      "database.core/index.js",
    );
  });

  test("a co-built folder is its file inside the host kind's artifact", () => {
    expect(workerFileOf("@plugins/a/plugins/b/exhibits")).toBe(
      "a.b.web/exhibits.js",
    );
  });
});

describe("linkSpecifier", () => {
  test("barrels and vendors become relative URLs into the tree; relative ones stay", () => {
    expect(link("@plugins/database/server")).toBe(
      "../database.server/index.js",
    );
    expect(link("zod", false, "../../")).toBe("../../_vendor/zod.js");
    expect(link("./chunk-a.mjs")).toBe("./chunk-a.mjs");
  });

  test("what a worker never loads throws when loaded; a static leaf import is still linked", () => {
    expect(link("@browser-host/apps/plugins/x")).toStartWith(
      "data:text/javascript,",
    );
    expect(link("@plugins/x/lint", true)).toStartWith("data:text/javascript,");
    expect(link("@plugins/x/lint", false)).toBe("../x.lint/index.js");
  });

  test("an npm specifier the vendor set lacks, or the page's registry, fails the link", () => {
    expect(() => link("left-pad")).toThrow(/vendor set does not carry/);
    expect(() => link("@composition-web-registry")).toThrow(
      /import map serves/,
    );
  });
});

describe("linkModuleSource", () => {
  const rewrite = (spec: string, dynamic: boolean) => link(spec, dynamic);

  test("rewrites static and literal dynamic imports, quotes kept right", () => {
    const src = [
      `import { a } from "@plugins/database/server";`,
      `import "./side.mjs";`,
      `export * from "zod";`,
      `const m = () => import("@plugins/tasks/server");`,
      `const v = import(name);`,
      `const u = import.meta.url;`,
    ].join("\n");
    expect(linkModuleSource(src, "t.js", rewrite)).toBe(
      [
        `import { a } from "../database.server/index.js";`,
        `import "./side.mjs";`,
        `export * from "../_vendor/zod.js";`,
        `const m = () => import("../tasks.server/index.js");`,
        `const v = import(name);`,
        `const u = import.meta.url;`,
      ].join("\n"),
    );
  });

  test("a module with nothing to rewrite is left alone", () => {
    expect(linkModuleSource(`import "./a.mjs";\n`, "t.js", rewrite)).toBeNull();
  });
});

describe("workerTreeOf", () => {
  const linked = [
    { linkName: "a.server", linkedDirName: "a.server.1111.worker" },
    { linkName: "b.core", linkedDirName: "b.core.2222.worker" },
  ];

  test("is named by its links: same links, same tree; one artifact changed, a new tree", () => {
    const one = workerTreeOf({ linked, vendorSetDir: "/v/set.aa" });
    expect(
      workerTreeOf({ linked: [...linked].reverse(), vendorSetDir: "/v/set.aa" })
        .dirName,
    ).toBe(one.dirName);
    const changed = workerTreeOf({
      linked: [
        linked[0]!,
        { linkName: "b.core", linkedDirName: "b.core.3333.worker" },
      ],
      vendorSetDir: "/v/set.aa",
    });
    expect(changed.dirName).not.toBe(one.dirName);
    expect(Object.keys(one.links)).toEqual(["_vendor", "a.server", "b.core"]);
  });

  test("one link name for two artifacts throws", () => {
    expect(() =>
      workerTreeOf({
        linked: [
          ...linked,
          { linkName: "a.server", linkedDirName: "a.server.9999.worker" },
        ],
        vendorSetDir: "/v/set.aa",
      }),
    ).toThrow(/names two artifacts/);
  });
});

describe("urlAssetRefs", () => {
  test("finds the non-code files a module fetches by URL", () => {
    const src = `a=new URL("./pglite.wasm",import.meta.url);b=new URL("pglite.data", import.meta.url);c=new URL("./w.js",import.meta.url);d=new URL(x,import.meta.url);e=new URL("https://x/y.wasm",import.meta.url)`;
    expect(urlAssetRefs(src)).toEqual(["./pglite.wasm", "pglite.data"]);
  });
});
