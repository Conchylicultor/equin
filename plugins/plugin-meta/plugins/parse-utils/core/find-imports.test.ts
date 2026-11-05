/**
 * Tests for the shared static-import scanner. Run with `bun test` from the repo
 * root.
 *
 * The regression these guard against: a raw-text import scanner run over source
 * whose string interiors are KEPT (`maskSource(src, { strings: false })`) treats
 * an import statement embedded *inside* a string/template literal (a test
 * fixture, a docs snippet, a codegen template) as a real import. `findImports`
 * masks strings fully and reads the specifier back by offset, so embedded
 * sample source can never be mistaken for a genuine import.
 */

import { test, expect } from "bun:test";
import { findImports } from "./index";

const specs = (src: string) => findImports(src).map((i) => i.specifier);

// === specifier extraction ====================================================

test("default import", () => {
  expect(specs(`import Foo from "@plugins/a/web";`)).toEqual(["@plugins/a/web"]);
});

test("named import", () => {
  expect(specs(`import { a, b } from "@plugins/a/core";`)).toEqual(["@plugins/a/core"]);
});

test("mixed default + named import", () => {
  expect(specs(`import Foo, { a } from "@plugins/a/web";`)).toEqual(["@plugins/a/web"]);
});

test("namespace import", () => {
  expect(specs(`import * as NS from "@plugins/a/server";`)).toEqual(["@plugins/a/server"]);
});

test("side-effect import", () => {
  const found = findImports(`import "@plugins/a/web/style.css";`);
  expect(found).toHaveLength(1);
  expect(found[0]!.specifier).toBe("@plugins/a/web/style.css");
  expect(found[0]!.sideEffect).toBe(true);
});

test("export … from", () => {
  const found = findImports(`export { a } from "@plugins/a/core";`);
  expect(found[0]!.specifier).toBe("@plugins/a/core");
  expect(found[0]!.keyword).toBe("export");
});

test("export * from", () => {
  expect(specs(`export * from "@plugins/a/core";`)).toEqual(["@plugins/a/core"]);
});

test("multi-line import", () => {
  const src = `import {\n  a,\n  b,\n} from "@plugins/a/core";`;
  expect(specs(src)).toEqual(["@plugins/a/core"]);
});

test("relative and bare specifiers alike", () => {
  const src = `import { a } from "../../core";\nimport { z } from "zod";`;
  expect(specs(src)).toEqual(["../../core", "zod"]);
});

test("multiple imports are returned in source order", () => {
  const src = [
    `import a from "@plugins/z/web";`,
    `import b from "@plugins/a/web";`,
    `import "@plugins/m/web/x.css";`,
  ].join("\n");
  expect(specs(src)).toEqual(["@plugins/z/web", "@plugins/a/web", "@plugins/m/web/x.css"]);
});

// === type-only detection =====================================================

test("whole-statement type import is flagged typeOnly", () => {
  const found = findImports(`import type { T } from "@plugins/a/core";`);
  expect(found[0]!.typeOnly).toBe(true);
});

test("export type … from is flagged typeOnly", () => {
  const found = findImports(`export type { T } from "@plugins/a/core";`);
  expect(found[0]!.typeOnly).toBe(true);
});

test("export type * and a default type import are flagged typeOnly", () => {
  expect(findImports(`export type * from "./a";`)[0]!.typeOnly).toBe(true);
  expect(findImports(`import type T from "./a";`)[0]!.typeOnly).toBe(true);
});

test("a default import NAMED type is a value import", () => {
  expect(findImports(`import type from "./a";`)[0]!.typeOnly).toBe(false);
  expect(findImports(`import type, { a } from "./a";`)[0]!.typeOnly).toBe(
    false,
  );
});

test("inline type binding is NOT a whole-statement type import", () => {
  const found = findImports(`import { type T, a } from "@plugins/a/core";`);
  expect(found[0]!.typeOnly).toBe(false);
});

// === the core regression: imports embedded in strings/comments ===============

test("import statement inside a template literal is IGNORED", () => {
  const src = "const fixture = `import { X } from \"../../core\";`;";
  expect(specs(src)).toEqual([]);
});

test("import statement inside a double-quoted string is IGNORED", () => {
  const src = `const sample = "import Foo from '@plugins/a/web'";`;
  expect(specs(src)).toEqual([]);
});

test("multi-line import embedded in a template literal is IGNORED", () => {
  const src = "const doc = `\nimport { a } from \"@plugins/a/core\";\nexport * from \"@plugins/b/core\";\n`;";
  expect(specs(src)).toEqual([]);
});

test("commented-out import is IGNORED", () => {
  const src = `// import { X } from "@plugins/a/web";\nimport { Y } from "@plugins/a/core";`;
  expect(specs(src)).toEqual(["@plugins/a/core"]);
});

test("real import is still found alongside an embedded-string fixture", () => {
  const src = [
    `import { real } from "@plugins/a/core";`,
    "const fixture = `import { fake } from \"@plugins/b/web\";`;",
  ].join("\n");
  expect(specs(src)).toEqual(["@plugins/a/core"]);
});

// === non-imports are not matched ============================================

test("dynamic import() is NOT matched", () => {
  const src = `const m = await import("@plugins/a/web");`;
  expect(specs(src)).toEqual([]);
});

test("import.meta is NOT matched", () => {
  const src = `const u = import.meta.url;\nconst v = new URL("x", import.meta.url);`;
  expect(specs(src)).toEqual([]);
});

test("a binding named `from` does not derail parsing", () => {
  expect(specs(`import { from } from "@plugins/a/core";`)).toEqual(["@plugins/a/core"]);
});

// === offset fidelity =========================================================

test("index points at the specifier's first char in the ORIGINAL source", () => {
  const src = `  import Foo from "@plugins/a/web";`;
  const [ref] = findImports(src);
  expect(src.slice(ref!.index, ref!.index + ref!.specifier.length)).toBe("@plugins/a/web");
});
