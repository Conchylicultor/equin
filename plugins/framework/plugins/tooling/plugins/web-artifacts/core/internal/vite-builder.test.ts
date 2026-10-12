import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertCoEntriesOffHostPath,
  assertWorkersSelfContained,
  chunkCssPlugin,
  ownFolderBarrelPlugin,
  parseEmittedImports,
} from "./vite-builder";

// Regression: an artifact with internal dynamic imports code-splits into `.mjs`
// chunks; their imports were once invisible (only `index.js` was scanned), so
// specifiers imported only by a lazy chunk got no vendor/map entry and failed
// at runtime ("Failed to resolve module specifier").
describe("parseEmittedImports", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("scans .mjs chunks, records statics per file and dynamics as a union", async () => {
    dir = mkdtempSync(join(tmpdir(), "web-artifacts-test-"));
    writeFileSync(
      join(dir, "index.js"),
      `import { a } from "./chunk-abc.mjs";\nexport { a };\n`,
    );
    writeFileSync(
      join(dir, "chunk-abc.mjs"),
      `import { x } from "@plugins/some/core";\n` +
        `const lazy = () => import("./impl-def.mjs");\nexport const a = [x, lazy];\n`,
    );
    writeFileSync(
      join(dir, "impl-def.mjs"),
      `import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";\n` +
        `export const b = PlainTextPlugin;\n`,
    );
    writeFileSync(join(dir, "index.js.map"), "{}"); // sourcemaps are not modules

    const { staticImportsByFile, dynamicImports } =
      await parseEmittedImports(dir);
    expect(staticImportsByFile).toEqual({
      "index.js": ["./chunk-abc.mjs"],
      "chunk-abc.mjs": ["@plugins/some/core"],
      "impl-def.mjs": ["@lexical/react/LexicalPlainTextPlugin"],
    });
    expect(dynamicImports).toEqual(["./impl-def.mjs"]);
  });
});

// A deep import into an own non-inlined folder used to be rewritten to that
// folder's barrel, so a symbol the barrel did not export type-checked green and
// failed only at compose. Only the barrel spelling is routed now.
describe("ownFolderBarrelPlugin", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(): {
    resolveId: (id: string, importer: string) => unknown;
    pluginDir: string;
  } {
    dir = mkdtempSync(join(tmpdir(), "web-artifacts-own-folder-"));
    const pluginDir = join(dir, "plugins", "demo");
    mkdirSync(join(pluginDir, "core"), { recursive: true });
    writeFileSync(join(pluginDir, "core", "index.ts"), "export {};\n");
    const plugin = ownFolderBarrelPlugin("demo", pluginDir, "web");
    const hook = plugin.resolveId as (id: string, importer: string) => unknown;
    return {
      resolveId: (id, importer) => hook.call({}, id, importer),
      pluginDir,
    };
  }

  test("routes the barrel spelling to the external barrel", () => {
    const { resolveId, pluginDir } = setup();
    const importer = join(pluginDir, "web", "components", "a.tsx");
    const external = { id: "@plugins/demo/core", external: true };
    expect(resolveId("../../core", importer)).toEqual(external);
    expect(resolveId("../../core/index.ts", importer)).toEqual(external);
    expect(resolveId(join(pluginDir, "core"), importer)).toEqual(external);
  });

  test("refuses a deep path, naming the importer and the fix", () => {
    const { resolveId, pluginDir } = setup();
    const importer = join(pluginDir, "web", "components", "a.tsx");
    expect(() => resolveId("../../core/merge-group-values", importer)).toThrow(
      /a\.tsx imports "\.\.\/\.\.\/core\/merge-group-values".*no-deep-own-folder-import/s,
    );
  });

  test("leaves the artifact's own and shared folders to be inlined", () => {
    const { resolveId, pluginDir } = setup();
    const importer = join(pluginDir, "web", "components", "a.tsx");
    expect(resolveId("../internal/x", importer)).toBeNull();
    expect(resolveId("../../shared/x", importer)).toBeNull();
  });
});

describe("assertCoEntriesOffHostPath (exhibits.js never on the boot path)", () => {
  const coEntries = [
    {
      folder: "exhibits",
      entryFile: "/p/exhibits/index.ts",
      specifier: "@plugins/p/exhibits",
    },
  ];

  test("shared chunks are fine — the host only reaches common code", () => {
    expect(() =>
      assertCoEntriesOffHostPath({
        dirName: "p.web.1",
        coEntries,
        staticImportsByFile: {
          "index.js": ["./shared-abc.mjs", "@plugins/other/web"],
          "exhibits.js": ["./shared-abc.mjs", "./index.js"],
          "shared-abc.mjs": ["react"],
        },
      }),
    ).not.toThrow();
  });

  test("index.js reaching exhibits.js (directly or through a chunk) throws", () => {
    expect(() =>
      assertCoEntriesOffHostPath({
        dirName: "p.web.1",
        coEntries,
        staticImportsByFile: {
          "index.js": ["./shared-abc.mjs"],
          "shared-abc.mjs": ["./exhibits.js"],
          "exhibits.js": [],
        },
      }),
    ).toThrow("statically reaches exhibits.js");
  });
});

// A module worker resolves imports against its own URL — the page's import map
// never reaches it — so a worker chunk must arrive fully bundled.
describe("assertWorkersSelfContained", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function setup(workerSource: string): string {
    dir = mkdtempSync(join(tmpdir(), "web-artifacts-worker-"));
    mkdirSync(join(dir, "assets"));
    writeFileSync(join(dir, "index.js"), `import "@plugins/x/core";\n`);
    writeFileSync(join(dir, "assets", "w.worker-abc.js"), workerSource);
    writeFileSync(join(dir, "assets", "w.worker-abc.js.map"), "{}");
    return dir;
  }

  test("a self-contained worker passes and is listed", async () => {
    const outDir = setup(`self.onconnect = () => {};\n`);
    expect(
      await assertWorkersSelfContained({ dirName: "demo", outDir }),
    ).toEqual(["assets/w.worker-abc.js"]);
  });

  test("an artifact with no worker passes", async () => {
    dir = mkdtempSync(join(tmpdir(), "web-artifacts-worker-"));
    expect(
      await assertWorkersSelfContained({ dirName: "demo", outDir: dir }),
    ).toEqual([]);
  });

  test("a worker importing anything — static or dynamic — throws, naming it", async () => {
    const outDir = setup(
      `import { a } from "@plugins/x/core";\nconst b = () => import("./lazy.js");\n`,
    );
    let message = "";
    try {
      await assertWorkersSelfContained({ dirName: "demo", outDir });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain(
      "assets/w.worker-abc.js imports @plugins/x/core, ./lazy.js",
    );
  });
});

describe("chunkCssPlugin (a lazy chunk's styles stay off the entry)", () => {
  type Out = Record<string, Record<string, unknown>>;
  const chunk = (fileName: string, css: string[]) => ({
    type: "chunk",
    fileName,
    code: `/* ${fileName} */`,
    viteMetadata: { importedCss: new Set(css) },
  });
  const asset = (fileName: string, source: string) => ({
    type: "asset",
    fileName,
    source,
  });
  const run = (bundle: Out) =>
    (
      chunkCssPlugin("demo").generateBundle as unknown as (
        o: unknown,
        b: Out,
      ) => void
    ).call({}, {}, bundle);

  test("each chunk injects only its own CSS; CSS assets are consumed", () => {
    const bundle: Out = {
      "index.js": chunk("index.js", ["index.css"]),
      "lazy-X.mjs": chunk("lazy-X.mjs", ["lazy.css"]),
      "index.css": asset("index.css", ".entry{}"),
      "lazy.css": asset("lazy.css", ".katex{}"),
    };
    run(bundle);
    expect(bundle["index.js"]?.code).toContain(".entry{}");
    expect(bundle["index.js"]?.code).not.toContain(".katex{}");
    expect(bundle["lazy-X.mjs"]?.code).toContain(".katex{}");
    expect(Object.keys(bundle).sort()).toEqual(["index.js", "lazy-X.mjs"]);
  });

  test("a CSS asset no chunk imports throws", () => {
    const bundle: Out = {
      "index.js": chunk("index.js", []),
      "orphan.css": asset("orphan.css", ".x{}"),
    };
    expect(() => run(bundle)).toThrow(/belongs to no chunk/);
  });
});
