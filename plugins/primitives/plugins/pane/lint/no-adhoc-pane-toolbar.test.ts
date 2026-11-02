/**
 * Tests for the `no-adhoc-pane-toolbar` lint rule. Run with `bun test`.
 *
 * The rule flags a class-name carrying BOTH `border-b` and `pr-floating-bar` —
 * the fingerprint of a hand-rolled toolbar bar. Either token alone is fine
 * (plenty of legit bordered rows; `pr-floating-bar` also appears on non-bordered
 * action strips), and the signature is only inspected in a class-name context.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-pane-toolbar";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-pane-toolbar", rule, {
  valid: [
    // Only one of the two signature tokens — not a toolbar bar.
    {
      code: `const el = <div className="flex items-center border-b py-md" />;`,
    },
    {
      code: `const el = <div className="flex items-center pr-floating-bar py-lg" />;`,
    },
    // A render-slot host with neither token (the shape we want people to use).
    { code: `const el = <header className="flex items-center gap-sm" />;` },
    // Prose mentioning the classes must not trip the class-name scoping.
    {
      code: `const DOC = "use border-b with pr-floating-bar for a toolbar";`,
    },
  ],
  invalid: [
    // The canonical hand-rolled bar (the Sonata / story-editor shape).
    {
      code: `const el = <div className="flex items-center border-b border-border pl-xl pr-floating-bar py-md" />;`,
      errors: [{ messageId: "adhocToolbarBar" }],
    },
    // Same signature assembled through a cn(...) class-builder.
    {
      code: `const el = <header className={cn("border-b pr-floating-bar h-chrome-bar", className)} />;`,
      errors: [{ messageId: "adhocToolbarBar" }],
    },
    // Tokens split across a ternary inside cn(...) — the structural walk still finds both.
    {
      code: `const cls = cn("border-b", active ? "pr-floating-bar" : "px-lg");`,
      errors: [{ messageId: "adhocToolbarBar" }],
    },
  ],
});
