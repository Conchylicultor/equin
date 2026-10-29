import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-raw-intersection-observer",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-rolling `new IntersectionObserver` — route " +
        "on-screen / intersection observation through the in-view primitive.",
    },
    schema: [],
    messages: {
      rawIntersectionObserver:
        "`new IntersectionObserver` is banned outside the in-view primitive. " +
        "Use createInViewWatcher / useInView from " +
        "@plugins/primitives/plugins/dom/plugins/in-view/web instead (idempotent WeakSet " +
        "enrollment, stabilised callback, deps-keyed rebuild, auto cleanup). If " +
        "you have a genuinely different need, extend that primitive rather than " +
        "copying it.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      NewExpression(node) {
        if (
          node.callee.type === "Identifier" &&
          node.callee.name === "IntersectionObserver"
        ) {
          context.report({ node, messageId: "rawIntersectionObserver" });
        }
      },
    };
  },
});
