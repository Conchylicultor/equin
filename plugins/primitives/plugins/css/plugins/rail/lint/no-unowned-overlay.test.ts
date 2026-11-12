/** Tests for `rail/no-unowned-overlay`. Run with `./equin test`. */
import { createRuleTester } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import rule from "./no-unowned-overlay";

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-unowned-overlay", rule, {
  valid: [
    { code: `const el = <PopoverContent padding="xs">{x}</PopoverContent>;` },
    { code: `const el = <InlinePopover trigger={t}>{x}</InlinePopover>;` },
    // Not an overlay host: a `padding` prop elsewhere means something else.
    { code: `const el = <Card padding="none">{x}</Card>;` },
    // A variable is out of scope (literal only, like the sibling rules).
    { code: `const el = <PopoverContent padding={pad}>{x}</PopoverContent>;` },
  ],
  invalid: [
    {
      code: `const el = <InlinePopover trigger={t} padding="none">{x}</InlinePopover>;`,
      errors: [{ messageId: "unowned" }],
    },
    {
      code: `const el = <PopoverContent padding={"none"}>{x}</PopoverContent>;`,
      errors: [{ messageId: "unowned" }],
    },
    {
      code: `const el = <DropdownMenuSubContent padding="none">{x}</DropdownMenuSubContent>;`,
      errors: [{ messageId: "unowned" }],
    },
  ],
});
