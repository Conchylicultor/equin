/**
 * Tests for the `no-dead-spacing` lint rule: a word-valued spacing class must be
 * a declared app.css `@utility` (from the generated SPACING_UTILITIES) or a
 * Tailwind built-in word — anything else compiles to nothing.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-dead-spacing";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-dead-spacing", rule, {
  valid: [
    // Ramp steps on every declared family, digit-led steps included.
    { code: `const el = <div className="gap-2xs p-2xl gap-x-sm py-xs" />;` },
    { code: `const el = <div className="hover:pt-2xs md:gap-y-lg" />;` },
    // Declared role utilities off the ramp.
    {
      code: `const el = <div className="p-chip gap-sidebar-icon px-control-sm" />;`,
    },
    // Tailwind built-in words.
    {
      code: `const el = <div className="mx-auto ml-auto my-auto p-px gap-px" />;`,
    },
    { code: `const el = <div className="space-x-reverse" />;` },
    // Numeric / arbitrary values are no-adhoc-spacing's, not this rule's.
    { code: `const el = <div className="mt-4 gap-[7px] p-0.5" />;` },
    // Lookalikes that are not spacing families.
    {
      code: `const el = <div className="max-w-xs pointer-events-none mix-blend-multiply" />;`,
    },
    // Not a class-name context.
    { code: `const DOC = "mb-xs is dead";` },
  ],
  invalid: [
    // The reported bug: ramp steps on margin families.
    {
      code: `const el = <div className="mb-xs" />;`,
      errors: [{ messageId: "deadMargin" }],
    },
    {
      code: `const el = <div className="mx-2xl" />;`,
      errors: [{ messageId: "deadMargin" }],
    },
    {
      code: `const el = <span className="[&>svg]:mr-xs" />;`,
      errors: [{ messageId: "deadMargin" }],
    },
    {
      code: `const el = <div className="-mb-sm" />;`,
      errors: [{ messageId: "deadMargin" }],
    },
    {
      code: `const el = <div className="space-y-md" />;`,
      errors: [{ messageId: "deadMargin" }],
    },
    // Typos and undeclared role names on gap / padding.
    {
      code: `const el = <div className="p-mdd" />;`,
      errors: [{ messageId: "deadSpacing" }],
    },
    {
      code: `const cls = cn("gap-card", "p-sm");`,
      errors: [{ messageId: "deadSpacing" }],
    },
    {
      code: `const el = <div className="ps-xs" />;`,
      errors: [{ messageId: "deadSpacing" }],
    },
  ],
});
