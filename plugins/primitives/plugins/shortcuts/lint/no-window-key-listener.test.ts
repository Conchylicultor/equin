/**
 * Tests for the `no-window-key-listener` lint rule.
 *
 * The rule bans keydown / keyup / keypress listeners on a page-wide target
 * (window, document, globalThis, self, document.body, document.documentElement)
 * outside the shortcut registry. Element-scoped listeners and non-key events on
 * the window stay valid.
 */

import rule from "./no-window-key-listener";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester();

ruleTester.run("no-window-key-listener", rule, {
  valid: [
    // An element hears only keys aimed at itself.
    { code: `el.addEventListener("keydown", onKey);` },
    { code: `ref.current.addEventListener("keydown", onKey, true);` },
    // A non-key event on the window is out of scope.
    { code: `window.addEventListener("resize", onResize);` },
    { code: `window.addEventListener("blur", onBlur);` },
    // Removing is not installing.
    { code: `window.removeEventListener("keydown", onKey);` },
    // A computed event name can't be read statically.
    { code: `window.addEventListener(eventName, onKey);` },
    // A property that merely shares a global's name is not that global.
    { code: `panel.document.addEventListener("keydown", onKey);` },
    { code: `frame.body.addEventListener("keydown", onKey);` },
  ],
  invalid: [
    {
      code: `window.addEventListener("keydown", onKey);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: `document.addEventListener("keydown", onKey, true);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: `window.addEventListener("keyup", onKeyUp);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: `globalThis.addEventListener("keypress", onKey);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: `self.addEventListener("keydown", onKey);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: `document.body.addEventListener("keydown", onKey);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: `window.document.documentElement.addEventListener("keydown", onKey);`,
      errors: [{ messageId: "windowKeyListener" }],
    },
    {
      code: "window.addEventListener(`keydown`, onKey, { capture: true });",
      errors: [{ messageId: "windowKeyListener" }],
    },
  ],
});
