import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Toolbar-host guardrail.
 *
 * A pane that wants a rich custom header is tempted to hand-roll a
 * `<div className="… border-b … pr-floating-bar">` header with the back button /
 * title / actions written inline. That bar is then invisible to the slot system:
 * not extensible, not error-isolated, not reorderable — exactly the drift this
 * rule prevents. The sanctioned home is the pane's own header slot — every pane
 * has one, minted by `Pane.define` (or borrowed from another pane via
 * `Pane.define({ actions })`), and `PaneChrome` renders it as the standard pane
 * header: reorderable, error-isolated, and collapsing into a `⋯` when the row
 * runs out of room. Contribute to it instead of writing a bar.
 * App-level toolbars route through `AppShellLayout`'s `toolbarSlot`.
 *
 * Detection signature: a class-name carrying BOTH `border-b` and
 * `pr-floating-bar`. `pr-floating-bar` reserves space under the top-right
 * floating action bar — it is worn only by a top toolbar row, which makes the
 * pair a precise, low-false-positive fingerprint for "this is a toolbar bar."
 * The sanctioned hosts wear the same signature and are exempted by path in
 * their own `exempt/index.ts`. Inspected only in a class-name context (a `className`/`class`
 * attribute or a `cn(...)`/`clsx(...)`/`twMerge(...)` argument) via the shared
 * `collectTokens` walk, so prose mentioning the classes is never flagged.
 */

/** The two tokens that together fingerprint a hand-rolled toolbar bar. */
const BORDER_BOTTOM = "border-b";
const TOOLBAR_PAD = "pr-floating-bar";

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  /**
   * True when `node` sits inside a `className`/`class` JSX attribute. A
   * `className={cn(...)}` is walked by BOTH visitors (the attribute's value
   * subtree reaches the `cn(...)` call, and the call fires on its own), so the
   * `CallExpression` handler skips these to avoid double-reporting — the
   * `JSXAttribute` handler already covers them. A standalone `const c = cn(...)`
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
    name: "no-adhoc-pane-toolbar",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow hand-rolled toolbar bars (a `border-b` + `pr-floating-bar` header). Route a pane toolbar through the pane's own header slot or AppShellLayout's toolbarSlot.",
      },
      schema: [],
      messages: {
        adhocToolbarBar:
          "Hand-rolled toolbar bar (`border-b` + `pr-floating-bar`) is banned — a toolbar must " +
          "route through a render-slot host so its items are contributions (extensible, " +
          "error-isolated, reorderable). Contribute to the pane's own header slot " +
          "(`myPane.Actions({ id, component })`, or a shared one borrowed via " +
          "`Pane.define({ actions })`) — `PaneChrome` renders it as the pane header — or " +
          "`AppShellLayout`'s `toolbarSlot` for an app-level bar — never a hand-written header.",
      },
    },
    defaultOptions: [],
    create(context) {
      function check(node: TSESTree.Node, tokens: Set<string>) {
        const bases = new Set([...tokens].map(baseClass));
        if (bases.has(BORDER_BOTTOM) && bases.has(TOOLBAR_PAD)) {
          context.report({ node, messageId: "adhocToolbarBar" });
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
          // Skip calls inside a className attribute — the JSXAttribute handler
          // already walks into them; reporting here too would double-count.
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
