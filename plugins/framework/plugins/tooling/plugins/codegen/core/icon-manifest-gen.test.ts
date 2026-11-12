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
    expect(() => scanIconNames(`${IMPORT}symbol("a", "b");`, "x.ts")).toThrow(
      /not called with exactly one argument/,
    );
  });

  it("throws on a declaration shadowing the import", () => {
    expect(() =>
      scanIconNames(`${IMPORT}function f() { const symbol = 1; }`, "x.ts"),
    ).toThrow(/shadowing the imported binding/);
  });

  it("collects through a namespace import, and throws on one it cannot read", () => {
    const NS = `import * as icons from "@plugins/ui/plugins/icons/core";\n`;
    expect(
      scanIconNames(
        `${NS}icons.symbol("forum");\nicons.runtimeSymbol(x);`,
        "x.ts",
      ),
    ).toEqual({ symbols: ["forum"], brands: [], seti: [] });
    expect(() => scanIconNames(`${NS}icons[k]("forum");`, "x.ts")).toThrow(
      /x\.ts:2: the namespace `icons` .* is indexed/,
    );
    expect(() => scanIconNames(`${NS}use(icons);`, "x.ts")).toThrow(
      /used as a value/,
    );
  });

  it("throws on a re-export outside the icons core, and allows the barrel's own", () => {
    expect(() =>
      scanIconNames(
        `export { symbol as s } from "@plugins/ui/plugins/icons/core";`,
        "plugins/tasks/core/x.ts",
      ),
    ).toThrow(
      /plugins\/tasks\/core\/x\.ts:1: an icon constructor is re-exported/,
    );
    expect(() =>
      scanIconNames(`${IMPORT}export { symbol };`, "plugins/tasks/core/x.ts"),
    ).toThrow(/re-exported/);
    expect(() =>
      scanIconNames(
        `export * from "@plugins/ui/plugins/icons/core";`,
        "plugins/tasks/core/x.ts",
      ),
    ).toThrow(/re-exported/);
    expect(
      scanIconNames(
        `export { brand, runtimeSymbol, seti, symbol } from "./icon-ref";`,
        "plugins/ui/plugins/icons/core/index.ts",
      ),
    ).toEqual({ symbols: [], brands: [], seti: [] });
  });

  it("throws on a non-literal name, naming every one", () => {
    expect(() =>
      scanIconNames(`${IMPORT}symbol(name);\nbrand(a ? "x" : "y");`, "x.ts"),
    ).toThrow(
      /x\.ts:2: not a string literal[\s\S]*x\.ts:3: not a string literal/,
    );
  });
});
