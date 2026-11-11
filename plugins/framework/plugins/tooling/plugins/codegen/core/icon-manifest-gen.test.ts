import { describe, expect, it } from "bun:test";
import ts from "typescript";
import { scanIconNames as scanWith } from "./icon-manifest.scan";

const scanIconNames = (src: string, path: string) => scanWith(ts, src, path);

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

  it("collects a symbol spread into an object, and still skips member calls", () => {
    expect(
      scanIconNames(
        `${IMPORT}const a = { ...symbol("progress-activity"), spin: true };\nfoo.symbol(x);\nfoo?.symbol(y);`,
        "x.ts",
      ).symbols,
    ).toEqual(["progress-activity"]);
  });

  it("ignores a symbol imported from an unrelated relative module", () => {
    expect(
      scanIconNames(
        `import { symbol } from "./other";\nsymbol("x");`,
        "plugins/tasks/core/b.ts",
      ),
    ).toEqual({ symbols: [], brands: [], seti: [] });
  });

  it("ignores member names, keys, comments and strings", () => {
    expect(
      scanIconNames(
        `${IMPORT}// symbol("commented")\nconst s = "symbol(\\"quoted\\")";\nfoo.symbol(x);\nconst o = { symbol: 1 };\ntype T = { symbol: string };`,
        "x.ts",
      ),
    ).toEqual({ symbols: [], brands: [], seti: [] });
  });

  it("collects a call wherever it sits: an argument, a default, an array", () => {
    expect(
      scanIconNames(
        `${IMPORT}f(symbol("a"));\nfunction g(i = symbol("b")) {}\nconst l = [brand("github")];`,
        "x.tsx",
      ),
    ).toEqual({ symbols: ["a", "b"], brands: ["github"], seti: [] });
  });

  it("throws on a use that is not a direct call", () => {
    expect(() => scanIconNames(`${IMPORT}const f = symbol;`, "x.ts")).toThrow(
      /x\.ts:2: `symbol` is used other than called/,
    );
    expect(() => scanIconNames(`${IMPORT}names.map(symbol);`, "x.ts")).toThrow(
      /used other than called/,
    );
  });

  it("throws on a declaration shadowing the import", () => {
    expect(() =>
      scanIconNames(`${IMPORT}function f() { const symbol = 1; }`, "x.ts"),
    ).toThrow(/shadowing the imported icon constructor/);
  });

  it("throws on a namespace import of the icons core", () => {
    expect(() =>
      scanIconNames(
        `import * as icons from "@plugins/ui/plugins/icons/core";\nicons.symbol("forum");`,
        "x.ts",
      ),
    ).toThrow(/through a namespace/);
  });

  it("throws on a non-literal name", () => {
    expect(() => scanIconNames(`${IMPORT}symbol(name);`, "x.ts")).toThrow(
      /x\.ts:2: symbol\(…\) id is not a static string literal/,
    );
  });
});
