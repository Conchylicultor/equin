import { describe, expect, test } from "bun:test";
import { scanIconUses } from "./icon-uses.scan";
import { parseManifestLists } from "./manifest-covers-uses";

const IMPORT = `import { symbol, brand, seti } from "@plugins/ui/plugins/icons/core";`;

describe("scanIconUses", () => {
  test("reads every literal call by binding, wherever it sits", () => {
    const src = `${IMPORT}
export const working = { ...symbol("progress-activity"), spin: true };
f(brand("github"));
const x = [seti("typescript")];
function g(a = symbol("forum")) { return a; }`;
    expect(
      scanIconUses(src, "plugins/tasks/core/a.ts").map((u) => [
        u.marker,
        u.name,
        u.line,
      ]),
    ).toEqual([
      ["symbol", "progress-activity", 2],
      ["symbol", "forum", 5],
      ["brand", "github", 3],
      ["seti", "typescript", 4],
    ]);
  });

  test("a relative import from inside the icons plugin counts", () => {
    const src = `import { symbol } from "../../core";\nconst a = symbol("close");`;
    expect(
      scanIconUses(src, "plugins/ui/plugins/icons/web/internal/a.tsx").map(
        (u) => u.name,
      ),
    ).toEqual(["close"]);
  });

  test("a symbol() from another module, or a shadowing local, is not an icon", () => {
    const src = `import { symbol } from "./other";\nsymbol("x");`;
    expect(scanIconUses(src, "plugins/tasks/core/a.ts")).toEqual([]);
    const shadowed = `${IMPORT}\nfunction f(symbol: (s: string) => void) { symbol("y"); }`;
    expect(scanIconUses(shadowed, "plugins/tasks/core/a.ts")).toEqual([]);
  });

  test("parses TSX", () => {
    const src = `${IMPORT}\nexport const A = () => <Icon icon={symbol("add")} />;`;
    expect(
      scanIconUses(src, "plugins/tasks/web/a.tsx").map((u) => u.name),
    ).toEqual(["add"]);
  });
});

describe("parseManifestLists", () => {
  test("reads the three lists", () => {
    const m = parseManifestLists(
      `export const ICON_MANIFEST = {\n  symbols: [\n    "add",\n    "close",\n  ],\n  brands: [],\n  seti: [\n    "go",\n  ],\n};`,
    );
    expect([...m.symbols]).toEqual(["add", "close"]);
    expect([...m.brands]).toEqual([]);
    expect([...m.seti]).toEqual(["go"]);
  });

  test("a manifest without a list throws, never reads as empty", () => {
    expect(() => parseManifestLists("export const X = {};")).toThrow(/symbols/);
  });
});
