/**
 * Tests for the `no-adhoc-layout` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule bans raw Tailwind layout-composition utilities — flow (`flex`,
 * `grid`, `flex-1`, `basis-*`), space-sharing (`shrink-*`, `grow-*`, `min-w-0`),
 * alignment (`items-*`, `justify-*`, `place-*`, `self-*`), positioning
 * (`absolute`, `fixed`, `sticky`, `inset-*`), and clipping (`overflow-*`) —
 * redirecting them to the layout primitives. The tricky valid cases this file
 * locks in: positioning *context* (`relative`/`static`) and sizing (`w-*`,
 * `min-w-fit`) are NOT layout mechanics and must pass; `placeholder-*` must not
 * trip the `place-*` matcher; `inset-ring-*` must not trip the `inset-*` matcher.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-layout";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-layout", rule, {
  valid: [
    // Positioning CONTEXT is benign — only the children-positioning keywords
    // (absolute/fixed/sticky) and the offsets (inset-*) are banned.
    { code: `const el = <div className="relative" />;` },
    { code: `const el = <div className="static" />;` },
    // Sizing is not a layout mechanic — only the `min-w-0` footgun is banned.
    {
      code: `const el = <div className="w-full h-screen size-4 min-w-fit max-w-prose" />;`,
    },
    // Non-flow display values are untouched.
    { code: `const el = <div className="block hidden inline" />;` },
    // `placeholder-*` must not be caught by the `place-*` alignment matcher.
    { code: `const el = <input className="placeholder-muted" />;` },
    // `inset-ring-*` is a box-shadow utility, not positioning.
    { code: `const el = <div className="inset-ring-2" />;` },
    // Spacing / z-index belong to sibling rules, not this one.
    { code: `const el = <div className="gap-sm p-md z-base" />;` },
    // A non-className string that merely mentions a banned class — the
    // class-name-context scoping must not trip on it.
    { code: `const DOC = "flex is banned — use <Stack>";` },
    // Inline `style` position: context keywords stay benign (mirrors the
    // className path — only absolute/fixed/sticky are banned).
    { code: `const el = <div style={{ position: "relative" }} />;` },
    { code: `const el = <div style={{ position: "static" }} />;` },
    // A dynamic (non-literal) position value can't be statically resolved.
    { code: `const el = <div style={{ position: pos }} />;` },
    // No `position` key at all — bare offsets are not flagged.
    { code: `const el = <div style={{ top: 0, left: 0 }} />;` },
    // Sanity: the className path still behaves alongside the style path.
    { code: `const el = <div className="block" />;` },
  ],
  invalid: [
    // ── Alias reach. This rule carried an older, weaker copy of the shared
    // class-token walk that resolved no identifiers, so BOTH shapes below were
    // invisible to it while its six siblings caught the first one. It now takes
    // the one injected walk, so neither hides a layout class any more.
    //
    // A string const hoisted out of the JSX. Not hypothetical: a page-editor
    // site hoisted `absolute` into a const to get out of this rule's reach and
    // documented that as the reason.
    {
      code: `
          const ANCHOR = "block-anchor absolute";
          const el = <div className={ANCHOR} />;
        `,
        errors: [{ messageId: "adhocLayout" }],
      },
      // A style MAP indexed in a class context — how the surface host parks its
      // frame recipe. Visited twice (JSXAttribute + CallExpression), and `pane`
      // contributes two banned tokens, so 3 tokens x 2 visits = 6.
      {
        code: `
          const FRAME = { pane: "absolute inset-0", win: "overflow-hidden" };
          function C({ f }: { f: keyof typeof FRAME }) {
            return <div className={cn(FRAME[f])} />;
          }
        `,
        errors: [
          { messageId: "adhocLayout" },
          { messageId: "adhocLayout" },
          { messageId: "adhocLayout" },
          { messageId: "adhocLayout" },
          { messageId: "adhocLayout" },
          { messageId: "adhocLayout" },
        ],
      },
      // Flow / display.
      {
        code: `const el = <div className="flex" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="flex flex-col" />;`,
        errors: [{ messageId: "adhocLayout" }, { messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="flex-1" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="grid" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="grid-cols-3" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="col-span-2" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="basis-1/2" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      // Space-sharing.
      {
        code: `const el = <div className="shrink-0" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="grow" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="min-w-0" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      // Alignment / distribution.
      {
        code: `const el = <div className="items-center" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="justify-between" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="place-items-center" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="self-end" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      // Positioning.
      {
        code: `const el = <div className="absolute" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="fixed" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="inset-0" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      {
        code: `const el = <div className="-inset-x-2" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      // Clipping.
      {
        code: `const el = <div className="overflow-hidden" />;`,
        errors: [{ messageId: "adhocLayout" }],
      },
      // Variant-prefixed still resolves to the base utility.
      {
        code: `const el = <div className="md:flex hover:absolute" />;`,
        errors: [{ messageId: "adhocLayout" }, { messageId: "adhocLayout" }],
      },
      // Inside a cn(...) class-builder argument.
      {
        code: `const cls = cn("flex", "items-center");`,
        errors: [{ messageId: "adhocLayout" }, { messageId: "adhocLayout" }],
      },
      // Inline `style` position literals — the unguarded path the menu-shift bug
      // shipped on. Scoped to the `position` property only.
      {
        code: `const el = <div style={{ position: "fixed" }} />;`,
        errors: [{ messageId: "adhocStylePosition" }],
      },
      {
        code: `const el = <div style={{ position: "absolute" }} />;`,
        errors: [{ messageId: "adhocStylePosition" }],
      },
      {
        code: `const el = <div style={{ position: "sticky" }} />;`,
        errors: [{ messageId: "adhocStylePosition" }],
      },
      // Other style props alongside `position` don't add extra errors — only
      // the `position` value is flagged.
      {
        code: `const el = <div style={{ position: "fixed", top: 0 }} />;`,
        errors: [{ messageId: "adhocStylePosition" }],
      },
    ],
  },
);
