import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

export default createRule({
  name: "no-adhoc-scroll-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw scroll writes (`scrollTop=`/`scrollLeft=`/`scrollTo`/" +
        "`scrollBy`) — route stick-to-bottom / jump-to-bottom / reveal through " +
        "the scroll-owning primitives.",
    },
    schema: [],
    messages: {
      adhocScrollWrite:
        "Raw scroll writes (`{{api}}`) are banned outside the scroll-owning " +
        "primitives. For stick-to-bottom / jump-to-bottom use `useStickyScroll` " +
        "/ `scrollToBottom` from `@plugins/primitives/plugins/dom/plugins/auto-scroll/web`. " +
        "For reveal-an-element-on-activation use `useRevealOnActive` / " +
        "`revealElement` from `@plugins/primitives/plugins/dom/plugins/scroll-reveal/web`. " +
        "If you have a genuinely different need, extend those primitives rather " +
        "than copying them.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      // Writes: `el.scrollTop = …` / `el.scrollLeft = …`. Reads (assignment
      // sources) are a plain MemberExpression, never the `left` of an
      // AssignmentExpression, so they are not flagged.
      AssignmentExpression(node) {
        const left = node.left;
        if (
          left.type === "MemberExpression" &&
          !left.computed &&
          left.property.type === "Identifier" &&
          (left.property.name === "scrollTop" ||
            left.property.name === "scrollLeft")
        ) {
          context.report({
            node,
            messageId: "adhocScrollWrite",
            data: { api: `${left.property.name}=` },
          });
        }
      },
      // Calls: `el.scrollTo(…)` / `el.scrollBy(…)`.
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          callee.property.type === "Identifier" &&
          (callee.property.name === "scrollTo" ||
            callee.property.name === "scrollBy")
        ) {
          context.report({
            node,
            messageId: "adhocScrollWrite",
            data: { api: callee.property.name },
          });
        }
      },
    };
  },
});
