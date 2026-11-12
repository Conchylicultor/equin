/** Tests for `rail/no-pad-under-owner`. Run with `./equin test`. */
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-pad-under-owner";

const rule = buildRule(lintToolkit);
const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-pad-under-owner", rule, {
  valid: [
    // A column that owns no inset: its regions pad themselves.
    { code: `const el = <Column header={<div className="p-sm" />} />;` },
    // Under an owner, content declaring nothing.
    { code: `const el = <Column inset="sm" body={<Stack gap="sm" />} />;` },
    // Removing padding is not paying an inset.
    {
      code: `const el = <Column inset="sm" body={<div className="px-0" />} />;`,
    },
    // Block rhythm is not an inline inset.
    {
      code: `const el = <Column inset="sm" header={<div className="pt-sm" />} />;`,
    },
    // A `none` panel is no owner (no-unowned-overlay's business).
    {
      code: `const el = <PopoverContent padding="none"><div className="p-sm" /></PopoverContent>;`,
    },
    // Only the ROOT of the content: a nested element's padding is its own.
    {
      code: `const el = <PopoverContent><Stack><Row className="px-sm" /></Stack></PopoverContent>;`,
    },
  ],
  invalid: [
    // Logical-side padding pays it too.
    {
      code: `const el = <Column inset="sm" footer={<div className="ps-md" />} />;`,
      errors: [{ messageId: "padUnderOwner" }],
    },
    {
      code: `const el = <Column inset="sm" header={<Stack className="p-sm" />} />;`,
      errors: [{ messageId: "padUnderOwner" }],
    },
    {
      code: `const el = <PopoverContent padding="xs"><Stack className="px-md" /></PopoverContent>;`,
      errors: [{ messageId: "padUnderOwner" }],
    },
    // The panel's default padding is an owner too, and a fragment's roots count.
    {
      code: `const el = <InlinePopover trigger={t}><><div className="pl-md" /></></InlinePopover>;`,
      errors: [{ messageId: "padUnderOwner" }],
    },
    {
      code: `const el = <PopoverContent header={<Line className="px-md" />}>{x}</PopoverContent>;`,
      errors: [{ messageId: "padUnderOwner" }],
    },
  ],
});
