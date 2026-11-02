/**
 * Tests for the `no-native-dialog` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule fires on the ambient native modals `confirm`/`alert`/`prompt` — a bare
 * call whose callee resolves to NO binding, plus the member forms
 * `window.confirm`/`globalThis.alert`/`self.prompt`. Detection is SCOPE-precise
 * (never name-based) and deliberately favors false negatives: any local /
 * imported / parameter binding of the same name, a non-global object receiver, a
 * `document.foo.confirm()` chain, and a computed `window["confirm"]` are all left
 * alone.
 */

import rule from "./no-native-dialog";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-native-dialog", rule, {
  valid: [
    // An imported `prompt` — a real binding, not the ambient global.
    `import { prompt } from "./x"; prompt();`,
    // A destructured parameter named `prompt`.
    `function f({ prompt }: { prompt: string }) { return prompt.trim(); }`,
    // A const `prompt` used as a value.
    `const prompt = "hi"; prompt;`,
    // A local function `confirm` shadows the global.
    `function confirm(){} confirm();`,
    // A nested-scope local shadow of `confirm`.
    `function outer() { const confirm = () => true; return confirm(); }`,
    // `dialog.confirm()` — object is not a global name.
    `const dialog = { confirm() {} }; dialog.confirm();`,
    // `service.alert(...)` — object not in {window, globalThis, self}.
    `service.alert("x");`,
    // `document.foo.confirm()` — object is a MemberExpression, not a bare global.
    `document.foo.confirm();`,
    // Computed member access is not matched.
    `window["confirm"]("x");`,
    // The sanctioned replacement — never flagged.
    `confirmDialog({ title: "x", confirmLabel: "Go", onConfirm: () => {} });`,
  ],
  invalid: [
    // Bare `confirm` used as a guard.
    {
      code: `if (confirm("sure?")) doIt();`,
      errors: [{ messageId: "nativeDialog" }],
    },
    // Bare `alert`.
    {
      code: `alert("hi");`,
      errors: [{ messageId: "nativeDialog" }],
    },
    // Bare `prompt` — the ambient global, no binding in scope.
    {
      code: `const name = prompt("name?");`,
      errors: [{ messageId: "nativeDialog" }],
    },
    // `window.confirm`.
    {
      code: `window.confirm("x");`,
      errors: [{ messageId: "nativeDialog" }],
    },
    // `globalThis.alert`.
    {
      code: `globalThis.alert("x");`,
      errors: [{ messageId: "nativeDialog" }],
    },
    // `self.prompt`.
    {
      code: `self.prompt("x");`,
      errors: [{ messageId: "nativeDialog" }],
    },
    // Bare `confirm` inside a function body — still the ambient global.
    {
      code: `function onDelete() { if (!confirm("Delete?")) return; }`,
      errors: [{ messageId: "nativeDialog" }],
    },
  ],
});
