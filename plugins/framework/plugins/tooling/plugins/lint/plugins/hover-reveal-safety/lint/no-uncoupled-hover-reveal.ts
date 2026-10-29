import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Several hover-reveal sites paint a trailing affordance with a bare
 * `opacity-0 group-hover:opacity-100` className WITHOUT coupling
 * `pointer-events`. At rest the element is invisible but still a live
 * hit-target, so a click on the blank strip beside the content silently fires
 * an unseen action — a phantom-click UX bug.
 *
 * This rule flags any `className` that fades opacity to 0 at rest, reveals it on
 * group-hover/focus-within toward a non-zero opacity, but never mentions
 * `pointer-events`. The fix is `hoverRevealTarget` + `hoverRevealGroup` from
 * `@plugins/primitives/plugins/hover-reveal/web` (which couples both), or a
 * matching `pointer-events` toggle by hand.
 */

/**
 * Total recursive collector: returns every static string fragment reachable
 * under an ESTree node (literals, template quasis, and the operands of the
 * expression forms a className commonly composes — `cn(...)`, conditionals,
 * concatenation, arrays). Defaults to `[]` for any node kind it doesn't handle,
 * so it never throws on an unexpected shape.
 */
function collectStrings(node: TSESTree.Node | null | undefined): string[] {
  if (!node) return [];
  if (node.type === "Literal") {
    return typeof node.value === "string" ? [node.value] : [];
  }
  if (node.type === "TemplateLiteral") {
    return [
      ...node.quasis.map((q) => q.value.cooked ?? q.value.raw),
      ...node.expressions.flatMap((e) => collectStrings(e)),
    ];
  }
  if (node.type === "JSXExpressionContainer") {
    return collectStrings(node.expression as TSESTree.Node);
  }
  if (node.type === "CallExpression") {
    return node.arguments.flatMap((a) => collectStrings(a as TSESTree.Node));
  }
  if (node.type === "LogicalExpression") {
    return [...collectStrings(node.left), ...collectStrings(node.right)];
  }
  if (node.type === "ConditionalExpression") {
    return [
      ...collectStrings(node.consequent),
      ...collectStrings(node.alternate),
    ];
  }
  if (node.type === "BinaryExpression") {
    return [
      ...collectStrings(node.left as TSESTree.Node),
      ...collectStrings(node.right),
    ];
  }
  if (node.type === "ArrayExpression") {
    return node.elements.flatMap((e) => collectStrings(e as TSESTree.Node));
  }
  return [];
}

export default createRule({
  name: "no-uncoupled-hover-reveal",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow a hover-reveal className that couples opacity but not pointer-events — the hidden element stays a live click-target. Use hoverRevealTarget + hoverRevealGroup from @plugins/primitives/plugins/hover-reveal/web.",
    },
    schema: [],
    messages: {
      uncoupled:
        "Hover-reveal className couples opacity but not pointer-events — the hidden element stays a live click-target. Use hoverRevealTarget + hoverRevealGroup from @plugins/primitives/plugins/hover-reveal/web, or add a matching pointer-events toggle (pointer-events-none at rest + group-hover/…:pointer-events-auto).",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      JSXAttribute(node: TSESTree.JSXAttribute) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "className")
          return;

        const text = collectStrings(node.value as TSESTree.Node).join(" ");

        const hasOpacityZero = /(^|\s)opacity-0(\s|$)/.test(text);
        const hasGroupReveal =
          /group-(hover|focus-within)(\/[\w-]+)?:opacity-(?!0)/.test(text);
        const hasPointerEvents = /pointer-events-/.test(text);

        if (hasOpacityZero && hasGroupReveal && !hasPointerEvents) {
          context.report({ node, messageId: "uncoupled" });
        }
      },
    };
  },
});
