/**
 * Tests for `no-module-scope-dom`: a browser global read while the module
 * evaluates is reported — bare, or wrapped in any TypeScript cast — and left
 * alone inside a function, behind a `typeof` guard, and in a type position.
 */

import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-module-scope-dom";

const ruleTester = createRuleTester();
const filename = "plugins/fullscreen/web/m.ts";
const err = (count = 1) =>
  Array.from({ length: count }, () => ({
    messageId: "moduleScopeDom" as const,
  }));

ruleTester.run("no-module-scope-dom", rule, {
  valid: [
    // deferred: function bodies, class fields
    `function f() { return window.innerWidth; }`,
    `const f = () => (window as unknown as { x: number }).x;`,
    `class C { el = document.body; }`,
    `export function isEl(x: unknown) { return x instanceof HTMLElement; }`,
    // typeof guards
    `if (typeof window !== "undefined") window.addEventListener("x", f);`,
    `const w = typeof window !== "undefined" ? (window as Window).innerWidth : 0;`,
    // …also when the typeof operand itself is cast
    `const w = typeof (window as unknown) !== "undefined" ? window.innerWidth : 0;`,
    `const t = typeof document!;`,
    // type positions emit no read
    `let w: typeof window;`,
    `const el = x as HTMLElement;`,
    `const el = x satisfies Node;`,
    `type W = Window & typeof globalThis;`,
    // a local binding is not the global
    `const document = make(); document.body;`,
    // outside web/
    {
      code: `const w = window.innerWidth;`,
      filename: "plugins/fullscreen/server/m.ts",
    },
  ].map((c) => (typeof c === "string" ? { code: c, filename } : c)),
  invalid: [
    { code: `const w = window.innerWidth;`, errors: err() },
    // every cast form is still a read
    {
      code: `const x = (window as unknown as { x: number }).x;`,
      errors: err(),
    },
    { code: `const b = document!.body;`, errors: err() },
    { code: `const n = (<Navigator>navigator).language;`, errors: err() },
    {
      code: `const s = (localStorage satisfies Storage).length;`,
      errors: err(),
    },
    { code: `const d = ((document as Document)!).title;`, errors: err() },
    // the names no-render-time-dom reads too: the two rules agree
    { code: `const p = location.pathname;`, errors: err() },
    { code: `class X extends HTMLElement {}`, errors: err() },
    { code: `const ok = x instanceof SVGSVGElement;`, errors: err() },
    { code: `const t = Node.TEXT_NODE;`, errors: err() },
    // a class static block and a static field run at module evaluation
    { code: `class C { static { document.title = "x"; } }`, errors: err() },
    { code: `class C { static w = window.innerWidth; }`, errors: err() },
    // so do enum initializers and namespace bodies
    { code: `enum E { W = window.innerWidth }`, errors: err() },
    { code: `namespace N { export const t = document.title; }`, errors: err() },
    // a name the lint config declares as a global is still the browser's
    {
      code: `const w = (window as Window).innerWidth;`,
      languageOptions: { globals: { window: "readonly" as const } },
      errors: err(),
    },
  ].map((c) => ({ ...c, filename })),
});
