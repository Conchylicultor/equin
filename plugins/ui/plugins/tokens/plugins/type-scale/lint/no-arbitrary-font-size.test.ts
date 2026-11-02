/**
 * Tests for the `no-arbitrary-font-size` lint rule. Run with `bun test` from the
 * repo root (or this file's directory).
 *
 * The rule bans arbitrary `text-[Npx]` / `text-[Nrem]` font-size classes — but
 * only inside a *class-name context* (a `className`/`class` JSX attribute value
 * or a `cn(...)`/`clsx(...)` class-builder argument). A plain string that merely
 * *mentions* such a class (a doc string, comment-as-string, or fixture) must NOT
 * trip the rule. These cases lock both halves in.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-arbitrary-font-size";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-arbitrary-font-size", rule, {
  valid: [
    // A non-className string that merely mentions the banned class — the
    // false-positive case the scoping fix exists to prevent.
    { code: `const DOC = "text-[10px] is banned — use text-3xs";` },
    // Documentation / comment-as-string, likewise untouched.
    { code: `const HINT = \`Avoid text-[12px] in favor of text-xs\`;` },
    // A non-class-builder call with the same string is also ignored.
    { code: `logMessage("text-[11px] appeared");` },
    // Named scale classes in a real className are fine.
    { code: `const el = <div className="text-xs font-medium" />;` },
    // className inside cn(...) with only named classes is fine.
    { code: `const el = <span className={cn("text-2xs", "px-2")} />;` },
  ],
  invalid: [
    // Bare className string literal. 12px is a ROLE size (caption, control,
    // …), a semantic choice — reported, never auto-fixed (the old fix wrote
    // `text-xs`, itself banned by no-adhoc-typography).
    {
      code: `const el = <div className="text-[12px]" />;`,
      output: null,
      errors: [{ messageId: "arbitraryFontSize" }],
    },
    // cn(...) class-builder call argument — even outside JSX. Same for the
    // 0.75rem spelling of 12px.
    {
      code: `const cls = cn("text-[0.75rem]", "px-2");`,
      output: null,
      errors: [{ messageId: "arbitraryFontSize" }],
    },
    // A sub-scale size still auto-fixes, including inside a cva table.
    {
      code: `const v = cva("flex", { variants: { size: { sm: "text-[11px]" } } });`,
      output: `const v = cva("flex", { variants: { size: { sm: "text-2xs" } } });`,
      errors: [{ messageId: "arbitraryFontSize" }],
    },
    // className={`…`} template-literal form.
    {
      code: `const el = <div className={\`flex text-[10px]\`} />;`,
      output: `const el = <div className={\`flex text-3xs\`} />;`,
      errors: [{ messageId: "arbitraryFontSize" }],
    },
  ],
});
