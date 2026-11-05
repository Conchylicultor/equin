import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const RESVG_MODULE = "@resvg/resvg-js";

function propertyNamed(
  obj: TSESTree.ObjectExpression,
  name: string,
): TSESTree.Property | undefined {
  for (const p of obj.properties) {
    if (p.type !== "Property" || p.computed) continue;
    const key =
      p.key.type === "Identifier"
        ? p.key.name
        : p.key.type === "Literal"
          ? String(p.key.value)
          : null;
    if (key === name) return p;
  }
  return undefined;
}

/** `{ …, font: { …, loadSystemFonts: false } }`, written inline. */
function turnsSystemFontsOff(arg: TSESTree.Node | undefined): boolean {
  if (arg?.type !== "ObjectExpression") return false;
  const font = propertyNamed(arg, "font")?.value;
  if (font?.type !== "ObjectExpression") return false;
  const load = propertyNamed(font, "loadSystemFonts")?.value;
  return load?.type === "Literal" && load.value === false;
}

/**
 * Requires every `new Resvg(svg, options)` to say `font: { loadSystemFonts:
 * false }`. resvg-js loads system fonts by default: each construction
 * enumerates and parses every font file the machine has, whether or not the
 * SVG draws a single glyph of text. Measured 2026-11-05: 105 ms per render with
 * the font files cached, 3.5 s cold, against 0.1–0.3 ms without. It ran on
 * main's event loop for every app-icon PNG after each restart (the
 * `Resvg ← appIconPng` event-loop stall, 18 a day). An SVG that does draw
 * text names its fonts with `font.fontFiles`, so a render reads those, not
 * the system's.
 */
export default createRule({
  name: "no-resvg-system-fonts",
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `font: { loadSystemFonts: false }` on every `new Resvg(…)` — the default parses every system font file per render.",
    },
    schema: [],
    messages: {
      systemFonts:
        "`new Resvg` loads every system font by default, parsing each font file on the machine at every " +
        "construction (105 ms warm, seconds cold, for an SVG that may draw no text). Pass " +
        "`font: { loadSystemFonts: false }` inline in the options; if the SVG draws text, name its fonts " +
        "with `font.fontFiles`.",
    },
  },
  defaultOptions: [],
  create(context) {
    const resvgNames = new Set<string>();
    // `import * as r from "@resvg/resvg-js"` → `new r.Resvg(…)`.
    const namespaces = new Set<string>();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== RESVG_MODULE) return;
        for (const s of node.specifiers) {
          if (s.type === "ImportNamespaceSpecifier")
            namespaces.add(s.local.name);
          if (
            s.type === "ImportSpecifier" &&
            s.imported.type === "Identifier" &&
            s.imported.name === "Resvg"
          ) {
            resvgNames.add(s.local.name);
          }
        }
      },
      NewExpression(node) {
        const c = node.callee;
        const isResvg =
          (c.type === "Identifier" && resvgNames.has(c.name)) ||
          (c.type === "MemberExpression" &&
            c.object.type === "Identifier" &&
            namespaces.has(c.object.name) &&
            c.property.type === "Identifier" &&
            c.property.name === "Resvg");
        if (!isResvg) return;
        if (turnsSystemFontsOff(node.arguments[1])) return;
        context.report({ node, messageId: "systemFonts" });
      },
    };
  },
});
