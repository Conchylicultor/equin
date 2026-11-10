/**
 * Tests for `no-root-style-write`: `<html>`'s inline style is never touched —
 * directly or through a const holding the root — while other elements' styles
 * and the root's other members are left alone.
 */

import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-root-style-write";

const ruleTester = createRuleTester();

ruleTester.run("no-root-style-write", rule, {
  valid: [
    `el.style.setProperty("--x", "1px");`,
    `document.body.style.overflow = "hidden";`,
    `document.documentElement.classList.toggle("dark", true);`,
    `getComputedStyle(document.documentElement).getPropertyValue("--x");`,
    `let root = document.documentElement; root = other; root.style.color = "red";`,
    `const root = document.body; root.style.color = "red";`,
  ],
  invalid: [
    {
      code: `document.documentElement.style.setProperty("--x", "1px");`,
      errors: [{ messageId: "rootStyle" }],
    },
    {
      code: `doc.documentElement.style.removeProperty("--x");`,
      errors: [{ messageId: "rootStyle" }],
    },
    {
      code: `const style = document.documentElement.style; style.color = "red";`,
      errors: [{ messageId: "rootStyle" }],
    },
    {
      code: `const root = document.documentElement; function f() { root.style.cssText = ""; }`,
      errors: [{ messageId: "rootStyle" }],
    },
  ],
});
