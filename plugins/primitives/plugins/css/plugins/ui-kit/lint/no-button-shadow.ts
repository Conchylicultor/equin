import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";
import type { LintToolkit } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * A shadow on a Button says "this floats over content". A float needs a solid
 * fill, and most button variants do not have one: `outline` is `input/30` in
 * dark mode, and `ghost` / `frame` / `dashed` have no fill at all. So a
 * `className="shadow-md"` on a bordered button came out see-through, and
 * whatever ran underneath showed behind its label.
 *
 * `variant="floating"` is the one floating button: the solid overlay fill plus
 * its own shadow. This rule reports any `shadow-*` in the class names of a
 * `<Button>` / `<IconButton>`, so the elevation can only come with that fill.
 * `shadow-none` is not an elevation and passes.
 */
const BUTTONS = new Set(["Button", "IconButton"]);
// elevation shadow: `shadow`, `shadow-2xs`…`shadow-2xl`, `shadow-[…]`
// (NOT shadow-none/inner or a shadow colour like `shadow-black/20`).
const SHADOW = /^shadow(-(2xs|xs|sm|md|lg|xl|2xl|\[.*\]))?$/;

export default function buildRule({
  collectTokens,
  baseClass,
  CLASS_ATTRS,
}: LintToolkit) {
  return createRule({
    name: "no-button-shadow",
    meta: {
      type: "problem",
      docs: {
        description:
          'Disallow a shadow on a Button/IconButton. A floating button uses variant="floating", which pairs the shadow with a solid fill.',
      },
      schema: [],
      messages: {
        buttonShadow:
          "`{{token}}` on a `<{{name}}>`: a shadow means the button floats over content, and " +
          'most variants are see-through there. Use `variant="floating"` instead, which ' +
          "paints a solid overlay fill and carries its own shadow.",
      },
    },
    defaultOptions: [],
    create(context) {
      return {
        JSXAttribute(node: TSESTree.JSXAttribute) {
          if (
            node.name.type !== "JSXIdentifier" ||
            !CLASS_ATTRS.test(node.name.name)
          )
            return;
          const opening = node.parent;
          if (
            opening.type !== "JSXOpeningElement" ||
            opening.name.type !== "JSXIdentifier" ||
            !BUTTONS.has(opening.name.name)
          )
            return;
          const tokens = new Set<string>();
          collectTokens(context.sourceCode, node.value, tokens);
          for (const t of tokens) {
            if (SHADOW.test(baseClass(t))) {
              context.report({
                node,
                messageId: "buttonShadow",
                data: { token: t, name: opening.name.name },
              });
              return;
            }
          }
        },
      };
    },
  });
}
