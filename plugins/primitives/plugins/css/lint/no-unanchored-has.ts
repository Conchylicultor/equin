import { ESLintUtils } from "@typescript-eslint/utils";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { unanchoredHas } from "../core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * The Tailwind front-end of the unanchored-`:has()` invariant
 * (`css/core/unanchored-has.ts` states it and says why; its twin
 * `css:no-unanchored-has` applies it to stylesheets). Each variant naming a
 * `:has()` is translated to the selector Tailwind v4 compiles it to, with the
 * element's own class as `.cls`, and checked by the same predicate:
 *
 *   - `group-has-[x]/g:` → `.cls:is(:where(.group\/g):has(x) *)`   ✗
 *   - `peer-has-[x]:`    → `.cls:is(:where(.peer):has(x) ~ *)`     ✗
 *   - `[&_:has(x)]:`     → `.cls :has(x)`                         ✗
 *   - `has-[x]:`         → `.cls:has(x)`                          ✓
 *   - `in-[.a:has(x)]:`  → `:where(.a:has(x)) .cls`               ✓
 *   - `[[data-host]:has(x)_&]:` → `[data-host]:has(x) .cls`       ✓
 */

/** Strip a trailing `/name` group/peer label (outside brackets). */
function splitLabel(v: string): { body: string; label: string } {
  let depth = 0;
  for (let i = v.length - 1; i >= 0; i--) {
    const c = v[i];
    if (c === "]" || c === ")") depth++;
    else if (c === "[" || c === "(") depth--;
    else if (c === "/" && depth === 0 && v[i - 1] !== "\\")
      return { body: v.slice(0, i), label: v.slice(i + 1) };
  }
  return { body: v, label: "" };
}

/** An arbitrary value's selector: `_` is a space, `\_` a literal `_`. */
const arbitrary = (x: string) =>
  x.replace(/\\_|_/g, (m) => (m === "_" ? " " : "_"));

/**
 * The selector a variant compiles to, `&` standing for the element. Variants
 * that cannot carry a `:has()` are just `&` — their pseudo/attribute is
 * irrelevant to the invariant, and inside a `:has()` argument nothing is.
 */
export function variantSelector(variant: string): string {
  const v = variant.replace(/^!+|!+$/g, "");
  if (v.startsWith("[") && v.endsWith("]")) {
    const sel = arbitrary(v.slice(1, -1));
    return sel.includes("&") ? sel : `&:is(${sel})`;
  }
  const inner = (rest: string) => variantSelector(rest).replaceAll("&", "*");
  if (v.startsWith("has-")) return `&:has(${inner(v.slice(4))})`;
  if (v.startsWith("not-")) return `&:not(${inner(v.slice(4))})`;
  if (v.startsWith("in-")) return `:where(${inner(v.slice(3))}) &`;
  const m = /^(group|peer)-(.+)$/.exec(v);
  if (m) {
    const { body, label } = splitLabel(m[2]!);
    const host = `:where(.${m[1]}${label ? `\\/${label}` : ""})`;
    const rel = m[1] === "group" ? " *" : " ~ *";
    return `&:is(${variantSelector(body).replaceAll("&", host)}${rel})`;
  }
  return "&";
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

/** The first offending compound among a token's `:has()`-naming variants. */
export function tokenOffence(token: string): string | null {
  for (const variant of variantsOf(token)) {
    if (!variant.includes("has")) continue;
    const found = unanchoredHas(
      variantSelector(variant).replaceAll("&", ".cls"),
    );
    if (found.length > 0) return found[0]!.compound;
  }
  return null;
}

export default function buildRule({
  collectTokens,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-unanchored-has",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow Tailwind variants compiling to a `:has()` on, or followed by, a compound naming no element (group-has-*, peer-has-*, group-not-has-*, [&_:has(…)], […:has(…)_*]) — each makes every DOM insertion or removal restyle whole subtrees.",
      },
      schema: [],
      messages: {
        unanchoredHas:
          "`{{token}}` compiles to a `:has()` with `{{compound}}` naming no element at or after it, which " +
          "makes Chrome restyle whole subtrees on each DOM insertion or removal (it cost seconds per map " +
          "zoom). Anchor the `:has()` on a marked ancestor and name this element: " +
          "`[[data-host]:has(…)_&]:<utility>` compiles to `[data-host]:has(…) .cls`.",
      },
    },
    defaultOptions: [],
    create(context) {
      function check(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          const compound = tokenOffence(token);
          if (compound !== null)
            context.report({
              node,
              messageId: "unanchoredHas",
              data: { token, compound },
            });
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
