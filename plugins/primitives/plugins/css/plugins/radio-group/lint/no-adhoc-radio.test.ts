/**
 * Tests for the `no-adhoc-radio` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule flags an intrinsic `<input>` whose `type` is the literal `"radio"`,
 * steering it to the `RadioGroup` primitive that mints the native `name` per
 * mount. It is syntax-only and deliberately narrow: other input types, computed
 * `type` expressions, component-named `<Input>`, and button-based groups
 * carrying `role="radiogroup"` all flow through.
 */

import rule from "./no-adhoc-radio";
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-radio", rule, {
  valid: [
    // The sanctioned replacement.
    `const a = <RadioGroup options={opts} value={v} onChange={set} />;`,
    // Other input types are untouched — this rule is about the `name`-grouping
    // mechanic, which only radios have.
    `const a = <input type="checkbox" checked={on} />;`,
    `const a = <input type="text" value={v} />;`,
    `const a = <input />;`,
    // A component named Input composes its own control; out of scope.
    `const a = <Input type="radio" />;`,
    // Button-based single-select groups have no native `name` to collide on.
    `const a = <div role="radiogroup"><button role="radio" aria-checked /></div>;`,
    // Computed type is not resolved — syntax-only by design.
    `const a = <input type={kind} />;`,
    // A "radio" string that is not the `type` attribute.
    `const a = <input type="text" name="radio" />;`,
    // Not JSX at all.
    `const a = { type: "radio" };`,
  ],
  invalid: [
    {
      // The reported shape: a module-level literal name shared by every mount.
      code: `const a = <input type="radio" name="enum-field" value={o.value} />;`,
      errors: [{ messageId: "adhocRadio" }],
    },
    {
      // A per-instance name is still banned — the primitive owns the mechanic,
      // and "looks unique here" is exactly the judgement call being removed.
      code: `const a = <input type="radio" name={id} />;`,
      errors: [{ messageId: "adhocRadio" }],
    },
    {
      // No name at all: every such input on the page joins one anonymous group.
      code: `const a = <input type="radio" checked={on} onChange={f} />;`,
      errors: [{ messageId: "adhocRadio" }],
    },
    {
      // Expression-container literal is the same thing written differently.
      code: `const a = <input type={"radio"} />;`,
      errors: [{ messageId: "adhocRadio" }],
    },
  ],
});
