/**
 * Tests for the `no-adhoc-spacing` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule bans RAW Tailwind spacing (numeric `gap-2`/`px-3`/`mt-4`/`space-y-2`
 * or arbitrary `gap-[7px]`) but ALLOWS the named density ramp
 * (`none|2xs|xs|xsm|sm|smd|md|lg|xl|2xl`) used through the `gap-<step>`/`p-<step>`
 * utilities. The two steps that begin with a digit — `2xs` and `2xl` — are the
 * regression this file locks in: a naive "starts with a digit" detector flags
 * `gap-2xs`/`p-2xl` even though they are legitimate named steps. The valid cases
 * below assert they pass; the invalid cases assert genuine raw spacing still fails.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-spacing";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-spacing", rule, {
  valid: [
    // The regression: the two digit-led named steps must be allowed across
    // gap / padding (every axis). (Whether a word-valued class EXISTS — e.g.
    // `mx-2xl`, which does not — is space-ramp/no-dead-spacing's call.)
    { code: `const el = <div className="gap-2xs" />;` },
    { code: `const el = <div className="gap-2xl" />;` },
    { code: `const el = <div className="py-2xs p-2xl" />;` },
    { code: `const el = <span className={cn("gap-2xs", "p-2xl")} />;` },
    // The letter-led named steps are likewise fine.
    { code: `const el = <div className="gap-sm p-md pt-lg" />;` },
    // Centering utilities are word-valued and untouched.
    { code: `const el = <div className="mx-auto my-auto" />;` },
    // A non-className string that merely mentions a banned class — the
    // class-name-context scoping must not trip on it.
    { code: `const DOC = "gap-2 is banned — use gap-sm";` },
  ],
  invalid: [
    // Numeric raw spacing across each family.
    {
      code: `const el = <div className="gap-2" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    {
      code: `const el = <div className="px-3" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    {
      code: `const el = <div className="mt-4" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    {
      code: `const el = <div className="space-y-2" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    // Fractional step — still raw.
    {
      code: `const el = <div className="gap-0.5" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    // Arbitrary value.
    {
      code: `const el = <div className="p-[5px]" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    // Tailwind v4's arbitrary custom-property shorthand.
    {
      code: `const el = <div className="mb-(--space-xs)" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    // Negative arbitrary margin — `baseClass` strips the leading `-`.
    {
      code: `const el = <div className="-mx-[7px]" />;`,
      errors: [{ messageId: "adhocSpacing" }],
    },
    // Raw spacing inside a cn(...) class-builder argument.
    {
      code: `const cls = cn("gap-2", "p-2xl");`,
      errors: [{ messageId: "adhocSpacing" }],
    },
  ],
});
