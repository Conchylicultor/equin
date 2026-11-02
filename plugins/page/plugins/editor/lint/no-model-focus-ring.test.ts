/**
 * Tests for the `no-model-focus-ring` lint rule. Run with `./equin test
 * plugins/page/plugins/editor`.
 *
 * The first invalid case is the acceptance test the rule exists for: the page
 * editor's divider as it stood — the browser's own outline switched off
 * unconditionally, and a ring redrawn only while the EDITOR's `isFocused` said
 * so. The first valid case is the shape that replaces it, and it must pass: the
 * `focus-ring` utility authored unconditionally (the browser decides when it
 * draws), with the model gate left to tint, not to indicate focus.
 */

import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-model-focus-ring";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-model-focus-ring", rule, {
  valid: [
    // The `VoidCaretBox` expression: the focus utility is UNCONDITIONAL (the
    // browser draws it), and the model gate carries a tint, not an indicator.
    `const c = cn("focus-ring cursor-default rounded-md", isFocused && "bg-accent");`,
    // A different concept. "This is the selected row" is not "this has focus",
    // and a ring is a legitimate way to draw it.
    `const c = selected && "ring-2 ring-primary";`,
    // Gated on the model, but not a focus treatment.
    `const c = isFocused && "bg-muted";`,
    // Unconditional focus utility — exactly what the rule wants written.
    `const c = "focus-ring";`,
    // A model gate around JSX with no class strings at all.
    `const a = isEmpty && isFocused ? <Pin /> : null;`,
  ],
  invalid: [
    // The historical divider expression: the outline suppressed
    // unconditionally (untouched — it is not under the gate), and the ring
    // redrawn under it. Two focus tokens in the guarded branch, one report each.
    {
      code: `const c = cn("cursor-default outline-none", isFocused && "ring-primary/30 rounded-md ring-1");`,
      errors: [
        { messageId: "modelFocusRing", data: { token: "ring-primary/30" } },
        { messageId: "modelFocusRing", data: { token: "ring-1" } },
      ],
    },
    // Both arms of a ternary render because of the gate, so both are model-driven.
    {
      code: `const c = isFocused ? "ring-2" : "ring-0";`,
      errors: [
        { messageId: "modelFocusRing", data: { token: "ring-2" } },
        { messageId: "modelFocusRing", data: { token: "ring-0" } },
      ],
    },
    // The fact reached through a prop object reads the same.
    {
      code: `const c = props.isFocused && "focus-visible:ring-2";`,
      errors: [
        {
          messageId: "modelFocusRing",
          data: { token: "focus-visible:ring-2" },
        },
      ],
    },
    // Negation counts: suppressing the browser's indicator while the model
    // says "not focused" is the half of the divider bug that hid the ring.
    {
      code: `const c = !isFocused && "outline-none";`,
      errors: [
        { messageId: "modelFocusRing", data: { token: "outline-none" } },
      ],
    },
    // The scan of a guarded branch is recursive, so a nested cn() is seen.
    {
      code: `const c = cn("gap-sm", isFocused && cn("rounded-md", "ring-1"));`,
      errors: [{ messageId: "modelFocusRing", data: { token: "ring-1" } }],
    },
  ],
});
