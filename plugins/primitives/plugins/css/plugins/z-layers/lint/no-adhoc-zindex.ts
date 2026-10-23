import { ESLintUtils } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * Z-layer standardization guardrail.
 *
 * Stacking order must come from ONE ordered, named ladder: the semantic
 * `--z-*` scale defined in `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css`
 * and exposed as the `z-base / z-raised / z-nav / z-float / z-overlay / z-popover
 * / z-draw / z-max` `@utility` classes. A raw `z-<n>` / `z-[…]` value is opaque
 * intent — it can't say *which* layer it means — and scattering raw numbers
 * across call sites is how stacking bugs (a floating panel painting under a
 * sibling) creep back in.
 *
 * This rule fingerprints the escape hatch: any class-name token that is a raw
 * Tailwind z-index utility — built-in numerics (`z-0`…`z-50`) or arbitrary
 * values (`z-[60]`, `z-[9999]`). The named `z-<word>` utilities are NOT raw and
 * are intentionally allowed.
 *
 * No auto-fix: picking the right layer is a per-site judgement (same stance as
 * `no-adhoc-control`).
 */

// Raw z-index: a built-in numeric (`z-0`…`z-50`) or an arbitrary value
// (`z-[60]`, `z-[9999]`). The named utilities (`z-base`, `z-raised`, …) start
// with a letter after `z-`, so they never match.
const RAW_ZINDEX = /^z-(\d|\[)/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-zindex",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow raw z-index utilities (z-0…z-50, z-[…]). Stacking order must come from the semantic z-layer scale (z-raised, z-nav, z-float, z-overlay, z-popover, z-guide, z-draw, z-max).",
      },
      schema: [],
      messages: {
        adhocZindex:
          "Use a semantic z-layer utility (z-raised, z-nav, z-float, z-overlay, z-popover, z-guide, z-draw, z-max) from the z-layers scale instead of a raw z-index. See plugins/primitives/plugins/css/plugins/ui-kit/web/theme/app.css.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        // z-index is not element-specific — flag a raw z token on ANY element.
        JSXAttribute(node) {
          // Only class-name attributes (`className`/`class`, or a `*ClassName`
          // pass-through prop).
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;

          // Aggregate every class token of this attribute into one Set, stripping
          // variant prefixes so `hover:z-10` etc. count as their base.
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);

          const hasRawZindex = [...tokens].some((t) =>
            RAW_ZINDEX.test(baseClass(t)),
          );
          if (!hasRawZindex) return;

          context.report({ node, messageId: "adhocZindex" });
        },
      };
    },
  });
}
