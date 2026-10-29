/**
 * Bans hand-rolled "Loading…" JSX text outside the sanctioned homes. The
 * `loading` primitive's <Loading> (or <Placeholder> for plain muted text) is
 * the single home for the loading state — it carries the delay-before-show
 * that prevents flash on fast loads, which ad-hoc text never does.
 */
import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { AST_NODE_TYPES } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const SANCTIONED_PARENTS = new Set(["Loading", "Placeholder"]);

export default createRule({
  name: "no-adhoc-loading-text",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow ad-hoc `Loading…` JSX text — use the <Loading> primitive (or <Placeholder>) instead.",
    },
    schema: [],
    messages: {
      adhocLoadingText:
        "Ad-hoc loading text. Use <Loading/> from @plugins/primitives/plugins/loading/web — it delays before showing so fast " +
        "loads never flash — or <Placeholder> for plain muted text.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXText(node) {
        const text = node.value.trim();
        if (!/^Loading\b/u.test(text)) return;
        const parent = node.parent;
        if (parent.type === AST_NODE_TYPES.JSXElement) {
          const name = parent.openingElement.name;
          if (name.type === AST_NODE_TYPES.JSXIdentifier && SANCTIONED_PARENTS.has(name.name)) {
            return;
          }
        }
        context.report({ node, messageId: "adhocLoadingText" });
      },
    };
  },
});
