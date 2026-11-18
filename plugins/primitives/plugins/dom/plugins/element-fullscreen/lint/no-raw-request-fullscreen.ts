import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-request-fullscreen
 *
 * `el.requestFullscreen()` assumes a browser that has element fullscreen. An
 * iPhone has none (the method is undefined: "requestFullscreen is not a
 * function"), and a frame without `allowfullscreen` may not use it. Ask
 * through `fullscreenSupport(doc).request(el)` from
 * `@plugins/primitives/plugins/dom/plugins/element-fullscreen/web`, whose
 * `unsupported` arm has no `request` — and offer no fullscreen control there
 * (`useFullscreenSupport()`).
 *
 * Leaf-name based: any call whose callee is a member ending in
 * `.requestFullscreen` (computed or not).
 */

const createRule = lintRuleCreator(import.meta.url);

function isRequestFullscreen(callee: TSESTree.Expression): boolean {
  if (callee.type !== "MemberExpression") return false;
  const p = callee.property;
  if (!callee.computed)
    return p.type === "Identifier" && p.name === "requestFullscreen";
  return p.type === "Literal" && p.value === "requestFullscreen";
}

export default createRule({
  name: "no-raw-request-fullscreen",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw el.requestFullscreen() — ask through fullscreenSupport(doc) from " +
        "@plugins/primitives/plugins/dom/plugins/element-fullscreen/web, which is unsupported where the browser has no element fullscreen.",
    },
    schema: [],
    messages: {
      noRawRequestFullscreen:
        "Raw .requestFullscreen() crashes where the browser has no element fullscreen (an iPhone: " +
        "'requestFullscreen is not a function'). Use fullscreenSupport(doc) from " +
        "@plugins/primitives/plugins/dom/plugins/element-fullscreen/web and branch on its kind; " +
        "don't offer a fullscreen control where it is unsupported (useFullscreenSupport()).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (node.callee.type === "Super") return;
        if (!isRequestFullscreen(node.callee)) return;
        context.report({ node, messageId: "noRawRequestFullscreen" });
      },
    };
  },
});
