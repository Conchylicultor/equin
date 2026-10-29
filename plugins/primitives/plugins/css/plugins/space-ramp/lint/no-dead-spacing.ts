import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";
// Relative, same-plugin: a lint rule file cannot import a runtime value through
// an `@plugins/*` specifier (jiti, which loads eslint.config.ts, does not
// resolve the alias).
import {
  isMarginFamily,
  parseSpacingClass,
  spacingClassExists,
} from "../core/internal/spacing-classes";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A spacing class must exist.
 *
 * A word-valued spacing utility (`mb-xs`, `gap-card`, `p-mdd`) emits CSS only
 * when app.css declares it as an `@utility` or Tailwind knows the word itself
 * (`mx-auto`, `p-px`, `space-x-reverse`). app.css defines no `--spacing-*` theme
 * key, so anything else is accepted by Tailwind's scanner and compiles to
 * NOTHING — no build error, no console warning, just a missing space the author
 * only notices by eye. Margins are the common case: the ramp deliberately has
 * no named margins, yet `mb-xs` reads exactly like the `pb-xs` that works.
 *
 * The declared set is the toolkit's `declaredUtilities`, read from app.css
 * when the lint config is built, so a new `@utility` is accepted the moment it
 * is declared — and app.css is a lint-cache trigger, so removing one re-lints
 * every file.
 *
 * Numeric and arbitrary values (`mt-4`, `gap-[7px]`) are left to
 * `spacing/no-adhoc-spacing`, which bans them with its own message.
 */
export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
  declaredUtilities,
}: LintToolkit) {
  return createRule({
    name: "no-dead-spacing",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow spacing classes (gap-/p-/m-/space- word values) that no @utility declares and Tailwind cannot resolve — they compile to nothing.",
      },
      schema: [],
      messages: {
        deadMargin:
          "`{{token}}` does not exist — it compiles to nothing. The spacing ramp deliberately " +
          "has no margin (`m*-`) or `space-*` classes: set the space as a gap on the parent " +
          "(<Stack gap> / `gap-<step>`) or as padding (<Inset pad> / `p*-<step>`) from " +
          "@plugins/primitives/plugins/css/plugins/spacing/web. `*-auto` and `*-px` are the " +
          "only word values these families have.",
        deadSpacing:
          "`{{token}}` does not exist — no @utility in app.css declares it and Tailwind has no " +
          "`{{value}}` value for `{{family}}-`, so it compiles to nothing. Use a ramp step " +
          "(none|2xs|xs|sm|md|lg|xl|2xl) or declare a role @utility in app.css.",
      },
    },
    defaultOptions: [],
    create(context) {
      function checkTokens(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          // `!` (important) may sit at either end in Tailwind v4.
          const c = baseClass(token).replace(/^!|!$/g, "");
          const parsed = parseSpacingClass(c);
          if (!parsed) continue;
          const { family, value } = parsed;
          // Numeric (`2`, `0.5`), arbitrary (`[7px]`, `(--x)`) and empty values
          // are no-adhoc-spacing's to judge; `2xs`/`2xl` are words and stay here.
          if (/^(?:\d+(?:\.\d+)?$|\[|\(|$)/.test(value)) continue;
          if (spacingClassExists(c, family, value, declaredUtilities)) {
            continue;
          }
          context.report({
            node,
            messageId: isMarginFamily(family) ? "deadMargin" : "deadSpacing",
            data: { token: c, family, value },
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
