import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-raw-resize-observer",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolling `new ResizeObserver` — route element size / " +
        "resize observation through the element-size primitive.",
    },
    schema: [],
    messages: {
      rawResizeObserver:
        "`new ResizeObserver` is banned outside the element-size primitive. " +
        "Use useElementSize / useResizeObserver from " +
        "@plugins/primitives/plugins/dom/plugins/element-size/web instead (reactive size, " +
        "synchronous initial measure, RAF-debounced, auto cleanup). If you have " +
        "a genuinely different need, extend that primitive rather than copying it.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "ResizeObserver"
        ) {
          context.report({ node, messageId: "rawResizeObserver" });
        }
      },
    };
  },
});
