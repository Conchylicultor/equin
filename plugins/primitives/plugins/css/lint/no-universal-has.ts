import { ESLintUtils } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Bans the Tailwind variants that compile to a `:has()` followed by a
 * UNIVERSAL selector:
 *
 *   - `group-has-[…]/x:` → `:is(:where(.group\/x):has(…) *)`
 *   - `peer-has-[…]/x:`  → `:is(:where(.peer\/x):has(…) ~ *)`
 *   - `in-[…:has(…)]:`   → `:is(:where(…:has(…)) *)`
 *   - an arbitrary variant whose `:has(…)` is followed by `*`
 *
 * Chrome turns every such rule into one shared invalidation set that marks ALL
 * descendants of an element as possibly changed whenever its `:has()` state
 * might change — and it might on every DOM insertion or removal beneath any
 * `:has()`-flagged ancestor. So one of these anywhere in the app makes every
 * DOM churn restyle whole subtrees: wheel-zooming the Places map (Google swaps
 * hundreds of tiles a step) spent ~7 s of style recalc for twelve zoom steps,
 * against ~0.7 s without them (`map/google/e2e/zoom-profile.ts`).
 *
 * Name the element the rule styles instead, so the invalidation reaches only
 * it: put the class on that element and anchor the `:has()` on a marked
 * ancestor — `[[data-host]:has(:active)_&]:opacity-100` compiles to
 * `[data-host]:has(:active) .cls`. A plain `has-[…]:` on the element itself
 * (subject `:has()`) is fine.
 */
function isUniversalHas(variant: string): boolean {
  const v = variant.replace(/^!+|!+$/g, "");
  if (/^(group|peer)-has-/.test(v)) return true;
  if (/^in-\[/.test(v) && v.includes(":has(")) return true;
  if (!v.startsWith("[")) return false;
  // What directly follows each `:has(…)` (Tailwind spells a space `_`).
  for (
    let at = v.indexOf(":has(");
    at !== -1;
    at = v.indexOf(":has(", at + 1)
  ) {
    let end = at + ":has(".length;
    for (let depth = 1; end < v.length && depth > 0; end++) {
      if (v[end] === "(") depth++;
      else if (v[end] === ")") depth--;
    }
    if (/^[_>~+]+\*/.test(v.slice(end))) return true;
  }
  return false;
}

/** A token's variant chain, split on `:` outside brackets and parens. */
function variantsOf(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === "[" || ch === "(") depth++;
    else if (ch === "]" || ch === ")") depth--;
    else if (ch === ":" && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  return parts;
}

export default function buildRule({
  collectTokens,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-universal-has",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow Tailwind variants compiling to a `:has()` followed by a universal selector (group-has-*, peer-has-*, in-[…:has()], […:has(…)_*]) — each makes every DOM insertion or removal restyle whole subtrees.",
      },
      schema: [],
      messages: {
        universalHas:
          "`{{token}}` compiles to a `:has()` followed by a universal selector, which makes Chrome " +
          "restyle the whole subtree under every `:has()`-flagged ancestor on each DOM insertion or " +
          "removal (it cost seconds per map zoom). Anchor the `:has()` on a marked ancestor and name " +
          "this element: `[[data-host]:has(…)_&]:<utility>` compiles to `[data-host]:has(…) .cls`.",
      },
    },
    defaultOptions: [],
    create(context) {
      function check(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          if (variantsOf(token).some(isUniversalHas)) {
            context.report({
              node,
              messageId: "universalHas",
              data: { token },
            });
          }
        }
      }
      return {
        JSXAttribute(node) {
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);
          check(node, tokens);
        },
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !CLASS_BUILDERS.has(node.callee.name)
          )
            return;
          const tokens = new Set<string>();
          for (const arg of node.arguments)
            collectTokens(context.sourceCode, arg, tokens);
          check(node, tokens);
        },
      };
    },
  });
}
