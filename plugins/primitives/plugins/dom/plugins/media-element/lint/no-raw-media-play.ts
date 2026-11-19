import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-raw-media-play
 *
 * `HTMLMediaElement.play()` rejects with a stack-less DOMException for answers
 * that are not bugs — no gesture yet, a pause overtaking it, a source that
 * failed to load (already reported by the element's `error` event). Rethrowing
 * them files stack-less crashes ("NotSupportedError: The operation is not
 * supported.", iPhone Safari). Play through `playMedia(el)` from
 * `@plugins/primitives/plugins/dom/plugins/media-element/web`, which answers
 * them as values and throws only what it cannot name, with the caller's stack.
 *
 * Syntactic: a zero-argument `.play()` call whose result is used as a promise
 * (`.then` / `.catch` / `.finally`, `await`, `void`). An Animation's or a
 * controller's `play()` returns nothing to chain, so it is not flagged.
 */

const createRule = lintRuleCreator(import.meta.url);

function isPlayCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || node.arguments.length > 0)
    return false;
  const p = callee.property;
  if (!callee.computed) return p.type === "Identifier" && p.name === "play";
  return p.type === "Literal" && p.value === "play";
}

function usedAsPromise(node: TSESTree.CallExpression): boolean {
  const parent = node.parent;
  if (parent.type === "AwaitExpression") return true;
  if (parent.type === "UnaryExpression") return parent.operator === "void";
  return (
    parent.type === "MemberExpression" &&
    parent.object === node &&
    !parent.computed &&
    parent.property.type === "Identifier" &&
    ["then", "catch", "finally"].includes(parent.property.name)
  );
}

export default createRule({
  name: "no-raw-media-play",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a raw media element .play() promise — play through playMedia(el) from " +
        "@plugins/primitives/plugins/dom/plugins/media-element/web, which names every refusal.",
    },
    schema: [],
    messages: {
      noRawMediaPlay:
        "A raw .play() promise rejects with stack-less DOMExceptions that are the browser's answers " +
        "(no gesture, overtaken, a source that failed to load). Use playMedia(el) from " +
        "@plugins/primitives/plugins/dom/plugins/media-element/web and branch on its outcome.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node: TSESTree.CallExpression) {
        if (!isPlayCall(node) || !usedAsPromise(node)) return;
        context.report({ node, messageId: "noRawMediaPlay" });
      },
    };
  },
});
