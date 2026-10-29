import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Corner-radius guardrail.
 *
 * Corner radius must come from the token-driven `rounded-*` scale (`rounded-sm`,
 * `rounded-md`, `rounded-lg`, …), whose values resolve to the `--radius` shape
 * token so a Shape preset (Sharp / Rounded / Pill) re-softens every corner
 * together. Two shapes bypass that token and freeze a corner at a literal value:
 *
 *   A. bare `rounded` — Tailwind's static `0.25rem`, which does NOT read
 *      `--radius`, so no shape preset can move it (this is exactly the bug the
 *      `Row` primitive's bare `rounded` had: list rows stayed at 0.25rem under
 *      every preset).
 *   B. an arbitrary value `rounded-[…]` (e.g. `rounded-[2px]`) — a hand-pinned
 *      literal radius that likewise ignores the shape token.
 *
 * `rounded-none` and `rounded-full` are NOT flagged: they are intentional,
 * preset-independent shapes (a hard corner, a pill/circle). The named scale
 * steps (`rounded-sm/md/lg/xl/2xl/3xl`) are token-driven and allowed.
 *
 * This rule fires on ANY element (not just a host-tag subset): radius is set
 * everywhere, so the redirect to the token scale applies everywhere.
 *
 * No auto-fix: choosing the right scale step (or an intentional
 * `rounded-full`/`rounded-none`) is a design decision, unsafe to mechanize.
 *
 * Class strings appear in two shapes — bare JSX `className="…"` and inside
 * `cn(...)`/`clsx(...)`/template literals. We only inspect strings in a
 * class-name context (a `className`/`class`/`*ClassName` attribute value, or a
 * class-builder argument), via the same `collectTokens` walk the sibling
 * `no-adhoc-*` rules use, so a doc-string or fixture that merely mentions
 * `rounded` is never
 * flagged. The shared walk also resolves same-file object/array MAP aliases
 * indexed in a class context (e.g. a bare `rounded` in a style map reached via
 * `cn(MAP[key])`) — but NOT a bare string `const` (see the shared block below).
 */

// Bare `rounded` only — the static 0.25rem that bypasses --radius. Anchored with
// `$` so the named scale (`rounded-sm`, `rounded-md`, …), `rounded-none`, and
// `rounded-full` are intentionally OUT.
const BARE = /^rounded$/;
// Arbitrary value: `rounded-[…]` pins a literal radius that ignores --radius.
const ARBITRARY = /^rounded-\[/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-radius",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow bare `rounded` (static 0.25rem) and arbitrary `rounded-[…]` — set corner radius through the token-driven rounded-* scale.",
      },
      schema: [],
      messages: {
        adhocRadius:
          "Raw radius class `{{token}}` is banned — bare `rounded` is a static " +
          "0.25rem and `rounded-[…]` is a pinned literal, both bypassing the " +
          "`--radius` shape token. Use a token-driven scale step (`rounded-sm` / " +
          "`rounded-md` / `rounded-lg` / …) so Shape presets can re-soften it, or " +
          "`rounded-full` / `rounded-none` for an intentional fixed shape." +
          " To make ONE instance or region look different (a hero prompt, a featured card), wrap it in a sub-theme that sets the token (`defineSubTheme` + `ThemeEngine.SubTheme` + `<Theme name={subThemeScope(…)}>`, see plugins/ui/plugins/theme-engine/CLAUDE.md).",
      },
    },
    defaultOptions: [],
    create(context) {
      /** Report every banned class token in the harvested set. */
      function checkTokens(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          const c = baseClass(token);
          if (BARE.test(c) || ARBITRARY.test(c)) {
            context.report({
              node,
              messageId: "adhocRadius",
              data: { token: c },
            });
          }
        }
      }

      return {
        // className / class attribute values — `className="…"`,
        // `className={`…`}`, `className={cn(…)}`, etc., on ANY element.
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
        // Class-builder calls — `cn(...)`, `clsx(...)`, … — wherever they appear
        // (a `const cls = cn("rounded")` assigned outside JSX still counts).
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
