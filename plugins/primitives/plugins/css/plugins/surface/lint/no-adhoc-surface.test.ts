/**
 * Tests for the `no-adhoc-surface` lint rule. Run with `bun test` from the repo
 * root (or this file's directory).
 *
 * The rule fingerprints two open-coded surface recipes — `raised` (rounded +
 * border + bg-card + padding — the former no-adhoc-card) and `overlay`
 * (bg-popover + shadow + rounded) — and flags the literal recipe on ANY host
 * element (intrinsic, layout component, or member-expression tag). It does NOT
 * lint `base` (bg-background) or `sunken` (bg-muted), which are ambiguous. The
 * sanctioned surfaces flow through, structurally: the `SURFACE_LEVELS` member
 * access is opaque to the literal-only token walk, and the shadcn primitive
 * definition files are exempted by a file-glob in lint/index.ts. Per-site escapes
 * are the `p-card` padding token and `// eslint-disable-next-line`.
 */

import { RuleTester } from "eslint";
import tsParser from "@typescript-eslint/parser";
// The rule is a FACTORY taking the shared class-token walk (rule files cannot
// import it — they dual-load under jiti). Tests run under Bun, where the
// `@plugins/*` alias resolves, so they construct it with the real toolkit.
import { lintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core/testing";
import buildRule from "./no-adhoc-surface";

const rule = buildRule(lintToolkit);

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tsParser,
    parserOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      ecmaFeatures: { jsx: true },
    },
  },
});

// `RuleTester.run` drives the harness itself (calls the ambient describe/it that
// bun:test provides), so it must run at module top level — never inside test().
ruleTester.run(
  "no-adhoc-surface",
  // The eslint flat-config RuleTester is typed against the legacy Rule shape;
  // the typescript-eslint createRule object is compatible at runtime.
  rule as unknown as Parameters<RuleTester["run"]>[1],
  {
    valid: [
      // A primitive with NO recipe tokens (just a padding override) is fine.
      `const a = <Surface level="raised" className="p-3" />;`,
      // Partial overrides on a primitive stay valid — they don't re-spell the
      // full recipe, they tweak one property of the bundle the primitive freezes.
      `const a = <Card className="rounded-lg" />;`,
      `const a = <Surface level="raised" className="bg-muted/30" />;`,
      // Raised escape: the named p-card padding token.
      `const a = <div className="rounded-md border bg-card p-card" />;`,
      // Not a contained surface: bg-card without the full raised fingerprint.
      `const a = <div className="bg-card p-3" />;`,
      // `p-none` (zero padding) is NOT card padding — excluded from the ramp.
      `const a = <div className="rounded-md border bg-card p-none" />;`,
      // The canonical sanctioned surface: the shared bundle is read off a member
      // expression, not a string literal, so the literal-only token walk treats
      // it as opaque. This is the central escape — keep it green.
      `const a = <div className={cn(SURFACE_LEVELS.overlay, "z-popover p-md")} />;`,
      // base / sunken are NOT linted — bg-background / bg-muted are ambiguous.
      `const a = <div className="bg-background rounded-md border p-3 shadow-sm" />;`,
      `const a = <div className="bg-muted rounded-md border p-3" />;`,
      // overlay needs all of bg-popover + shadow + rounded.
      `const a = <div className="bg-popover rounded-md p-xs" />;`,
    ],
    invalid: [
      // raised fingerprint (former no-adhoc-card).
      {
        code: `const a = <div className="rounded-md border bg-card p-3" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised across split cn() fragments.
      {
        code: `const a = <div className={cn("rounded-md border", "bg-card", "p-2")} />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised with named-ramp padding (`p-lg`) — the word-valued spacing utility
      // is real card padding and must complete the fingerprint.
      {
        code: `const a = <div className="rounded-lg border bg-card p-lg" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised on a semantic block container (`<section>`) — the section-as-card
      // escape hatch is now closed.
      {
        code: `const a = <section className="rounded-lg border border-border bg-card p-lg" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised on a non-previously-covered intrinsic (`<nav>`) — the gate is the
      // recipe, not an allowlist of tags.
      {
        code: `const a = <nav className="rounded-md border bg-card p-lg" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised smuggled through a layout component (`<Stack>`) — the whole point
      // of dropping the host-tag gate: a recipe open-coded on a layout box is the
      // drift this rule exists to stop.
      {
        code: `const a = <Stack className="rounded-md border bg-card p-lg" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised spelled out on a primitive's own className — re-writing the full
      // recipe defeats the bundle the primitive freezes, so it's flagged like any
      // other host. (Partial overrides stay valid; see the valid cases above.)
      {
        code: `const a = <Card className="rounded-md border bg-card p-3" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // raised on a member-expression tag — coverage is tag-agnostic.
      {
        code: `const a = <Foo.Bar className="rounded-md border bg-card p-3" />;`,
        errors: [{ messageId: "adhocRaised" }],
      },
      // overlay fingerprint.
      {
        code: `const a = <div className="bg-popover rounded-lg shadow-md p-xs" />;`,
        errors: [{ messageId: "adhocOverlay" }],
      },
      {
        code: `const a = <div className="rounded-xl border bg-popover text-popover-foreground shadow-2xl" />;`,
        errors: [{ messageId: "adhocOverlay" }],
      },
      // overlay recipe re-spelled on a primitive's own className — flagged like
      // any other host (route through <Surface level="overlay"> / PopoverContent
      // and override one property, don't re-write the whole bundle).
      {
        code: `const a = <PopoverContent className="bg-popover rounded-lg shadow-md p-md" />;`,
        errors: [{ messageId: "adhocOverlay" }],
      },
      // hand-rolled glass — an alpha popover fill + a backdrop blur is the
      // overlay material a theme sets (material group), shadow or not.
      {
        code: `const a = <div className="bg-popover/90 backdrop-blur-[30px] backdrop-saturate-[1.8]" />;`,
        errors: [{ messageId: "adhocOverlay" }],
      },
      {
        code: `const a = <div className="rounded-2xl bg-popover-fill shadow-lg" />;`,
        errors: [{ messageId: "adhocOverlay" }],
      },
    ],
  },
);
