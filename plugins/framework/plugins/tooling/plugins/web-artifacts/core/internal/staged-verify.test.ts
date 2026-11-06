import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  asAppPath,
  joinAppPath,
  type AppPath,
} from "@plugins/infra/plugins/host-fs/plugins/user-path/core";
import { scanStagedModules } from "./staged-verify";

describe("scanStagedModules (ground-truth scan of the staged dist)", () => {
  let staging: AppPath;
  afterEach(() => rmSync(staging, { recursive: true, force: true }));

  /** Every link the test staged (what compose would hand the scan). */
  const staged = (): string[] => readdirSync(joinAppPath(staging, "artifacts"));

  const artifact = (linkName: string, files: Record<string, string>): void => {
    const dir = joinAppPath(staging, "artifacts", linkName);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(joinAppPath(dir, name), content);
    }
  };

  test("verifies every staged file — chunks included — against the map", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js": `import "./chunk-abc.mjs"; import "mapped-pkg";\n`,
      // The exact outage shape: a lazy chunk importing an unmapped bare spec.
      "chunk-abc.mjs": `import "unmapped-pkg"; import "./missing-chunk.mjs";\n`,
      "index.js.map": "{}", // sourcemaps are not modules
    });
    artifact("b.web.222", {
      "index.js":
        `const lazyOk = () => import("@plugins/x/prewarm");\n` + // browser-unreachable: silent
        `const lazyBad = () => import("unmapped-dyn");\n`, // plain dynamic miss: warning
    });
    artifact("composition-web-registry.registry.333", {
      "index.js": `export const load = () => import("@plugins/y/web");\n`, // registry: strict
    });

    const { failures, warnings } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { "mapped-pkg": "/artifacts/set.f/mapped-pkg.js" },
    });
    expect(failures).toEqual([
      { specifier: "unmapped-pkg", file: "artifacts/a.web.111/chunk-abc.mjs" },
      {
        specifier: "./missing-chunk.mjs",
        file: "artifacts/a.web.111/chunk-abc.mjs",
      },
      {
        specifier: "@plugins/y/web",
        file: "artifacts/composition-web-registry.registry.333/index.js",
      },
    ]);
    expect(warnings).toEqual([
      { specifier: "unmapped-dyn", file: "artifacts/b.web.222/index.js" },
    ]);
  });

  test("a fully-mapped staged tree passes clean", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js": `import "./chunk.mjs"; import "react";\n`,
      "chunk.mjs": `export const x = 1;\n`,
    });
    const { failures, warnings } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { react: "/artifacts/set.f/react.js" },
    });
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
  });
});

describe("scanStagedModules (link verification: names the target must export)", () => {
  let staging: AppPath;
  afterEach(() => rmSync(staging, { recursive: true, force: true }));

  /** Every link the test staged (what compose would hand the scan). */
  const staged = (): string[] => readdirSync(joinAppPath(staging, "artifacts"));

  const artifact = (linkName: string, files: Record<string, string>): void => {
    const dir = joinAppPath(staging, "artifacts", linkName);
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(joinAppPath(dir, name), content);
    }
  };

  test("a named import the target does not export fails; the ones it does pass", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js": `import { TaskRow, TaskList } from "@plugins/tasks/web";\nexport default {};\n`,
    });
    artifact("tasks.web.222", {
      "index.js": `export const TaskList = 1;\nexport default {};\n`,
    });

    const { failures, linkFailures } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { "@plugins/tasks/web": "/artifacts/tasks.web.222/index.js" },
    });
    expect(failures).toEqual([]);
    expect(linkFailures).toEqual([
      {
        specifier: "@plugins/tasks/web",
        name: "TaskRow",
        file: "artifacts/a.web.111/index.js",
      },
    ]);
  });

  test("a missing default, and a relative link into a sibling chunk, both fail", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js": `import midi from "@tonejs/midi";\nimport { gone } from "./chunk.mjs";\nexport default {};\n`,
      "chunk.mjs": `export const here = 1;\n`,
    });
    artifact("set.f", { "midi.js": `export const Midi = 1;\n` });

    const { failures, linkFailures } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { "@tonejs/midi": "/artifacts/set.f/midi.js" },
    });
    expect(failures).toEqual([]);
    expect(linkFailures).toEqual([
      {
        specifier: "@tonejs/midi",
        name: "default",
        file: "artifacts/a.web.111/index.js",
      },
      {
        specifier: "./chunk.mjs",
        name: "gone",
        file: "artifacts/a.web.111/index.js",
      },
    ]);
  });

  test("namespace and dynamic imports are not name-checked", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js":
        `import * as ns from "@plugins/tasks/web";\n` + // member access is dynamic
        `const lazy = () => import("@plugins/tasks/web");\n` + // names unknowable
        `export default { ns, lazy };\n`,
    });
    artifact("tasks.web.222", { "index.js": `export default {};\n` });

    const { failures, linkFailures } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { "@plugins/tasks/web": "/artifacts/tasks.web.222/index.js" },
    });
    expect(failures).toEqual([]);
    expect(linkFailures).toEqual([]);
  });

  test("`export {…} from` re-exports never invent a phantom `default` requirement", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    // The lexer reports this in the IMPORTS array, d === -1 — see import-clause.ts.
    artifact("a.web.111", {
      "index.js": `export { TaskList } from "@plugins/tasks/web";\nexport default {};\n`,
    });
    artifact("tasks.web.222", {
      "index.js": `export const TaskList = 1;\nexport default {};\n`,
    });

    const { failures, linkFailures } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { "@plugins/tasks/web": "/artifacts/tasks.web.222/index.js" },
    });
    expect(failures).toEqual([]);
    expect(linkFailures).toEqual([]);
  });

  test("an opaque (`export *`) target warns instead of failing", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js": `import { Anything } from "@plugins/tasks/web";\nexport default {};\n`,
    });
    artifact("tasks.web.222", {
      "index.js": `export * from "./inner.mjs";\nexport default {};\n`,
      "inner.mjs": `export const Anything = 1;\n`,
    });

    const { failures, linkFailures, opaqueTargets } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: { "@plugins/tasks/web": "/artifacts/tasks.web.222/index.js" },
    });
    expect(failures).toEqual([]);
    expect(linkFailures).toEqual([]);
    expect(opaqueTargets).toEqual(["artifacts/tasks.web.222/index.js"]);
  });

  test("a web barrel with no `default` export fails, blamed on the registry", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("composition-web-registry.registry.333", {
      "index.js": `export const load = () => import("@plugins/tasks/web");\n`,
    });
    artifact("tasks.web.222", { "index.js": `export const TaskList = 1;\n` });
    artifact("tasks.core.444", { "index.js": `export const Task = 1;\n` }); // non-web: not asserted

    const { failures, linkFailures } = await scanStagedModules({
      stagingDir: staging,
      linkNames: staged(),
      imports: {
        "@plugins/tasks/web": "/artifacts/tasks.web.222/index.js",
        "@plugins/tasks/core": "/artifacts/tasks.core.444/index.js",
      },
    });
    expect(failures).toEqual([]);
    expect(linkFailures).toEqual([
      {
        specifier: "@plugins/tasks/web",
        name: "default",
        file: "artifacts/composition-web-registry.registry.333/index.js",
      },
    ]);
  });

  test("a fully-linked staged tree passes clean", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", {
      "index.js":
        `import { TaskList as t } from "@plugins/tasks/web";\n` +
        `import def, { helper } from "./chunk.mjs";\n` +
        `export default { t, def, helper };\n`,
      "chunk.mjs": `export const helper = 1;\nexport default 2;\n`,
    });
    artifact("tasks.web.222", {
      "index.js": `export const TaskList = 1;\nexport default {};\n`,
    });

    const { failures, warnings, linkFailures, opaqueTargets } =
      await scanStagedModules({
        stagingDir: staging,
        linkNames: staged(),
        imports: { "@plugins/tasks/web": "/artifacts/tasks.web.222/index.js" },
      });
    expect(failures).toEqual([]);
    expect(warnings).toEqual([]);
    expect(linkFailures).toEqual([]);
    expect(opaqueTargets).toEqual([]);
  });

  test("scans only the links compose made, never the rest of an address dir", async () => {
    staging = asAppPath(mkdtempSync(join(tmpdir(), "staged-verify-")));
    artifact("a.web.111", { "index.js": `export const a = 1;\n` });
    // An address an earlier build composed: still served, not this graph's.
    artifact("old.web.000", { "index.js": `import "long-gone-pkg";\n` });
    const { failures } = await scanStagedModules({
      stagingDir: staging,
      imports: {},
      linkNames: ["a.web.111"],
    });
    expect(failures).toEqual([]);
  });
});
