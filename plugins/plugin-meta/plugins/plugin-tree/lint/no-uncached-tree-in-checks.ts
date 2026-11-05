import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * The uncached builders, by the barrel that exports them — every call walks
 * and parses the whole plugin tree (the faceted one runs every facet too).
 */
const BUILDERS = new Map<string, string>([
  ["@plugins/plugin-meta/plugins/plugin-tree/core", "buildPluginTree"],
  [
    "@plugins/plugin-meta/plugins/plugin-tree/plugins/faceted/core",
    "buildFacetedPluginTree",
  ],
]);

/**
 * Check code: a file under a `check/` directory that sits DIRECTLY under a plugin
 * directory (the folder `./equin check` discovers checks from — the same
 * segment-by-segment spelling the thread watch uses, so a plugin NAMED `check`
 * does not match), or the check runner's own `checks/core/`.
 */
const CHECK_FOLDER = /(?:^|\/)plugins\/(?:[^/]+\/plugins\/)*[^/]+\/check\//;
/** A path string, not a pattern, so plugin-meta/plugin-refs locates it. */
const CHECKS_CORE = "plugins/framework/plugins/tooling/plugins/checks/core";

function isCheckCode(filename: string): boolean {
  return (
    CHECK_FOLDER.test(filename) ||
    filename.startsWith(`${CHECKS_CORE}/`) ||
    filename.includes(`/${CHECKS_CORE}/`)
  );
}

export default createRule({
  name: "no-uncached-tree-in-checks",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling buildPluginTree() / buildFacetedPluginTree() from check code — a check reads the " +
        "process-shared tree instead.",
    },
    schema: [],
    messages: {
      uncachedTree:
        "A check pass runs ~100 checks on ONE JS thread, so a check that calls " +
        "buildPluginTree() or buildFacetedPluginTree() itself rebuilds a tree the run has already built — six " +
        "checks used to do exactly that, back to back. Read the shared one: " +
        "buildStructureTreeOnce(pluginsRoot) from the same barrel for the structure " +
        "(paths, ids, runtimes, descriptions), or buildBarrelFreeTree(pass) / " +
        "buildEnrichedTree(pass) from the codegen core barrel when you need facets " +
        "(the pass: codegenPassOver(await ctx.repo())). " +
        "Type-only imports are allowed.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename.split("\\").join("/");
    if (!isCheckCode(filename)) return {};

    // Local names bound to `import * as tree from "<a builder's barrel>"`, and
    // the builder that barrel exports.
    const nsLocals = new Map<string, string>();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        const builder = BUILDERS.get(node.source.value);
        if (builder === undefined) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (spec.importKind === "type") continue;
            if (
              spec.imported.type === "Identifier" &&
              spec.imported.name === builder
            ) {
              context.report({ node: spec, messageId: "uncachedTree" });
            }
          } else if (spec.type === "ImportNamespaceSpecifier") {
            nsLocals.set(spec.local.name, builder);
          }
        }
      },
      MemberExpression(node: TSESTree.MemberExpression) {
        if (node.object.type !== "Identifier") return;
        const builder = nsLocals.get(node.object.name);
        if (builder === undefined) return;
        const prop =
          node.property.type === "Identifier"
            ? node.property.name
            : node.property.type === "Literal" &&
                typeof node.property.value === "string"
              ? node.property.value
              : null;
        if (prop === builder) {
          context.report({ node, messageId: "uncachedTree" });
        }
      },
    };
  },
});
