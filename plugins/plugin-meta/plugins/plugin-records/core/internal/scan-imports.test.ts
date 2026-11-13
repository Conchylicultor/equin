import { describe, expect, test } from "bun:test";
import { scanModuleImports } from "./scan-imports";

describe("scanModuleImports", () => {
  test("reads past a hashbang line, as the runtime does", () => {
    expect(
      scanModuleImports(
        '#!bun\nimport { a } from "./a";\nconsole.log(a);\nawait import("./b");\n',
        "bin/entry.ts",
      ),
    ).toEqual([
      { spec: "./a", dynamic: false },
      { spec: "./b", dynamic: true },
    ]);
  });
});
