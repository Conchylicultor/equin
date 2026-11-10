import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-pane-header-bar
 *
 * `<Bar tier="pane">` is the pane header's own tier, drawn only by
 * `PaneChrome` (and its `FallbackChrome` mirror), both inside `primitives/pane`.
 * A pane that draws its header by hand with that tier passes
 * `no-adhoc-pane-toolbar` and `no-adhoc-bar` (they fingerprint class strings,
 * and `Bar` wears none of them at the call site) while skipping `PaneChrome` —
 * losing the header double-click zoom, the `Actions` slot, the `⋯` overflow,
 * reorder and the standard close. The Files panes did exactly that.
 *
 * Render `<PaneChrome>` and contribute header items to the pane's `Actions`
 * slot / `title.component`. A strip inside a pane is `tier="subpane"`.
 *
 * Detection: a JSX element named `Bar` carrying the literal attribute
 * `tier="pane"` / `tier={"pane"}`. Matched by name (not by resolving the
 * import): `Bar` is the primitive's only export of that name and a local
 * lookalike carrying `tier="pane"` is the same smell. The pane plugin's own
 * tree is exempt (`pane/exempt/index.ts`); a secondary strip that is
 * deliberately pane-tier declares a `sanctioned` exemption in its own plugin.
 */
export default createRule({
  name: "no-pane-header-bar",
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow `<Bar tier="pane">` outside primitives/pane — the pane header is drawn only by PaneChrome.',
    },
    schema: [],
    messages: {
      paneHeaderBar:
        '`<Bar tier="pane">` is the pane header\'s own tier, drawn only by PaneChrome; render ' +
        "`<PaneChrome>` and contribute header items to the pane's `Actions` slot / " +
        '`title.component` (a strip inside a pane is `tier="subpane"`).',
    },
  },
  defaultOptions: [],
  create(context) {
    function isPaneLiteral(value: TSESTree.JSXAttribute["value"]): boolean {
      if (!value) return false;
      if (value.type === "Literal") return value.value === "pane";
      if (
        value.type === "JSXExpressionContainer" &&
        value.expression.type === "Literal"
      ) {
        return value.expression.value === "pane";
      }
      return false;
    }

    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "Bar")
          return;
        for (const attr of node.attributes) {
          if (
            attr.type === "JSXAttribute" &&
            attr.name.type === "JSXIdentifier" &&
            attr.name.name === "tier" &&
            isPaneLiteral(attr.value)
          ) {
            context.report({ node: attr, messageId: "paneHeaderBar" });
          }
        }
      },
    };
  },
});
