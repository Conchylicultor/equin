import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Spacing-rhythm guardrail.
 *
 * Layout spacing must come from ONE closed set of roles — the 8-step density
 * spacing ramp (`none|2xs|xs|sm|md|lg|xl|2xl`), consumed through the `<Stack
 * gap>` / `<Inset pad>` primitives (`@plugins/primitives/plugins/css/plugins/spacing/web`)
 * or the matching `gap-<step>` / `p-<step>` `@utility` classes. Tailwind's raw
 * spacing scale exposes ~20 continuous steps per axis (plus `gap-[7px]`), so
 * hand-written `gap-2`/`px-3`/`mt-4` is exactly how spacing drifts when many
 * agents write UI in parallel: every call site picks a slightly different value.
 *
 * This rule fires on ANY element (spacing is set everywhere) and bans raw
 * Tailwind spacing — numeric (`gap-2`, `px-3`, `m-4`, `space-y-2`) or arbitrary
 * (`gap-[7px]`, `p-[5px]`) — across gap, padding, margin, and space-between.
 * Word values (`gap-sm`, `p-chip`, `mx-auto`) are NOT raw and are not this
 * rule's concern — exactly the `z-base` vs `z-10` distinction. Whether a word
 * value EXISTS is `space-ramp/no-dead-spacing`'s: the ramp has no margin
 * classes, so `mb-xs` is not raw but compiles to nothing.
 *
 * No auto-fix: picking a role (and whether to restructure a margin into a
 * Stack gap / Inset pad) is a per-site judgement.
 *
 * Class strings are inspected only in a class-name context — a `className`/
 * `class`/`*ClassName` attribute value or a `cn(...)`/`clsx(...)`/`twMerge(...)`
 * argument — via the same `collectTokens` walk the sibling `no-adhoc-*` rules
 * use, so a doc-string that merely mentions `gap-2` is never flagged.
 */

// Raw spacing utilities: a numeric step (`-2`, `-0.5`) or an arbitrary value
// (`-[7px]`). A raw value is a pure number (optionally fractional); a NAMED ramp
// step is a word — even the two that begin with a digit (`2xs`, `2xl`). So we
// can't just test "starts with a digit": that misfires on `gap-2xs`/`p-2xl`.
// Instead, match digits NOT immediately followed by a letter (the `(?![a-z])`
// guard) — so `gap-2`/`p-0.5`/`gap-2!` match while `gap-2xs`/`p-2xl` don't — or
// an arbitrary `[` (`p-[5px]`) or `(` (v4's `p-(--x)` var shorthand). Letter-led steps (`gap-sm`, `p-md`, `mx-auto`) never match.
const GAP = /^gap(?:-[xy])?-(?:\d+(?:\.\d+)?(?![a-z])|[[(])/;
const PAD = /^p[xytrbl]?-(?:\d+(?:\.\d+)?(?![a-z])|[[(])/;
const MARGIN = /^m[xytrbl]?-(?:\d+(?:\.\d+)?(?![a-z])|[[(])/;
const SPACE = /^space-[xy]-(?:\d+(?:\.\d+)?(?![a-z])|[[(])/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-spacing",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow raw Tailwind spacing (gap-/p-/m-/space- numerics and arbitrary values). Set layout spacing through <Stack gap>/<Inset pad> or the named *-<step> density utilities.",
      },
      schema: [],
      messages: {
        adhocSpacing:
          "Raw spacing class `{{token}}` is banned — set layout spacing through the " +
          "<Stack gap> / <Inset pad> primitives from @plugins/primitives/plugins/css/plugins/spacing/web, " +
          "or a `gap-<step>` / `p*-<step>` utility (none|2xs|xs|sm|md|lg|xl|2xl) from the density spacing scale. " +
          "Margins become a Stack gap or Inset pad — the ramp has no margin classes." +
          " To make ONE instance or region look different (a hero prompt, a featured card), wrap it in a sub-theme that sets the token (`defineSubTheme` + `ThemeEngine.SubTheme` + `<Theme name={subThemeScope(…)}>`, see plugins/ui/plugins/theme-engine/CLAUDE.md).",
      },
    },
    defaultOptions: [],
    create(context) {
      function checkTokens(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          const c = baseClass(token);
          if (GAP.test(c) || PAD.test(c) || MARGIN.test(c) || SPACE.test(c)) {
            context.report({
              node,
              messageId: "adhocSpacing",
              data: { token: c },
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
          checkTokens(node, tokens);
        },
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !CLASS_BUILDERS.has(node.callee.name)
          ) {
            return;
          }
          const tokens = new Set<string>();
          for (const arg of node.arguments)
            collectTokens(context.sourceCode, arg, tokens);
          checkTokens(node, tokens);
        },
      };
    },
  });
}
