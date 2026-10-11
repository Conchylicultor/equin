import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * visible-range-minter
 *
 * A paged read (`useLive(c, query, { viewport })`) keeps live the pages near
 * its `viewport`, a branded `VisibleRange`. The brand only means something if the one thing
 * that MEASURES a viewport mints it: data-view, from the rows a DataView
 * draws (`useLivePagesPaging`). A range minted anywhere else is a viewport
 * nothing measures — left `measuring`, it keeps every page ever minted live
 * (no bound); spelled by hand, it releases pages a user is looking at.
 *
 * Flags every use of `mintVisibleRange` from network/live's web barrel: a
 * named import (aliases included), an `export { … } from` re-export, and a
 * read off a namespace import of the barrel (`m.mintVisibleRange`,
 * `m["mintVisibleRange"]`). data-view declares the one sanctioned exemption
 * in its `exempt/index.ts`; network/live's own tests reach the minter by
 * relative path.
 */

const BARREL = "@plugins/network/plugins/live/web";
const MINTER = "mintVisibleRange";

function propertyName(node: TSESTree.Node): string | null {
  if (node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string")
    return node.value;
  return null;
}

export default createRule({
  name: "visible-range-minter",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow minting a VisibleRange outside data-view — a paged read's viewport is what a DataView measures (useLivePagesPaging).",
    },
    schema: [],
    messages: {
      minter:
        "`mintVisibleRange` mints the viewport a paged read " +
        "(`useLive(c, query, { viewport })`) keeps its pages live by, which " +
        "only a DataView measures. Read the pages through data-view's " +
        "`useLivePagesPaging` (it calls `useLive` with the viewport the " +
        "DataView measures) and hand its `paging` to the DataView drawing " +
        "the rows; a list with no DataView reads `useLive(c, query)` with no " +
        "viewport (every page live, capped at `maxLimit`) — see " +
        "plugins/network/plugins/live/CLAUDE.md (Paged reads).",
    },
  },
  defaultOptions: [],
  create(context) {
    /** Locals bound to a namespace import of the barrel. */
    const namespaces = new Set<string>();
    return {
      ImportDeclaration(node) {
        if (node.source.value !== BARREL) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") {
            namespaces.add(spec.local.name);
          } else if (
            spec.type === "ImportSpecifier" &&
            propertyName(spec.imported) === MINTER
          ) {
            context.report({ node: spec, messageId: "minter" });
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== BARREL) return;
        for (const spec of node.specifiers) {
          if (propertyName(spec.local) === MINTER) {
            context.report({ node: spec, messageId: "minter" });
          }
        }
      },
      MemberExpression(node) {
        if (
          node.object.type !== "Identifier" ||
          !namespaces.has(node.object.name)
        ) {
          return;
        }
        const name =
          node.computed && node.property.type !== "Literal"
            ? null
            : propertyName(node.property);
        if (name === MINTER) context.report({ node, messageId: "minter" });
      },
    };
  },
});
