import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-request-picture-in-picture
 *
 * `video.requestPictureInPicture()` is missing on some browsers and, where it
 * exists, a request the browser may refuse with a DOMException (no gesture, a
 * video not ready, one iOS cannot float). Ask through
 * `videoPipSupport(doc).request(video)` from
 * `@plugins/primitives/plugins/dom/plugins/media-element/web`, whose
 * `unsupported` arm has no `request` and whose refusal is a value.
 *
 * Leaf-name based: any call whose callee is a member ending in
 * `.requestPictureInPicture` (computed or not).
 */

const createRule = lintRuleCreator(import.meta.url);

function isRequestPip(callee: TSESTree.Expression): boolean {
  if (callee.type !== "MemberExpression") return false;
  const p = callee.property;
  if (!callee.computed)
    return p.type === "Identifier" && p.name === "requestPictureInPicture";
  return p.type === "Literal" && p.value === "requestPictureInPicture";
}

export default createRule({
  name: "no-raw-request-picture-in-picture",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw video.requestPictureInPicture() — ask through videoPipSupport(doc) from " +
        "@plugins/primitives/plugins/dom/plugins/media-element/web.",
    },
    schema: [],
    messages: {
      noRawRequestPip:
        "Raw .requestPictureInPicture() is missing on some browsers and its refusals reject with " +
        "stack-less DOMExceptions. Use videoPipSupport(doc) from " +
        "@plugins/primitives/plugins/dom/plugins/media-element/web and branch on its kind and outcome.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (node.callee.type === "Super") return;
        if (!isRequestPip(node.callee)) return;
        context.report({ node, messageId: "noRawRequestPip" });
      },
    };
  },
});
