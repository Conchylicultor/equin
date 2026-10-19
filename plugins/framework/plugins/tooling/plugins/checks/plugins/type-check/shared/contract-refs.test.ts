/**
 * What a contract names (research/2026-10-18-global-typed-lint-key-stops-at-contracts.md):
 * every way a `.d.ts` can mention another module — import / export
 * declarations, `import x = require()`, import types, triple-slash paths, and
 * augmented modules — each with the export names it is used for (`*` for the
 * whole module). Nothing else: a name that is only a string is not an edge.
 */

import { expect, test } from "bun:test";
import { contractSpecifiers } from "./contract-refs";

test("every kind of module mention is an edge, with the names it is used for", () => {
  const dts = [
    '/// <reference path="./globals.d.ts" />',
    'import type { A } from "./a";',
    'import { B } from "@plugins/b/core";',
    'export { C } from "./c";',
    'export * from "./d";',
    'import E = require("./e");',
    'export declare const f: import("./f").F;',
    'export declare const g: typeof import("./g");',
    'export declare const again: import("./a").A2;',
    'export declare const notAnEdge = "./h";',
    "export {};",
  ].join("\n");
  expect(contractSpecifiers(dts)).toEqual({
    modules: {
      "./a": ["A", "A2"],
      "./c": ["C"],
      "./d": ["*"],
      "./e": ["*"],
      "./f": ["F"],
      "./g": ["*"],
      "@plugins/b/core": ["B"],
    },
    paths: ["./globals.d.ts"],
  });
});

test("a module augmentation is an edge to the augmented module", () => {
  const dts = [
    'import "@tanstack/react-query";',
    'declare module "@tanstack/react-query" {',
    "  interface Register { x: 1 }",
    "}",
    "export {};",
  ].join("\n");
  expect(contractSpecifiers(dts)).toEqual({
    modules: { "@tanstack/react-query": ["*"] },
    paths: [],
  });
});

test("a contract that names nothing has no edges", () => {
  expect(contractSpecifiers("export declare function k(): number;\n")).toEqual({
    modules: {},
    paths: [],
  });
});
