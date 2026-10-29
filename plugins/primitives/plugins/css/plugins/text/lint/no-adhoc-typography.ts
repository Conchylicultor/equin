import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Typographic-hierarchy guardrail.
 *
 * Text hierarchy must come from ONE closed set of semantic roles — the `<Text
 * role>` primitive (`@plugins/primitives/plugins/css/plugins/text/web`), whose roles map to
 * the `text-<role>` `@utility` bundles backed by the typography token group.
 * Hand-writing a raw named font size (`text-sm`, `text-xl`, …) or a raw
 * `leading-*` line-height reintroduces the per-call type sprawl the role set
 * exists to close, and only repaints color on flat bones when a theme swaps.
 *
 * This rule fires on ANY element (not just a host-tag subset): typography is set
 * everywhere, so the redirect to `<Text>` applies everywhere.
 *
 * Two banned shapes, after stripping variant prefixes:
 *
 *   A. `SIZE` — a NAMED font-size step `text-{xs,sm,base,lg,xl,2xl…9xl}`. This is
 *      deliberately narrow: it must NOT match color classes (`text-muted-
 *      foreground`, `text-primary-text`) nor the sanctioned sub-scale `text-2xs` /
 *      `text-3xs` (chips/badges, below role granularity). The `\d` boundary on
 *      `[2-9]xl` and the lack of a `2xs`/`3xs` alternative guarantee both.
 *
 *   B. `LEADING` — any raw `leading-*` line-height (role bundles own the
 *      line-height; a standalone `leading-*` overrides it ad-hoc).
 *
 * No auto-fix: choosing the right role + tone + `as` is a semantic decision,
 * unsafe to mechanize.
 *
 * Class strings appear in two shapes — bare JSX `className="…"` and inside
 * `cn(...)`/`clsx(...)`/`cva(...)`/template literals (a `cva` table's base and
 * variant values are classes; its variant names and `defaultVariants` are not).
 * The `type-scale:closed-role-ladder` check fails if the message below stops
 * naming a `<Text>` variant. We only inspect strings in a
 * class-name context (a `className`/`class`/`*ClassName` attribute value, or a
 * class-builder argument), via the same `collectTokens` walk the sibling
 * `no-adhoc-*` rules use, so a doc-string or fixture that merely mentions
 * `text-sm` is never
 * flagged. The shared walk also resolves same-file object/array MAP aliases
 * indexed in a class context (e.g. a `text-sm` in a tone/style map reached via
 * `cn(TONE[tone])`) — but NOT a bare string `const` (see the shared block below).
 */

// Named font-size step only: text-xs/sm/base/lg/xl and text-2xl…text-9xl.
// The `2xs`/`3xs` sub-scale and color classes (text-muted-foreground, …) are
// intentionally OUT — the alternation lists only size steps and anchors with $.
const SIZE = /^text-(?:xs|sm|base|lg|xl|[2-9]xl)$/;
// Any raw line-height utility.
const LEADING = /^leading-/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-adhoc-typography",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow raw named font sizes (text-xs/sm/base/lg/xl/…) and leading-* — set text hierarchy through the <Text variant> primitive.",
      },
      schema: [],
      messages: {
        adhocTypography:
          "Raw typography class `{{token}}` is banned — set text hierarchy through " +
          "the <Text variant> primitive from @plugins/primitives/plugins/css/plugins/text/web " +
          "(variants: display | title | heading | subheading | body | label | group | " +
          "control | caption | tag | code | eyebrow | count), or its `text-<role>` utility. Below " +
          "role granularity the sub-scale is text-2xs / text-3xs (times, chip internals).",
      },
    },
    defaultOptions: [],
    create(context) {
      /** Report every banned class token in the harvested set. */
      function checkTokens(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          const c = baseClass(token);
          if (SIZE.test(c) || LEADING.test(c)) {
            context.report({
              node,
              messageId: "adhocTypography",
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
        // (a `const cls = cn("text-sm")` assigned outside JSX still counts).
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
