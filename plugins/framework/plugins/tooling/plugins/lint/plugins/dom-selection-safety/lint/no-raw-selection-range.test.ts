/**
 * Tests for the `no-raw-selection-range` lint rule. Run with `bun test`.
 *
 * The rule bans `<x>.getRangeAt(...)` outside the dom-selection primitive —
 * the one selection read carrying a three-part guard. Everything else about a
 * selection stays valid: reading it (`.toString()`, `.anchorNode`), writing it
 * (`.removeAllRanges()`, `.addRange(...)`), and constructing your own Range
 * (`document.createRange()`) all need no guard, so none of them is flagged.
 */

import rule from "./no-raw-selection-range";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-raw-selection-range", rule, {
  valid: [
    // Bare `getSelection()` is untouched — reading the selection's text needs
    // no guard.
    { code: `const text = window.getSelection()?.toString() ?? "";` },
    // Selection WRITES are untouched.
    { code: `sel.removeAllRanges();` },
    // `addRange` is the write `diff-view` legitimately performs after
    // rebuilding a range for the copy handler.
    { code: `sel.addRange(range);` },
    // Constructing your own Range is a different operation entirely — this is
    // exactly what `caret-geometry`'s `nodeLineRect` does.
    { code: `const range = document.createRange();` },
    // The other collapsed-selection reads carry no guard obligation either.
    { code: `if (sel.isCollapsed && sel.anchorNode) return sel.anchorNode;` },
  ],
  invalid: [
    // The plain guarded-read-that-isn't.
    {
      code: `const range = sel.getRangeAt(0);`,
      errors: [{ messageId: "rawSelectionRange" }],
    },
    // The chained one-liner: no null check, no `rangeCount` check, and the
    // throw is uncaught.
    {
      code: `const rect = window.getSelection().getRangeAt(0).getBoundingClientRect();`,
      errors: [{ messageId: "rawSelectionRange" }],
    },
  ],
});
