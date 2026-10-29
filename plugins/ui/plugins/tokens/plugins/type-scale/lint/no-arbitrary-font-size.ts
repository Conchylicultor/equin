import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Arbitrary sub-12px font sizes (the `text-[<N>px]` / `text-[<N>rem]`
 * arbitrary-value classes) bypass the named typography scale and are the root
 * cause of the type-size sprawl the token system exists to close. This rule bans
 * them and redirects to the sub-scale (`text-3xs` / `text-2xs`) or a role. The
 * two sub-scale sizes (10px / 11px and their rem spellings) auto-fix; everything
 * else reports only — a 12px size is a ROLE (caption, control, …), which is a
 * semantic choice no fixer can make (and `text-xs` is itself banned by
 * `no-adhoc-typography`).
 *
 * Classes appear in two shapes:
 *   - bare JSX `className="… <class> …"` → string `Literal`
 *   - inside `cn("… <class> …", …)` and template literals → `Literal` +
 *     `TemplateElement`
 *
 * Crucially we only inspect strings that live in a *class-name context* — the
 * value of a `className`/`class` JSX attribute, or an argument to a `cn(...)` /
 * `clsx(...)` class-builder call. Scanning *every* string literal in the file
 * (as an earlier version did) produced false positives: a doc string, comment-
 * as-string, or test fixture that merely *mentions* `text-[10px]` would trip the
 * rule. The class-name scope mirrors the sibling `no-adhoc-*` rules
 * (`primitives/control-size`, `primitives/badge`, `primitives/row`), which use
 * the same `collectClassNodes` walk to harvest only class-name strings.
 */

// Two unit branches captured separately so the existing px fixer path is
// untouched: group 1 is the full token, group 2 the px digits (when px), group 3
// the rem number (when rem). Exactly one of group 2 / group 3 is set per match.
const BANNED = /(?:^|\s)(text-\[(?:(\d+)px|([\d.]+)rem)\])/g;

/**
 * Pixel size → named replacement for the two auto-fixable sub-scale steps. Keyed by the
 * numeric px value (not the literal `text-[Npx]` string) so this rule file does
 * not itself contain a banned class token — otherwise the rule would flag its
 * own source.
 */
const FIX_PX: Record<string, string> = {
  "10": "text-3xs",
  "11": "text-2xs",
};

/**
 * Rem size → named replacement for the on-scale rem steps. Keyed by the numeric
 * rem value (same self-reference avoidance as FIX_PX). Off-scale rem values
 * (e.g. 0.8rem, 0.65rem) are absent here and therefore report-only (fix: null),
 * matching the px off-scale behavior.
 */
const FIX_REM: Record<string, string> = {
  "0.625": "text-3xs",
  "0.6875": "text-2xs",
};

/**
 * Recursively collect the string-bearing nodes (`Literal` / `TemplateElement`)
 * reachable from a class-name value subtree, into `out`. Mirrors the
 * `collectTokens` structural-recursion the sibling `no-adhoc-*` rules use, but
 * collects the *nodes* (not split tokens) so the caller keeps each string's
 * exact source range for the auto-fixer.
 *
 * Handles the shapes a class-name realistically takes: a bare string literal, a
 * `JSXExpressionContainer` wrapping a template literal, a `cn(...)`/`clsx(...)`
 * call, ternaries/logical expressions, and arbitrary nesting thereof. The walk
 * is structural (visit every child node) rather than shape-specific, so it is
 * robust to however the class string is assembled — and, because it starts only
 * from class-name contexts, it never inspects unrelated string literals.
 */
function collectClassNodes(
  node: TSESTree.Node | null | undefined,
  out: TSESTree.Node[],
): void {
  if (!node) return;
  if (node.type === "Literal" || node.type === "TemplateElement") {
    out.push(node);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent") continue;
    const value = (node as unknown as Record<string, unknown>)[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && "type" in child) {
          collectClassNodes(child as TSESTree.Node, out);
        }
      }
    } else if (value && typeof value === "object" && "type" in value) {
      collectClassNodes(value as TSESTree.Node, out);
    }
  }
}

// Takes only the class-name ANCHORS from the toolkit, not the token walk: this
// rule reports the offending class NODE (for its autofix), so it collects nodes
// rather than strings — see `collectClassNodes` above.
export default function buildRule({
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-arbitrary-font-size",
    meta: {
      type: "problem",
      fixable: "code",
      docs: {
        description:
          "Disallow arbitrary text-[Npx] font sizes — use the named typography scale.",
      },
      schema: [],
      messages: {
        arbitraryFontSize:
          "text-[Npx] / text-[Nrem] arbitrary font sizes are banned — use the " +
          "sub-scale text-3xs (10px) / text-2xs (11px), or a role: <Text variant> " +
          "from @plugins/primitives/plugins/css/plugins/text/web (or its text-<role> " +
          "utility). The role ladder is closed (TYPE_ROLES in the text plugin's core); " +
          "a theme resizes a role, it never adds a size." +
          " To make ONE instance or region look different (a hero prompt, a featured card), wrap it in a sub-theme that sets the token (`defineSubTheme` + `ThemeEngine.SubTheme` + `<Theme name={subThemeScope(…)}>`, see plugins/ui/plugins/theme-engine/CLAUDE.md).",
      },
    },
    defaultOptions: [],
    create(context) {
      const sourceCode = context.sourceCode;

      /**
       * Report (and optionally fix) every banned class inside a node whose raw
       * source text occupies [rawStart, rawEnd). `text` is the string *value* the
       * class lives in; `rawStart` is the absolute offset where that value's raw
       * text begins in the source (i.e. just after the opening quote / backtick),
       * so a match at index `i` in `text` maps to `rawStart + i` in the file. We
       * fix by replacing only the matched token's exact range — never the whole
       * literal — so quotes, surrounding classes, and other matches are
       * untouched. Multiple matches in one literal each get their own report/fix.
       */
      function check(node: TSESTree.Node, text: string, rawStart: number) {
        for (const m of text.matchAll(BANNED)) {
          const token = m[1]!; // the matched arbitrary-value class
          const px = m[2]; // the px digits (e.g. 10) when the px branch matched
          const rem = m[3]; // the rem number (e.g. 0.8) when the rem branch matched
          // m.index points at the (?:^|\s) anchor; the token starts after any
          // leading whitespace the anchor consumed.
          const tokenStart = m.index + m[0].length - token.length;
          const absStart = rawStart + tokenStart;
          const absEnd = absStart + token.length;

          // Exactly one of px / rem is set per match. On-scale values in either map
          // auto-fix; off-scale values report only (replacement === undefined).
          const replacement =
            px !== undefined
              ? FIX_PX[px]
              : rem !== undefined
                ? FIX_REM[rem]
                : undefined;
          context.report({
            node,
            messageId: "arbitraryFontSize",
            loc: {
              start: sourceCode.getLocFromIndex(absStart),
              end: sourceCode.getLocFromIndex(absEnd),
            },
            fix: replacement
              ? (fixer) =>
                  fixer.replaceTextRange([absStart, absEnd], replacement)
              : null,
          });
        }
      }

      /**
       * Run `check()` on a string-bearing node harvested from a class-name
       * context, preserving the exact source-offset math the fixer relies on.
       */
      function checkClassNode(node: TSESTree.Node) {
        if (node.type === "Literal") {
          if (typeof node.value !== "string") return;
          // A string literal's raw text is `"…"` / `'…'`; the value starts one
          // char in (after the opening quote). Escapes would desync value vs raw
          // offsets, but Tailwind class strings contain none, and a misaligned
          // fix would simply not apply cleanly — never corrupt unrelated source.
          check(node, node.value, node.range[0] + 1);
        } else if (node.type === "TemplateElement") {
          // Template chunks expose `.raw` with its exact source; the raw text of a
          // TemplateElement starts one char after the element's range start
          // (after the opening `` ` `` or `}`).
          check(node, node.value.raw, node.range[0] + 1);
        }
      }

      return {
        // className / class attribute values — `className="…"`,
        // `className={`…`}`, `className={cn(…)}`, etc.
        JSXAttribute(node) {
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;
          const nodes: TSESTree.Node[] = [];
          collectClassNodes(node.value, nodes);
          for (const n of nodes) checkClassNode(n);
        },
        // Class-builder calls — `cn(...)`, `clsx(...)`, … — wherever they appear
        // (a `const cls = cn("text-[12px]")` assigned outside JSX still counts).
        CallExpression(node) {
          if (
            node.callee.type !== "Identifier" ||
            !CLASS_BUILDERS.has(node.callee.name)
          ) {
            return;
          }
          const nodes: TSESTree.Node[] = [];
          for (const arg of node.arguments) collectClassNodes(arg, nodes);
          for (const n of nodes) checkClassNode(n);
        },
      };
    },
  });
}
