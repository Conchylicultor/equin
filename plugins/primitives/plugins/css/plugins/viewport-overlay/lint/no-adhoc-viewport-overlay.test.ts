/**
 * Tests for the `no-adhoc-viewport-overlay` lint rule. Run with `bun test` from
 * the repo root (or this file's directory).
 *
 * The rule fingerprints the viewport-fill recipe (`fixed` + `inset-0`) and
 * redirects it to `<ViewportOverlay>`. The gate is the recipe, not the host tag:
 * it fires on ANY element and in any `cn`/`clsx`/`twMerge` call, and only when
 * BOTH `fixed` and `inset-0` are present (pane-relative `absolute inset-0` and
 * partial `fixed` positioning are left alone). What stays invisible is a class
 * string the literal-only walk cannot read — a module const or a helper's return
 * value — which is the escape valve the primitive itself uses.
 */

// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import {
  createRuleTester,
  lintToolkit,
} from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-viewport-overlay";

const rule = buildRule(lintToolkit);

const ruleTester = createRuleTester({ jsx: true });

ruleTester.run("no-adhoc-viewport-overlay", rule, {
  valid: [
    // Routed through the primitive, which bakes the recipe in itself.
    `const a = <ViewportOverlay layer="popover" className="bg-black/30" />;`,
    // Pane-relative overlay: absolute, not fixed — the sanctioned alternative.
    `const a = <div className="absolute inset-0 z-overlay bg-background" />;`,
    // Positioned chrome that is not a full viewport fill (no inset-0).
    `const a = <div className="fixed top-2 right-3 z-popover" />;`,
    // inset-0 without fixed (e.g. an absolute fill) is fine.
    `const a = <div className="inset-0 absolute" />;`,
    // The recipe read off a member expression / helper — opaque to the walk.
    `const a = <div className={OVERLAY_ROOT} />;`,
  ],
  invalid: [
    // The bare viewport-fill recipe.
    {
      code: `const a = <div className="fixed inset-0 z-popover bg-black/30" />;`,
      errors: [{ messageId: "adhocViewportOverlay" }],
    },
    // Across split cn() fragments. Reported twice — once for the attribute,
    // once for the `cn()` call, which is its own anchor now (same double
    // report the sibling no-adhoc-layout / no-adhoc-spacing rules produce).
    {
      code: `const a = <div className={cn("fixed", "inset-0", "z-max")} />;`,
      errors: [
        { messageId: "adhocViewportOverlay" },
        { messageId: "adhocViewportOverlay" },
      ],
    },
    // A class string built OUTSIDE any JSX attribute: the `cn()` call is the
    // anchor, and the element it is spread onto is a few lines away.
    {
      code: `const c = cn("fixed", "inset-0", "z-overlay");`,
      errors: [{ messageId: "adhocViewportOverlay" }],
    },
    // Variant-prefixed tokens still resolve to the base class.
    {
      code: `const a = <div className="md:fixed md:inset-0" />;`,
      errors: [{ messageId: "adhocViewportOverlay" }],
    },
    // Other intrinsic host tags are covered too.
    {
      code: `const a = <button className="fixed inset-0" />;`,
      errors: [{ messageId: "adhocViewportOverlay" }],
    },
    // A sectioning tag — the exact shape the former span/div/button/a
    // allowlist failed open on.
    {
      code: `const a = <section className="fixed inset-0" />;`,
      errors: [{ messageId: "adhocViewportOverlay" }],
    },
    // Forwarded through a `*ClassName` pass-through prop: the string still
    // lands on a real element, so the spelling of the attribute is irrelevant.
    {
      code: `const a = <Panel panelClassName="fixed inset-0" />;`,
      errors: [{ messageId: "adhocViewportOverlay" }],
    },
  ],
});
