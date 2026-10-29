import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Bans importing `@dnd-kit/*` outside the drag-and-drop primitives. A feature
 * that hand-rolls `useSortable` re-derives the transform, sensors and activator
 * wiring from the library docs — and the docs' snippet is the one that squashes
 * items (see `no-scaling-transform`). Routing every sortable through
 * SortableList / SortableItem means that wiring exists once.
 */
export default createRule({
  name: "no-raw-dnd-kit",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow importing @dnd-kit outside the drag-and-drop primitives — use SortableList / SortableItem.",
    },
    schema: [],
    messages: {
      rawDndKit:
        "Import drag-and-drop from @plugins/primitives/plugins/sortable-list/web (SortableList, " +
        "SortableItem, arrayMove) instead of `{{source}}`. If the primitive cannot express what " +
        "you need, extend it rather than wiring dnd-kit by hand.",
    },
  },
  defaultOptions: [],
  create(context) {
    const check = (
      source: { value: unknown } | null | undefined,
      node: TSESTree.Node,
    ) => {
      if (
        typeof source?.value === "string" &&
        source.value.startsWith("@dnd-kit/")
      ) {
        context.report({
          node,
          messageId: "rawDndKit",
          data: { source: source.value },
        });
      }
    };
    return {
      ImportDeclaration(node) {
        check(node.source, node);
      },
      ExportNamedDeclaration(node) {
        check(node.source, node);
      },
      ExportAllDeclaration(node) {
        check(node.source, node);
      },
      ImportExpression(node) {
        if (node.source.type === "Literal") check(node.source, node);
      },
    };
  },
});
