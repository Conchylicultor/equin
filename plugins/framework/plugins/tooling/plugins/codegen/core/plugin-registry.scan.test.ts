import { describe, expect, test } from "bun:test";
import { hasDefaultExport, importSpecifiers } from "./plugin-registry.scan";

describe("hasDefaultExport", () => {
  test("every value spelling of a default export", () => {
    for (const src of [
      "export default { name: 'x' } satisfies PluginDefinition;",
      "export default function f() {}",
      "export default class C {}",
      "const d = {}; export { d as default };",
      'export { default } from "./x";',
      'export { plugin as default } from "./x";',
    ])
      expect(hasDefaultExport(src, "index.ts")).toBe(true);
  });

  test("a nested template literal before it cannot hide it (the masker once lost sync here)", () => {
    const src = `import x from './x';
const s = \`a \${\`b \${'c'}\`} d\`;
export default { description: \`x \${s}\` };
`;
    expect(hasDefaultExport(src, "index.ts")).toBe(true);
  });

  test("no default export: commented, in a string, type-only, or a named one", () => {
    for (const src of [
      "// export default {}\nexport const a = 1;",
      "const s = 'export default {}';",
      'export type { T as default } from "./t";',
      "export { a as b };",
    ])
      expect(hasDefaultExport(src, "index.ts")).toBe(false);
  });
});

describe("importSpecifiers", () => {
  test("static imports and re-exports of every form, never strings or comments", () => {
    const src = `
      import a from "a";
      import type { B } from "b";
      import {
        c,
        d,
      } from "c";
      import "side-effect";
      export * from "e";
      export { f } from "f";
      import g = require("g");
      // import h from "h";
      const s = 'import i from "i"';
      const lazy = () => import("dynamic");
      declare module "m" { import j from "j"; }
    `;
    expect(importSpecifiers(src, "f.ts")).toEqual([
      "a",
      "b",
      "c",
      "side-effect",
      "e",
      "f",
      "g",
      "j",
    ]);
  });
});
