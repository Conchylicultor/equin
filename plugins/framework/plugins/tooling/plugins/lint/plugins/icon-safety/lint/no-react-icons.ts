import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

/** A `react-icons` module specifier (`react-icons`, `react-icons/md`, …). */
function isReactIcons(source: unknown): boolean {
  return (
    typeof source === "string" &&
    (source === "react-icons" || source.startsWith("react-icons/"))
  );
}

const createRule = lintRuleCreator(import.meta.url);

/**
 * Icons are data: `symbol("…")` / `brand("…")` from `ui/icons/core`, drawn by
 * `<Icon>` in the style the theme scope picks. A react-icons component hard-codes
 * one style (and a second icon set beside the sprites). The package is no
 * longer installed — saved (user-picked) icons are Material Symbols names too,
 * drawn by `<Icon>` as runtime symbols — so this rule is the guard that keeps
 * it from coming back.
 */
export default createRule({
  name: "no-react-icons",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow react-icons — icons are symbol()/brand() IconRefs drawn by <Icon>.",
    },
    schema: [],
    messages: {
      reactIcons:
        'react-icons is not used for icons any more: name the glyph as data with symbol("…") (Material Symbols) or brand("…") (Simple Icons) ' +
        "from @plugins/ui/plugins/icons/core and draw it with <Icon icon={…}/> from @plugins/ui/plugins/icons/web. " +
        "A slot or prop takes `icon: IconRef`, never a component.",
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (node: TSESTree.Node, source: unknown): void => {
      if (isReactIcons(source))
        context.report({ node, messageId: "reactIcons" });
    };
    return {
      ImportDeclaration(node) {
        check(node, node.source.value);
      },
      ExportNamedDeclaration(node) {
        if (node.source) check(node, node.source.value);
      },
      ExportAllDeclaration(node) {
        check(node, node.source.value);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node, node.source.value);
      },
    };
  },
});
