import { describe, expect, test } from "bun:test";
import { isGuardPath, parseFixLog } from "./fix-commits";

describe("isGuardPath", () => {
  test("lint rules and checks are guards, their tests are not", () => {
    expect(isGuardPath("src/a/lint/no-foo.ts")).toBe(true);
    expect(isGuardPath("src/a/check/index.ts")).toBe(true);
    expect(isGuardPath("src/a/check/foo.test.ts")).toBe(false);
    expect(isGuardPath("src/a/server/internal/check.ts")).toBe(false);
  });
});

describe("parseFixLog", () => {
  test("one fix per push, a guard when any of its commits added one", () => {
    const out = [
      "@@aaa 1795000000 push-1",
      "",
      "src/a/server/a.ts",
      "@@bbb 1795000100 push-1",
      "",
      "src/a/lint/rule.ts",
      "@@ccc 1795000200 ",
      "",
      "src/b/web/b.tsx",
    ].join("\n");
    const fixes = parseFixLog(out);
    expect(fixes).toHaveLength(2);
    expect(fixes[0]).toEqual({ at: 1795000100_000, guard: true });
    expect(fixes[1]).toEqual({ at: 1795000200_000, guard: false });
  });
});
