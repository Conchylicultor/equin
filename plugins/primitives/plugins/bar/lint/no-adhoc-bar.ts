import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Chrome-strip guardrail — the bar archetype's `no-adhoc-row` equivalent.
 *
 * A horizontal chrome strip (the app/pane toolbar band, a pane header) is a
 * single-line region with a bottom border at a fixed chrome height. Hand-rolling
 * it (`<div className="flex items-center border-b h-chrome-pane px-chrome">`)
 * re-derives the strip chrome and re-opens the wrap bug instead of composing the
 * one primitive that owns it. The sanctioned home is the `Bar` primitive
 * (`@plugins/primitives/plugins/bar/web`): `tier="chrome"` for app/pane
 * toolbars, `tier="pane"` for pane headers.
 *
 * Detection signature (a co-occurrence that may live across several `cn()`
 * fragments, so we aggregate every class token of one class-name context into a
 * Set first):
 *   - a chrome HEIGHT token (`h-chrome-bar` / `h-chrome-pane`) — worn ONLY by
 *     chrome bars and pane headers, the smoking gun, AND
 *   - `border-b`, AND
 *   - a centered single-line marker (`items-center`, or `region-line` which
 *     bakes it in).
 * A sidebar header also wears a chrome height but lacks BOTH `border-b` and the
 * centered marker (it is `justify-center`, borderless), so it is excluded.
 *
 * Layered with `pane/no-adhoc-pane-toolbar`: that rule additionally requires a
 * *toolbar* (vs a plain Bar) to route through a render-slot host — the pane's
 * own header slot (`pane.Actions`) or `AppShellLayout`'s `toolbarSlot` — so its
 * items are contributions. This rule is the lower, structural layer: use `Bar` for any
 * chrome strip. The sanctioned `Bar` definition keeps its tier classes behind a
 * const map (not literal class-name tokens), so it never self-trips; it is also
 * path-exempted in the lint barrel for good measure.
 */

/** The chrome HEIGHT tokens — worn only by chrome bars / pane headers. */
const CHROME_HEIGHT = new Set(["h-chrome-bar", "h-chrome-pane"]);
const BORDER_BOTTOM = "border-b";
/** Centered single-line markers: raw `items-center` or the `region-line` utility that bakes it in. */
const CENTER = new Set(["items-center", "region-line"]);

export default function buildRule({
  collectTokens,
  ownClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  /**
   * True when `node` sits inside a `className`/`class` JSX attribute. A
   * `className={cn(...)}` is walked by BOTH visitors, so the `CallExpression`
   * handler skips these to avoid double-reporting; a standalone `const c = cn(...)`
   * has no such ancestor and is still checked.
   */
  function inClassAttribute(node: TSESTree.Node): boolean {
    for (let cur = node.parent; cur; cur = cur.parent) {
      if (
        cur.type === "JSXAttribute" &&
        cur.name.type === "JSXIdentifier" &&
        CLASS_ATTRS.test(cur.name.name)
      ) {
        return true;
      }
    }
    return false;
  }

  return createRule({
    name: "no-adhoc-bar",
    meta: {
      type: "problem",
      docs: {
        description:
          'Disallow hand-rolled chrome bars (a chrome-height + border-b + centered strip). Route through the Bar primitive (tier="chrome" for app/pane toolbars, tier="pane" for pane headers).',
      },
      schema: [],
      messages: {
        adhocBar:
          "Hand-rolled chrome bar (chrome height + `border-b` + centered) — route through the `Bar` " +
          'primitive from @plugins/primitives/plugins/bar/web: `tier="chrome"` for an app/pane ' +
          'toolbar band, `tier="pane"` for a pane header. A toolbar additionally routes through ' +
          "the pane's own header slot (`pane.Actions`) / `AppShellLayout`'s `toolbarSlot` so its " +
          "items are contributions. " +
          "If genuinely bespoke, `// eslint-disable-next-line bar/no-adhoc-bar -- <reason>`.",
      },
    },
    defaultOptions: [],
    create(context) {
      function check(node: TSESTree.Node, tokens: Set<string>) {
        const bases = new Set([...tokens].flatMap((t) => ownClass(t) ?? []));
        let hasChromeHeight = false;
        let hasCenter = false;
        for (const b of bases) {
          if (CHROME_HEIGHT.has(b)) hasChromeHeight = true;
          if (CENTER.has(b)) hasCenter = true;
        }
        if (hasChromeHeight && bases.has(BORDER_BOTTOM) && hasCenter) {
          context.report({ node, messageId: "adhocBar" });
        }
      }

      return {
        JSXAttribute(node) {
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);
          check(node, tokens);
        },
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !CLASS_BUILDERS.has(node.callee.name)
          ) {
            return;
          }
          if (inClassAttribute(node)) return;
          const tokens = new Set<string>();
          for (const arg of node.arguments)
            collectTokens(context.sourceCode, arg, tokens);
          check(node, tokens);
        },
      };
    },
  });
}
