import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Whether an object-expression argument carries a `strings: false` property —
 * the `maskSource` option that KEEPS string interiors visible. Handles the
 * property value being a plain `Literal` with value `false` (the only shape
 * `maskSource`'s option accepts).
 */
function stringsFalseProp(arg: TSESTree.Node): TSESTree.Property | null {
  if (arg.type !== "ObjectExpression") return null;
  for (const p of arg.properties) {
    if (p.type !== "Property") continue;
    const key = p.key;
    const name =
      key.type === "Identifier"
        ? key.name
        : key.type === "Literal" && typeof key.value === "string"
          ? key.value
          : null;
    if (name !== "strings") continue;
    if (p.value.type === "Literal" && p.value.value === false) return p;
  }
  return null;
}

export default createRule({
  name: "no-adhoc-marker-scan",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `maskSource(src, { strings: false })` — keeping string " +
        "interiors makes a marker call written inside a string match as real. " +
        "Route marker-value scans through `findMarkerCalls` (full-mask + " +
        "read-by-offset).",
    },
    schema: [],
    messages: {
      adhocMarkerScan:
        "Keeping string interiors (`maskSource(src, { strings: false })`) means " +
        'a `defineX("id")` / value written INSIDE a string or template literal ' +
        "is matched as a real call — a silent false positive (a test fixture, a " +
        "docs snippet, a codegen template). Route marker-value scans through " +
        '`findMarkerCalls(src, "defineX")` (or ' +
        "`markerCallSpans(maskSource(src), …)`): mask FULLY and read the value " +
        "back from the original by offset. `{ strings: false }` is allowed ONLY " +
        "for a genuine token-in-string scan (a URL/MIME/path that legitimately " +
        "lives in a string with NO enclosing marker call — prefer " +
        "`grepCode({ maskStrings: false })`), and that scanner must be " +
        "declared in its plugin's `exempt/index.ts`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      CallExpression(node) {
        if (node.callee.type !== "Identifier") return;
        if (node.callee.name !== "maskSource") return;
        for (const arg of node.arguments) {
          const prop = stringsFalseProp(arg);
          if (prop) {
            context.report({ node: prop, messageId: "adhocMarkerScan" });
            return;
          }
        }
      },
    };
  },
});
