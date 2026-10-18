/**
 * What a contract names (research/2026-10-18-global-typed-lint-key-stops-at-contracts.md):
 * every way a `.d.ts` can mention another module — import / export
 * declarations, `import x = require()`, import types, triple-slash paths — and
 * whether it augments one. Nothing else: a name that is only a string is not
 * an edge.
 */

import { expect, test } from "bun:test";
import { contractSpecifiers } from "./contract-refs";

test("every kind of module mention is an edge, sorted and de-duplicated", () => {
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
    modules: ["./a", "./c", "./d", "./e", "./f", "./g", "@plugins/b/core"],
    paths: ["./globals.d.ts"],
    augments: false,
  });
});

test("a module augmentation is an edge to the augmented module, and marks the contract", () => {
  const dts = [
    'import "@tanstack/react-query";',
    'declare module "@tanstack/react-query" {',
    "  interface Register { x: 1 }",
    "}",
    "export {};",
  ].join("\n");
  expect(contractSpecifiers(dts)).toEqual({
    modules: ["@tanstack/react-query"],
    paths: [],
    augments: true,
  });
});

test("a contract that names nothing has no edges", () => {
  expect(contractSpecifiers("export declare function k(): number;\n")).toEqual({
    modules: [],
    paths: [],
    augments: false,
  });
});
