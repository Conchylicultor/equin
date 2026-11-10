import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESLint, TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/** `<anything>.documentElement` — the root element of some document. */
function isDocumentElement(node: TSESTree.Node): boolean {
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    node.property.name === "documentElement"
  );
}

/**
 * Does `id` name a `const` bound straight to `<doc>.documentElement`
 * (`const root = document.documentElement; root.style…`)?
 */
function isRootAlias(
  id: TSESTree.Identifier,
  scope: TSESLint.Scope.Scope,
): boolean {
  for (let s: typeof scope | null = scope; s; s = s.upper) {
    const variable = s.set.get(id.name);
    if (!variable) continue;
    return variable.defs.some(
      (def) =>
        def.node.type === "VariableDeclarator" &&
        def.parent?.type === "VariableDeclaration" &&
        def.parent.kind === "const" &&
        def.node.init != null &&
        isDocumentElement(def.node.init),
    );
  }
  return false;
}

/**
 * Bans touching `<html>`'s inline style (`document.documentElement.style`, or
 * `.style` of a const holding it): a custom property or style set there is
 * inherited by — and so restyles — every element of the page, which cost
 * 300–450 ms per write on an 18k-element page. Root-level styling belongs to
 * the theme engine's stylesheets; anything else sets its value on the subtree
 * that reads it (a rule keyed on that subtree's own class, as the floating
 * bar's safe area does).
 */
export default createRule({
  name: "no-root-style-write",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow writing inline styles or custom properties on <html> " +
        "(documentElement.style) — every write restyles the whole page.",
    },
    schema: [],
    messages: {
      rootStyle:
        "Inline style on <html> (`documentElement.style`): a custom property " +
        "or style set there is inherited by every element of the page, so each " +
        "write forces a whole-document style recalc (300–450 ms measured on an " +
        "18k-element page). Root-level styling is the theme engine's (its " +
        "stylesheets). Set the value on the subtree that reads it instead — a " +
        "rule keyed on that subtree's own class (an adopted CSSStyleSheet, as " +
        "shell/global-action-bar's use-floating-bar-safe-area does), or an " +
        "inline style on that element.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node): void {
        if (
          node.computed ||
          node.property.type !== "Identifier" ||
          node.property.name !== "style"
        )
          return;
        const target = node.object;
        const onRoot =
          isDocumentElement(target) ||
          (target.type === "Identifier" &&
            isRootAlias(target, context.sourceCode.getScope(node)));
        if (onRoot) context.report({ node, messageId: "rootStyle" });
      },
    };
  },
});
