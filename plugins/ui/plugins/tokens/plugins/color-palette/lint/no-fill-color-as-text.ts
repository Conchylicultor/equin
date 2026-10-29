import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * `primary` is a FILL colour (every primary button, read with its
 * `primary-foreground` label on top). Used as text on a surface it needs the
 * palette's text twin, `primary-text`: on a dark surface no single value is
 * both dark enough for a near-white label at 4.5:1 and light enough to read at
 * 4.5:1 against the surface, so a theme with a deep primary sets the twin
 * lighter. A bare `text-primary` would paint the fill colour as text and go
 * unreadable under such a theme. (Status colours split the other way: they are
 * text first, and their fills are the `*-solid` tokens.)
 *
 * Flags the bare text-colour utility (any variant prefix, any opacity
 * modifier); `text-primary-foreground` and `text-primary-text` are untouched.
 */
const FILL_AS_TEXT = /^text-primary(\/\d+)?$/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
  CLASS_BUILDERS,
}: LintToolkit) {
  return createRule({
    name: "no-fill-color-as-text",
    meta: {
      type: "problem",
      docs: {
        description:
          "Disallow text-primary: text takes the palette's text twin (text-primary-text), the primary fill stays a fill.",
      },
      schema: [],
      messages: {
        fillAsText:
          "`{{token}}` paints the primary fill colour as text. Use `text-primary-text` (the palette's primaryText token), which a theme can lift for readability on its surface while `primary` stays the button fill.",
      },
    },
    defaultOptions: [],
    create(context) {
      function checkTokens(node: TSESTree.Node, tokens: Set<string>) {
        for (const token of tokens) {
          const c = baseClass(token);
          if (FILL_AS_TEXT.test(c)) {
            context.report({
              node,
              messageId: "fillAsText",
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
          )
            return;
          const tokens = new Set<string>();
          for (const arg of node.arguments)
            collectTokens(context.sourceCode, arg, tokens);
          checkTokens(node, tokens);
        },
      };
    },
  });
}
