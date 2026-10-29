import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Bans dnd-kit's `CSS.Transform` serializer. With no `DragOverlay`, dnd-kit
 * scales the dragged item's transform to the rect under it
 * (`scaleX = over.width / active.width`, same for Y), and `CSS.Transform`
 * writes that scale out — so dragging a tall item over a short one squashes it
 * to the short one's aspect ratio. `CSS.Translate` writes the movement only.
 * The dnd-kit docs' `useSortable` snippet uses `CSS.Transform`, which is why it
 * keeps coming back: it looks right in any demo whose items share one size.
 */
export default createRule({
  name: "no-scaling-transform",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow dnd-kit's `CSS.Transform` — it applies the drag's scaleX/scaleY and squashes items of different sizes.",
    },
    schema: [],
    messages: {
      scalingTransform:
        "`CSS.Transform` applies dnd-kit's scaleX/scaleY and squashes the dragged item onto the " +
        "size of whatever it is over. Use `CSS.Translate.toString(transform)` — or better, the " +
        "SortableList / SortableItem primitive from @plugins/primitives/plugins/sortable-list/web, " +
        "which owns the transform for you.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          node.object.name === "CSS" &&
          !node.computed &&
          node.property.type === "Identifier" &&
          node.property.name === "Transform"
        ) {
          context.report({ node, messageId: "scalingTransform" });
        }
      },
    };
  },
});
