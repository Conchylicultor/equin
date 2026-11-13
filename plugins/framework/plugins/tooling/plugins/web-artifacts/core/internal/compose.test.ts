import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  joinAppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import {
  composeDist,
  computeGraphHash,
  computePreloadClosure,
  pagePins,
} from "./compose";
import { CENTRAL_BUILD_GLOBAL } from "./vite-builder";

const graph = {
  htmlSrc: "<!doctype html><head><script>var a = 1;</script></head>",
  importMap: {
    imports: {
      "@plugins/a/web": "/artifacts/a.web.1111111111111111/index.js",
      "@plugins/b/web": "/artifacts/b.web.2222222222222222/index.js",
    },
  },
  preloads: ["/artifacts/entry.3333333333333333/index.js"],
  entryUrl: "/artifacts/entry.3333333333333333/index.js",
  cssHref: "/global.4444444444444444.css",
  pins: pagePins({ buildCommit: "commit-1", centralBuild: "central-1" }),
};

describe("computePreloadClosure", () => {
  test("lists every module after the modules it imports, seeds in turn", () => {
    const imports: Record<string, string[]> = {
      "/a/entry.js": ["@p/app", "./util.js"],
      "/a/util.js": ["zod"],
      "/p/app.js": ["zod", "react"],
      "/p/eager.js": ["react", "@p/app"],
    };
    const map = {
      "@p/app": "/p/app.js",
      zod: "/v/zod.js",
      react: "/v/react.js",
    };
    expect(
      computePreloadClosure({
        seeds: ["/a/entry.js", "/p/eager.js"],
        imports,
        map,
      }),
    ).toEqual([
      "/v/zod.js",
      "/v/react.js",
      "/p/app.js",
      "/a/util.js",
      "/a/entry.js",
      "/p/eager.js",
    ]);
  });

  test("terminates on an import cycle and drops unmapped specifiers", () => {
    expect(
      computePreloadClosure({
        seeds: ["/a.js"],
        imports: { "/a.js": ["./b.js", "missing"], "/b.js": ["./a.js"] },
        map: {},
      }),
    ).toEqual(["/b.js", "/a.js"]);
  });
});

describe("computeGraphHash", () => {
  test("is stable across two composes of the same graph", () => {
    expect(computeGraphHash(graph)).toBe(
      computeGraphHash(structuredClone(graph)),
    );
  });

  test("does not depend on import-map key order", () => {
    const reordered = {
      ...graph,
      importMap: {
        imports: {
          "@plugins/b/web": graph.importMap.imports["@plugins/b/web"]!,
          "@plugins/a/web": graph.importMap.imports["@plugins/a/web"]!,
        },
      },
    };
    expect(computeGraphHash(reordered)).toBe(computeGraphHash(graph));
  });

  // Each input decides which bytes the browser runs, so each must move the hash
  // — otherwise a tab could hold a genuinely different bundle and read as fresh.
  test("changes when any part of the graph changes", () => {
    const base = computeGraphHash(graph);
    // The shell's inline scripts belong to no URL: nothing else in the digest
    // moves when one of them is edited, so this line is the only thing standing
    // between a changed theme-replay script and a tab that reads as fresh.
    expect(
      computeGraphHash({
        ...graph,
        htmlSrc: "<!doctype html><head><script>var a = 2;</script></head>",
      }),
    ).not.toBe(base);
    expect(
      computeGraphHash({
        ...graph,
        importMap: {
          imports: {
            ...graph.importMap.imports,
            "@plugins/a/web": "/artifacts/a.web.9999999999999999/index.js",
          },
        },
      }),
    ).not.toBe(base);
    expect(
      computeGraphHash({
        ...graph,
        preloads: [...graph.preloads, "/artifacts/c/index.js"],
      }),
    ).not.toBe(base);
    expect(
      computeGraphHash({ ...graph, entryUrl: "/artifacts/other/index.js" }),
    ).not.toBe(base);
    expect(
      computeGraphHash({ ...graph, cssHref: "/global.5555555555555555.css" }),
    ).not.toBe(base);
  });

  // A reload brings the tab the central build its page bakes, so a redeploy
  // that changes only central code is a new page — its tabs are stale — while
  // the commit, which moves with the tree even when the bytes do not, is not.
  test("covers the central build the page bakes, not the commit", () => {
    const base = computeGraphHash(graph);
    expect(
      computeGraphHash({
        ...graph,
        pins: pagePins({ buildCommit: "commit-1", centralBuild: "central-2" }),
      }),
    ).not.toBe(base);
    expect(
      computeGraphHash({
        ...graph,
        pins: pagePins({ buildCommit: "commit-1", centralBuild: null }),
      }),
    ).not.toBe(base);
    expect(
      computeGraphHash({
        ...graph,
        pins: pagePins({ buildCommit: "commit-2", centralBuild: "central-1" }),
      }),
    ).toBe(base);
  });

  test("is a 16-char hex digest", () => {
    expect(computeGraphHash(graph)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("composeDist with an address dir", () => {
  function fixture() {
    const base = asAppPath(mkdtempSync(join(tmpdir(), "compose-addresses-")));
    const webSrcDir = joinAppPath(base, "web-src");
    mkdirSync(webSrcDir);
    writeFileSync(
      joinAppPath(webSrcDir, "index.html"),
      '<html><head></head><body><script type="module" src="/main.tsx"></script></body></html>',
    );
    const store = joinAppPath(base, "store");
    const entry = (name: string) => {
      const p = joinAppPath(store, name);
      mkdirSync(p, { recursive: true });
      writeFileSync(joinAppPath(p, "index.js"), "export {};");
      return p;
    };
    const compose = (
      staging: string,
      links: Array<{ linkName: string; storePath: ReturnType<typeof entry> }>,
      centralBuild: string | null = null,
    ) =>
      composeDist({
        stagingDir: joinAppPath(base, staging),
        webSrcDir,
        buildId: "b",
        buildCommit: null,
        centralBuild,
        minify: true,
        cssHref: `/artifacts/${links[0]!.linkName}/index.js`,
        links,
        addressDir: joinAppPath(base, "web-addresses"),
        mapEntries: [],
        staticImportsByUrl: {},
        emitted: [],
        entryUrl: `/artifacts/${links[0]!.linkName}/index.js`,
        preloadSeeds: [],
        appPreloadSeeds: {},
        edges: {},
      });
    return { base, entry, compose };
  }

  test("links only new names, and every release sees every name", () => {
    const f = fixture();
    const a = f.entry("a.web.1");
    const b = f.entry("b.web.2");
    f.compose("web.staging.1", [{ linkName: "a.web.1", storePath: a }]);
    f.compose("web.staging.2", [
      { linkName: "a.web.1", storePath: a },
      { linkName: "b.web.2", storePath: b },
    ]);
    const addresses = joinAppPath(f.base, "web-addresses");
    expect(
      readlinkSync(joinAppPath(f.base, "web.staging.2", "artifacts")),
    ).toBe(addresses);
    // The first release serves the second's new name too: one dir.
    expect(
      lstatSync(
        joinAppPath(f.base, "web.staging.1", "artifacts", "b.web.2"),
      ).isSymbolicLink(),
    ).toBe(true);
  });

  test("the page names central's code build beside its graph — unknown as empty", () => {
    const f = fixture();
    const a = f.entry("a.web.1");
    const links = [{ linkName: "a.web.1", storePath: a }];
    f.compose("web.staging.1", links, "central-digest-1");
    f.compose("web.staging.2", links);
    const html = (staging: string) =>
      readFileSync(joinAppPath(f.base, staging, "index.html"), "utf8");
    expect(html("web.staging.1")).toContain(
      `var ${CENTRAL_BUILD_GLOBAL} = "central-digest-1";`,
    );
    expect(html("web.staging.2")).toContain(
      `var ${CENTRAL_BUILD_GLOBAL} = "";`,
    );
    // The served dist names it beside the page (what the backend tells its
    // tabs a reload brings), and names none when the page bakes none.
    expect(
      readFileSync(
        joinAppPath(f.base, "web.staging.1", ".central-build"),
        "utf8",
      ),
    ).toBe("central-digest-1\n");
    expect(
      existsSync(joinAppPath(f.base, "web.staging.2", ".central-build")),
    ).toBe(false);
  });

  test("an existing name linking another store path throws", () => {
    const f = fixture();
    const a = f.entry("a.web.1");
    const other = f.entry("elsewhere");
    mkdirSync(joinAppPath(f.base, "web-addresses"));
    symlinkSync(other, joinAppPath(f.base, "web-addresses", "a.web.1"));
    expect(() =>
      f.compose("web.staging.1", [{ linkName: "a.web.1", storePath: a }]),
    ).toThrow(/write-once/);
  });
});
