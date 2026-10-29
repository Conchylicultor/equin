import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A hand-rolled `fixed inset-0` div means "fill the viewport" — but several app
 * surfaces deliberately put `transform-gpu` (or another transform / filter /
 * will-change) on a container to scope `position: fixed` app chrome. Any
 * `fixed inset-0` descendant of such a container is then bounded by it and
 * SILENTLY clipped to the content area (below the tab bar, right of the rail),
 * with no error — it only shows up as a wrong-looking screenshot. The ancestor
 * relationship is a runtime DOM fact that crosses plugin boundaries, so it can't
 * be checked statically; instead we fingerprint the viewport-fill recipe and
 * redirect it to the `<ViewportOverlay>` primitive, which self-portals to
 * `document.body` and is therefore correct regardless of any transformed
 * ancestor.
 *
 * Fingerprint: the co-occurrence of `fixed` + `inset-0`, aggregated across one
 * class-name attribute (the tokens may live in different `cn()` fragments) or
 * one `cn`/`clsx`/`twMerge` call. Both anchors matter — the recipe is just as
 * wrong when it is built into a `const c = cn("fixed", "inset-0")` and spread
 * onto an element a few lines later.
 *
 * The gate is the *recipe*, not the host tag. The literal recipe is illegal on
 * ANY host element — an intrinsic (`<div>`/`<section>`/`<main>`/`<nav>`/…), a
 * capitalized layout component, or a member-expression tag (`<Foo.Bar>`). The
 * former `HOST_TAGS` gate was `span`/`div`/`button`/`a`, so `<section className=
 * "fixed inset-0">` sailed past it — a tag-allowlist fails open, and its sibling
 * `no-adhoc-surface` already deleted its identical gate for that reason.
 *
 * Two legitimate homes for the recipe survive that, both by construction rather
 * than by an allowlist of tags:
 *
 *   1. The primitive itself keeps the recipe in a module const, so it is opaque
 *      to the literal-only token walk below.
 *   2. The base-ui `*.Popup` / `*.Backdrop` tags in the shadcn dialog/sheet DO
 *      fill the real viewport correctly — base-ui portals them — but they spell
 *      the recipe as literals, so they are exempted by a file-glob in
 *      `lint/index.ts`, exactly as `no-adhoc-surface` exempts the same files.
 *
 * No auto-fix: deciding viewport (`<ViewportOverlay>`) vs. pane-relative
 * (`absolute inset-0`) is a per-site judgement (same stance as
 * `no-adhoc-surface` / `no-adhoc-zindex`).
 */

export default function buildRule({
  collectTokens,
  ownClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-viewport-overlay",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow ad-hoc viewport overlays (fixed + inset-0 on any host element, or in a cn()/clsx() call) — route through the <ViewportOverlay> primitive, which self-portals to document.body so it fills the real viewport regardless of any transformed ancestor.",
      },
      schema: [],
      messages: {
        adhocViewportOverlay:
          "Ad-hoc viewport overlay (`fixed` + `inset-0`). " +
          "A transformed ancestor (`transform-gpu`, filter, will-change) becomes the " +
          "containing block and SILENTLY clips this to the content area. Route through " +
          "`<ViewportOverlay>` from `@plugins/primitives/plugins/css/plugins/viewport-overlay/web`, " +
          "which self-portals to `document.body` so it fills the real viewport. If you " +
          "meant a pane-relative overlay, use `absolute inset-0`; if intentionally " +
          "bespoke, `// eslint-disable-next-line viewport-overlay/no-adhoc-viewport-overlay -- <reason>`.",
      },
    },
    defaultOptions: [],
    create(context) {
      /** Report `node` when the collected tokens spell the viewport-fill recipe. */
      function checkTokens(node: TSESTree.Node, raw: Set<string>): void {
        const tokens = new Set([...raw].flatMap((t) => ownClass(t) ?? []));
        if (tokens.has("fixed") && tokens.has("inset-0")) {
          context.report({ node, messageId: "adhocViewportOverlay" });
        }
      }

      return {
        JSXAttribute(node) {
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;

          // No host-tag gate: the recipe is the violation on ANY host element.
          // The sanctioned homes are invisible here for structural reasons, not
          // because of an allowlist — the primitive keeps the recipe in a module
          // const the literal-only walk never harvests, and the base-ui portaled
          // surfaces are exempted by a file-glob in lint/index.ts.
          const raw = new Set<string>();
          collectTokens(context.sourceCode, node.value, raw);
          checkTokens(node, raw);
        },
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !CLASS_BUILDERS.has(node.callee.name)
          )
            return;

          // A class string assembled outside a JSX attribute (`const c = cn("fixed",
          // "inset-0")`) lands on a real element all the same, so the builder call
          // is its own anchor — mirroring no-adhoc-layout / no-adhoc-spacing.
          const raw = new Set<string>();
          for (const arg of node.arguments)
            collectTokens(context.sourceCode, arg, raw);
          checkTokens(node, raw);
        },
      };
    },
  });
}
