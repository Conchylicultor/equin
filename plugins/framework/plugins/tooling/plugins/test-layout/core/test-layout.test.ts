/**
 * Classifier tests for the runner split. Co-located `*.test.ts` importing
 * `bun:test` — this file dogfoods the very rule the sibling check enforces (a
 * pure-logic test lives next to its source and never under a `__tests__/` dir).
 */

import { describe, expect, test } from "bun:test";
import {
  BUN_TEST_IGNORE,
  DOM_TEST_CLOCK_PIN,
  DOM_TEST_INCLUDE,
  DOM_TEST_SETUP_FILE,
  bunTestExactArgs,
  domTestExactInclude,
  formatDomTestFiles,
  isBunTestPath,
  isDomTestPath,
  isTestFilePath,
  partitionTestPaths,
} from "./test-layout";

// Fixture paths name REAL plugins (`page`, `tasks`, `primitives/plugins/pane`)
// even though the classifier is purely lexical and would not care. The
// `plugin-refs-resolve` check validates every whole-string `plugins/<…>` literal
// in the repo against the actual plugin tree, so invented names like
// `plugins/a/core/x.test.ts` fail it. Keep new fixtures on real plugin paths.
const PLUGINS = "plugins";

describe("isDomTestPath", () => {
  test("co-located pure-logic tests are NOT dom tests", () => {
    expect(
      isDomTestPath("plugins/page/plugins/editor/core/block-ops.test.ts"),
    ).toBe(false);
    expect(
      isDomTestPath(
        "plugins/primitives/plugins/pane/web/internal/route.test.ts",
      ),
    ).toBe(false);
    expect(isDomTestPath("cli/commands/build.test.ts")).toBe(false);
  });

  test("web/__tests__ paths under plugins ARE dom tests", () => {
    expect(
      isDomTestPath(
        "plugins/primitives/plugins/pane/web/__tests__/pane.test.tsx",
      ),
    ).toBe(true);
    expect(
      isDomTestPath(
        "plugins/primitives/plugins/pane/web/__tests__/deep/nested/x.test.ts",
      ),
    ).toBe(true);
    // `plugins/**/web/…` — the `**` may match zero segments. Assembled rather
    // than written as one literal because no plugin lives at `plugins/web`, so
    // the shape is unrepresentable with a real plugin name and a bare literal
    // would trip `plugin-refs-resolve` (see the note above). This is a
    // glob-semantics fixture, not a plugin reference.
    expect(isDomTestPath(`${PLUGINS}/web/__tests__/x.test.ts`)).toBe(true);
  });

  test(".tsx and .ts are both test extensions; other extensions are not", () => {
    expect(isDomTestPath("plugins/page/web/__tests__/x.test.tsx")).toBe(true);
    expect(isDomTestPath("plugins/page/web/__tests__/x.test.ts")).toBe(true);
    expect(isDomTestPath("plugins/page/web/__tests__/helpers.ts")).toBe(false);
    expect(isDomTestPath("plugins/page/web/__tests__/fixture.test.json")).toBe(
      false,
    );
    expect(isTestFilePath("plugins/page/core/x.test.tsx")).toBe(true);
    expect(isTestFilePath("plugins/page/core/x.ts")).toBe(false);
  });

  test("a leading ./ is tolerated on either kind of path", () => {
    expect(isDomTestPath("./plugins/page/web/__tests__/x.test.tsx")).toBe(true);
    expect(isDomTestPath("./plugins/page/core/x.test.ts")).toBe(false);
    expect(isBunTestPath("./plugins/page/core/x.test.ts")).toBe(true);
  });

  test("a __tests__ dir that is not web/__tests__ is not a dom test", () => {
    // The stray-suite case: ignored by neither scope's intent, caught by the check.
    expect(isDomTestPath("plugins/page/core/__tests__/foo.test.ts")).toBe(
      false,
    );
    expect(isDomTestPath("plugins/page/server/__tests__/foo.test.ts")).toBe(
      false,
    );
  });

  test("web/__tests__ OUTSIDE plugins/ is not a dom test (vitest's include is anchored)", () => {
    expect(isDomTestPath("cli/web/__tests__/x.test.ts")).toBe(false);
  });
});

describe("isBunTestPath", () => {
  test("runs every test file the bun ignore does not exclude", () => {
    expect(isBunTestPath("plugins/page/core/x.test.ts")).toBe(true);
    expect(isBunTestPath("plugins/page/core/__tests__/foo.test.ts")).toBe(true);
    expect(isBunTestPath("cli/commands/build.test.ts")).toBe(true);
  });

  test("excludes anything under a web/__tests__ dir, wherever it lives", () => {
    expect(isBunTestPath("plugins/page/web/__tests__/x.test.tsx")).toBe(false);
    // Unanchored ignore: excluded by bun even though vitest's include misses it.
    expect(isBunTestPath("cli/web/__tests__/x.test.ts")).toBe(false);
    expect(isBunTestPath("web/__tests__/x.test.ts")).toBe(false);
  });

  test("is NOT the plain negation of isDomTestPath", () => {
    const orphan = "cli/web/__tests__/x.test.ts";
    expect(isDomTestPath(orphan)).toBe(false);
    expect(isBunTestPath(orphan)).toBe(false);
  });
});

describe("partitionTestPaths", () => {
  test("buckets each path by the runner that actually runs it", () => {
    const { bun, dom, orphan } = partitionTestPaths([
      "plugins/page/core/x.test.ts",
      "plugins/page/web/__tests__/y.test.tsx",
      "./plugins/tasks/shared/z.test.ts",
      "plugins/tasks/core/__tests__/stray.test.ts",
    ]);
    expect(dom).toEqual(["plugins/page/web/__tests__/y.test.tsx"]);
    expect(bun).toEqual([
      "plugins/page/core/x.test.ts",
      "./plugins/tasks/shared/z.test.ts",
      "plugins/tasks/core/__tests__/stray.test.ts",
    ]);
    expect(orphan).toEqual([]);
  });

  test("a path in neither scope lands in orphan, never silently in bun", () => {
    const { bun, dom, orphan } = partitionTestPaths([
      "cli/web/__tests__/x.test.ts",
    ]);
    expect(bun).toEqual([]);
    expect(dom).toEqual([]);
    expect(orphan).toEqual(["cli/web/__tests__/x.test.ts"]);
  });

  test("non-test files are never claimed by either runner", () => {
    const { bun, dom, orphan } = partitionTestPaths([
      "plugins/page/core/index.ts",
    ]);
    expect(bun).toEqual([]);
    expect(dom).toEqual([]);
    expect(orphan).toEqual(["plugins/page/core/index.ts"]);
  });

  test("returns empty buckets for empty input", () => {
    expect(partitionTestPaths([])).toEqual({ bun: [], dom: [], orphan: [] });
  });
});

describe("the scope literals", () => {
  test("the bun ignore is the complement of the vitest include", () => {
    // Both halves describe the same directory shape; the ignore is unanchored
    // and the include is anchored at `plugins/`. Rule (c) of the check closes
    // the gap that difference opens.
    expect(DOM_TEST_INCLUDE).toContain("web/__tests__/");
    expect(BUN_TEST_IGNORE).toContain("web/__tests__/");
    expect(DOM_TEST_INCLUDE.startsWith("plugins/")).toBe(true);
    expect(BUN_TEST_IGNORE.startsWith("**/")).toBe(true);
  });

  test("the setup file is inside vitest's setup, and the pin literal is a call", () => {
    // Rule (f) reads the setup file by this repo-relative path and looks for
    // this exact substring. Both are asserted here only for shape: the file
    // sitting outside `plugins/` is what makes rule (f) read it directly rather
    // than through the test-file sweep, and the pin has to be the CALL — a bare
    // `vi.setSystemTime` would also match a mention of the function in prose.
    expect(DOM_TEST_SETUP_FILE.startsWith("plugins/")).toBe(false);
    expect(DOM_TEST_SETUP_FILE.endsWith(".ts")).toBe(true);
    expect(DOM_TEST_CLOCK_PIN).toContain("vi.setSystemTime(");
    expect(DOM_TEST_CLOCK_PIN.endsWith(")")).toBe(true);
  });
});

describe("exact selection", () => {
  const bunFile = `${PLUGINS}/page/core/x.test.ts`;
  const domFile = `${PLUGINS}/page/web/__tests__/x.test.tsx`;

  test("bun files go in ./-prefixed — bun's spelling of a path, not a filter", () => {
    expect(bunTestExactArgs([bunFile, `./${bunFile}`])).toEqual([
      `./${bunFile}`,
      `./${bunFile}`,
    ]);
  });

  test("a file outside a runner's half is refused, not handed over", () => {
    expect(() => bunTestExactArgs([domFile])).toThrow("not a bun:test file");
    expect(() => formatDomTestFiles([bunFile])).toThrow("not a vitest");
    expect(() => domTestExactInclude(bunFile)).toThrow("not a vitest");
  });

  test("the vitest list round-trips into an include of the same files", () => {
    const other = `${PLUGINS}/tasks/web/__tests__/y.test.ts`;
    expect(domTestExactInclude(formatDomTestFiles([domFile, other]))).toEqual([
      domFile,
      other,
    ]);
  });

  test("glob metacharacters in a path are escaped, so it matches only itself", () => {
    const odd = `${PLUGINS}/page/web/__tests__/[id](x){a,b}*.test.ts`;
    expect(domTestExactInclude(odd)).toEqual([
      `${PLUGINS}/page/web/__tests__/\\[id\\]\\(x\\)\\{a,b\\}\\*.test.ts`,
    ]);
  });

  test("an empty selection is an error on both sides", () => {
    expect(() => formatDomTestFiles([])).toThrow("no files");
    expect(() => domTestExactInclude("")).toThrow("empty");
  });
});
