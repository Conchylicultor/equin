import { describe, expect, it } from "bun:test";
import { scanIconNames } from "./icon-manifest.scan";

const IMPORT = `import { symbol, brand, seti } from "@plugins/ui/plugins/icons/core";\n`;

describe("scanIconNames", () => {
  it("collects symbol, brand and seti literals from a file importing the icons core", () => {
    expect(
      scanIconNames(
        `${IMPORT}const a = symbol("forum");\nconst b = brand('github');\nconst c = symbol( "keep" );\nconst d = seti("typescript");`,
        "x.ts",
      ),
    ).toEqual({
      symbols: ["forum", "keep"],
      brands: ["github"],
      seti: ["typescript"],
    });
  });

  it("ignores files that do not import the icons core", () => {
    expect(scanIconNames(`const a = symbol(x);`, "x.ts")).toEqual({
      symbols: [],
      brands: [],
      seti: [],
    });
  });

  it("collects from a file reaching the constructors by a relative path inside the icons plugin", () => {
    expect(
      scanIconNames(
        `import { symbol } from "./icon-ref";\nexport const navIcons = { newTab: symbol("open-in-new") };`,
        "plugins/ui/plugins/icons/core/nav-icons.ts",
      ),
    ).toEqual({ symbols: ["open-in-new"], brands: [], seti: [] });
    expect(
      scanIconNames(
        `import { symbol } from "../../core";\nconst a = symbol("close");`,
        "plugins/ui/plugins/icons/web/internal/x.tsx",
      ).symbols,
    ).toEqual(["close"]);
  });

  it("ignores a symbol imported from an unrelated relative module", () => {
    expect(
      scanIconNames(
        `import { symbol } from "./other";\nsymbol("x");`,
        "plugins/tasks/core/b.ts",
      ),
    ).toEqual({ symbols: [], brands: [], seti: [] });
  });

  it("ignores member calls, declarations, comments and strings", () => {
    expect(
      scanIconNames(
        `${IMPORT}// symbol("commented")\nconst s = "symbol(\\"quoted\\")";\nfoo.symbol(x);\nexport function symbol(name) {}`,
        "x.ts",
      ),
    ).toEqual({ symbols: [], brands: [], seti: [] });
  });

  it("throws on a non-literal name", () => {
    expect(() => scanIconNames(`${IMPORT}symbol(name);`, "x.ts")).toThrow(
      /x\.ts:2: symbol\(…\) id is not a static string literal/,
    );
  });
});
