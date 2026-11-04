import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-asset-path-read
 *
 * `ASSET_PATH` is the key an `AssetPath` / `AssetBase` / `ContentPath` holds
 * its `/api/…` path under. It sits on the endpoints core barrel only because
 * the browser loads `core/` as one artifact, so `endpoints/web`'s
 * `useAssetSrc` / `assetUrlOver` / `contentUrlOver` can read it. Read
 * anywhere else, it is a route's string on a page — handed to an element, it
 * loads from the PAGE's server, not the subtree's (a demo scope's worker): the
 * leak `research/2026-11-04-global-no-route-string-in-scoped-code.md` closes.
 *
 * Flags any import of `ASSET_PATH` through the endpoints barrel (`@plugins/
 * infra/plugins/endpoints/core`) outside test code. The endpoints plugin's own
 * modules import it by relative path, so they are not in the rule's sight.
 */

const createRule = lintRuleCreator(import.meta.url);

const ENDPOINTS_CORE = "@plugins/infra/plugins/endpoints/core";

/** Test code inspects an asset's path to assert on it. */
const TEST_CODE = /\/(__tests__|testing)\/|\.test\.tsx?$|\.spec\.tsx?$/;

export default createRule({
  name: "no-asset-path-read",
  meta: {
    type: "problem",
    docs: {
      description:
        "Never read ASSET_PATH outside the endpoints plugin — an element gets its src from useAssetSrc, a sink that loads by URL its URL from assetUrlOver.",
    },
    schema: [],
    messages: {
      assetPathRead:
        "ASSET_PATH is the endpoints plugin's own key: reading it hands out a route's string, which loads from the page's server inside a demo scope. " +
        "An element gets its src from useAssetSrc (or AssetThumbnail), a sink that loads by URL its URL from assetUrlOver / useAssetUrl " +
        "(@plugins/infra/plugins/endpoints/web).",
    },
  },
  defaultOptions: [],
  create(context) {
    if (TEST_CODE.test(context.filename)) return {};
    return {
      ImportDeclaration(node: TSESTree.ImportDeclaration) {
        if (node.source.value !== ENDPOINTS_CORE) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "ASSET_PATH"
          )
            context.report({ node: spec, messageId: "assetPathRead" });
          if (spec.type === "ImportNamespaceSpecifier")
            for (const ref of context.sourceCode
              .getDeclaredVariables(spec)
              .flatMap((v) => v.references)) {
              const parent = ref.identifier.parent;
              if (
                parent.type === "MemberExpression" &&
                parent.property.type === "Identifier" &&
                parent.property.name === "ASSET_PATH"
              )
                context.report({ node: parent, messageId: "assetPathRead" });
            }
        }
      },
    };
  },
});
