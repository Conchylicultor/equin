import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The Maps JavaScript API libraries page code may load: what drawing a map
 * takes. Never `places` (or `geocoding`, `routes`, …): those call Google's
 * other APIs from the page with the public browser key — the website's demo
 * included — where the key is for drawing the map only, and every place
 * lookup is the computer's (`google-maps/places-api`, `machine/`).
 */
const ALLOWED = new Set(["core", "maps", "marker"]);

/** A string literal's value, or null when it is not one. */
function literal(node: TSESTree.Node | undefined): string | null {
  if (node?.type === "Literal" && typeof node.value === "string")
    return node.value;
  if (
    node?.type === "TemplateLiteral" &&
    node.expressions.length === 0 &&
    node.quasis.length === 1
  )
    return node.quasis[0]!.value.cooked;
  return null;
}

function calleeName(callee: TSESTree.Expression): string | null {
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  )
    return callee.property.name;
  return null;
}

export default createRule({
  name: "maps-js-libraries",
  meta: {
    type: "problem",
    docs: {
      description:
        "Page code loads only the Maps JavaScript API libraries that draw a map (core, maps, marker) — never places or another API's library.",
    },
    schema: [],
    messages: {
      library:
        "The Maps JavaScript API library {{name}} is not loaded from page code: only {{allowed}} (drawing the map). The browser key in a page is public — the website's demo hands visitors one restricted to the Maps JavaScript API — so a Places (or other API) call from the page is refused by design. Place lookups are the computer's: `google-maps/places-api` (machine/), behind a needsMachine endpoint.",
      dynamic:
        "Name the Maps JavaScript API library as a string literal ({{allowed}}), so which APIs page code reaches can be read.",
    },
  },
  defaultOptions: [],
  create(context) {
    const allowed = [...ALLOWED].join(", ");
    const check = (node: TSESTree.Node | undefined, at: TSESTree.Node) => {
      const name = literal(node);
      if (name === null) {
        context.report({ node: at, messageId: "dynamic", data: { allowed } });
      } else if (!ALLOWED.has(name)) {
        context.report({
          node: at,
          messageId: "library",
          data: { name: JSON.stringify(name), allowed },
        });
      }
    };
    return {
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name !== "useMapsLibrary" && name !== "importLibrary") return;
        check(node.arguments[0], node);
      },
      JSXAttribute(node) {
        if (
          node.name.type !== "JSXIdentifier" ||
          node.name.name !== "libraries"
        )
          return;
        const opening = node.parent;
        if (
          opening.name.type !== "JSXIdentifier" ||
          opening.name.name !== "APIProvider"
        )
          return;
        const value =
          node.value?.type === "JSXExpressionContainer"
            ? node.value.expression
            : undefined;
        if (value?.type !== "ArrayExpression") {
          context.report({ node, messageId: "dynamic", data: { allowed } });
          return;
        }
        for (const el of value.elements) {
          check(
            el === null || el.type === "SpreadElement" ? undefined : el,
            el ?? node,
          );
        }
      },
    };
  },
});
