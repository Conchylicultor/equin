import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A theme boundary is THREE coordinated things, and both of the ones that are
 * hand-writable are banned here.
 *
 *  1. `data-theme-scope` on an element — the selector `theme-engine`'s emitted
 *     CSS blocks target, which re-themes the whole subtree;
 *  2. a `PortalThemeScopeProvider` carrying the same token, so content that
 *     portals OUT of the subtree re-stamps the attribute and keeps its theme;
 *  3. a painted canvas — custom properties cascade DOWN, paint does not travel
 *     UP, so a boundary that paints nothing lets an ancestor's fill show
 *     through, in the ancestor's theme.
 *
 * Written by hand, they disagree. Every site in the repo assembled a different
 * subset: `PaneBox` had (1) and (2) and no paint, so a Pages pane hosted in the
 * agent manager read Pages' `--background` and painted none of it — the user saw
 * the host's canvas. The app rail had (1) and (3) and no portal forward, so a
 * menu opened from it came back wearing the desktop theme. Each gap is silent
 * until a screenshot.
 *
 * `<Theme name surface>` owns all three, and `surface` is REQUIRED — so the
 * half-built boundary has no spelling. This rule closes the two ways back to
 * hand-assembly:
 *
 *   - `adhocThemeScope` — a raw `data-theme-scope` JSX attribute, on ANY host
 *     element. No tag gate on purpose: a tag allowlist fails open (its siblings
 *     `no-adhoc-surface` and `no-adhoc-viewport-overlay` both deleted theirs
 *     after a `<section>` / a layout component's `className` sailed past). The
 *     attribute's IDENTITY is the whole fingerprint, structurally the check
 *     `no-orphan-composite-role` makes on `role=`.
 *   - `adhocPortalThemeScope` — importing `PortalThemeScopeProvider`. Keyed on
 *     the imported NAME rather than the module path: exactly one symbol in the
 *     repo carries it (ui-kit's `web/components/portal-theme-scope.tsx`,
 *     re-exported from the ui-kit barrel), so a deep path or a re-export cannot
 *     fail open. Reading the forwarded scope (`usePortalThemeScope`) is a read,
 *     not a boundary declaration, and is left alone.
 *
 * No autofix. Choosing which of the four `surface` roles a site paints is the
 * judgement the primitive exists to force, and it is exactly what cannot be
 * mechanized: the old sites' paint is where the bugs are (two of them were
 * wrong), so copying it forward is not a safe transform.
 *
 * The primitive's own files are exempted by path in `lint/index.ts` — they ARE
 * the implementation of both halves.
 */

const PORTAL_PROVIDER = "PortalThemeScopeProvider";

export default createRule({
  name: "no-adhoc-theme-scope",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-assembling a theme boundary — a raw `data-theme-scope` attribute on any host element, or an import of `PortalThemeScopeProvider` — outside the <Theme> primitive, which owns the attribute, the portal forward, and the painted canvas as one required-complete unit.",
    },
    schema: [],
    messages: {
      adhocThemeScope:
        "Raw `data-theme-scope`. A theme boundary is `<Theme name surface>` from " +
        "`@plugins/primitives/plugins/css/plugins/theme-boundary/web` — the attribute alone " +
        "re-themes the subtree's tokens but PAINTS nothing (so an ancestor's fill shows " +
        "through in the ancestor's theme) and FORWARDS nothing (so a portaled popover comes " +
        "back wearing the host's theme). `<Theme>` owns all three, and its `surface` prop " +
        '("canvas" | "chrome" | "sunken" | "none") is required so the paint cannot be ' +
        "forgotten. If this is genuinely bespoke, " +
        "`// eslint-disable-next-line theme-boundary/no-adhoc-theme-scope -- <reason>`.",
      adhocPortalThemeScope:
        "`PortalThemeScopeProvider` is the portal-forwarding HALF of a theme boundary — on " +
        "its own it keeps portaled content on a theme the surrounding element neither stamps " +
        "nor paints. Render `<Theme name surface>` from " +
        "`@plugins/primitives/plugins/css/plugins/theme-boundary/web` instead; it wraps its " +
        "children in this provider with the same token it stamps on the element it paints. " +
        "If this is genuinely bespoke, " +
        "`// eslint-disable-next-line theme-boundary/no-adhoc-theme-scope -- <reason>`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        // A namespaced JSX name (`xlink:href`) is a JSXNamespacedName, never
        // this attribute — so the identifier check is the whole gate.
        if (
          node.name.type === "JSXIdentifier" &&
          node.name.name === "data-theme-scope"
        ) {
          context.report({ node, messageId: "adhocThemeScope" });
        }
      },

      // `import { PortalThemeScopeProvider } from …` and
      // `import { PortalThemeScopeProvider as P } from …` alike — the IMPORTED
      // name is what identifies the symbol; the local alias is the evasion.
      ImportSpecifier(node: TSESTree.ImportSpecifier) {
        if (
          node.imported.type === "Identifier" &&
          node.imported.name === PORTAL_PROVIDER
        ) {
          context.report({ node, messageId: "adhocPortalThemeScope" });
        }
      },
    };
  },
});
