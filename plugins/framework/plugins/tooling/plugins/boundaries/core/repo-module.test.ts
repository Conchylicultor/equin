import { describe, expect, test } from "bun:test";
import { resolveRepoModule } from "./repo-module";

describe("resolveRepoModule", () => {
  const files = new Set([
    "plugins/audience/core/index.ts",
    "plugins/audience/shared/util.ts",
    "plugins/audience/web/view.tsx",
    "plugins/fullscreen/core/testing/index.ts",
  ]);
  const exists = (p: string): boolean => files.has(p);

  test.each([
    [
      "plugins/audience/web/x.ts",
      "@plugins/audience/core",
      "plugins/audience/core/index.ts",
    ],
    ["plugins/audience/web/x.ts", "../core", "plugins/audience/core/index.ts"],
    [
      "plugins/audience/web/x.ts",
      "../shared/util",
      "plugins/audience/shared/util.ts",
    ],
    [
      "plugins/audience/web/x.ts",
      "../shared/util.js",
      "plugins/audience/shared/util.ts",
    ],
    ["plugins/audience/web/x.ts", "./view", "plugins/audience/web/view.tsx"],
    [
      "plugins/audience/web/__tests__/x.test.tsx",
      "@plugins/fullscreen/core/testing",
      "plugins/fullscreen/core/testing/index.ts",
    ],
  ])("%s imports %s → %s", (from, spec, expected) => {
    expect(resolveRepoModule(from, spec, exists)).toBe(expected);
  });

  test.each(["react", "zod/v4", "./style.css", "./x.svg?raw", "../../../../x"])(
    "%s is not a repo module",
    (spec) => {
      expect(
        resolveRepoModule("plugins/audience/web/x.ts", spec, exists),
      ).toBeNull();
    },
  );

  test("an in-repo module specifier nothing answers throws", () => {
    expect(() =>
      resolveRepoModule(
        "plugins/audience/web/x.ts",
        "@plugins/audience/gone",
        exists,
      ),
    ).toThrow(/no repo module answers/);
  });
});
