import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { isIconRefModule } from "@plugins/ui/plugins/icons/core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * The new-tab arrow (`navIcons.newTab`) is drawn only by the `new-tab`
 * primitive, which owns the behaviour with it — so a control cannot wear the
 * arrow and do something else (open an app tab, a pane, a host app). Flags
 * every read of `navIcons.newTab`, dotted or destructured.
 */
export default createRule({
  name: "no-adhoc-new-tab",
  meta: {
    type: "problem",
    docs: {
      description:
        "The new-tab glyph (navIcons.newTab) is drawn only by the link-gesture/new-tab primitive.",
    },
    schema: [],
    messages: {
      adhoc:
        "`navIcons.newTab` is owned by the new-tab primitive (`@plugins/primitives/plugins/link-gesture/plugins/new-tab/web`): use NewTabButton / NewTabMenuItem / NewTabLink / newTabAnchorProps (or NewTabGlyph for a container that opens the tab itself). A new APP tab wears `navIcons.newAppTab`; a host app `navIcons.hostApp`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const isNewTabKey = (key: TSESTree.Node, computed: boolean) =>
      (!computed && key.type === "Identifier" && key.name === "newTab") ||
      (key.type === "Literal" && key.value === "newTab");

    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (!isIconRefModule(context.filename, node.source.value)) return;
        for (const spec of node.specifiers) {
          if (spec.type !== "ImportSpecifier") continue;
          const imported =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
          if (imported !== "navIcons") continue;
          const variable = context.sourceCode
            .getDeclaredVariables(spec)
            .find((v) => v.name === spec.local.name);
          for (const ref of variable?.references ?? []) {
            const parent = ref.identifier.parent;
            if (
              parent?.type === "MemberExpression" &&
              parent.object === ref.identifier &&
              isNewTabKey(parent.property, parent.computed)
            ) {
              context.report({ node: parent, messageId: "adhoc" });
            } else if (
              parent?.type === "VariableDeclarator" &&
              parent.init === ref.identifier &&
              parent.id.type === "ObjectPattern" &&
              parent.id.properties.some(
                (p) => p.type === "Property" && isNewTabKey(p.key, p.computed),
              )
            ) {
              context.report({ node: parent, messageId: "adhoc" });
            }
          }
        }
      },
    };
  },
});
