import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-raw-selection-range",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolling `getRangeAt(...)` — route the document " +
        "selection's range / rect read through the dom-selection primitive, " +
        "which states its three-part guard once.",
    },
    schema: [],
    messages: {
      rawSelectionRange:
        "`getRangeAt` is banned outside the dom-selection primitive. It is the " +
        "one selection read with a THREE-part guard — no selection at all, " +
        "`rangeCount === 0`, and `getRangeAt(0)` itself throwing `IndexSizeError` " +
        "when the range was invalidated between the check and the read. This repo " +
        "grew four hand-rolled copies and exactly one had all three. Use " +
        "`selectionRange()` (the range) or `selectionRect()` (its bounding box) " +
        "from @plugins/primitives/plugins/dom/plugins/dom-selection/web instead. Bare " +
        "`getSelection()` is NOT banned: `.toString()`, `.anchorNode`, " +
        "`.isCollapsed` and `.removeAllRanges()` need no guard — `getRangeAt` is " +
        "the one read that does.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "getRangeAt"
        ) {
          context.report({ node, messageId: "rawSelectionRange" });
        }
      },
    };
  },
});
