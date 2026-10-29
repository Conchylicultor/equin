import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

const PLUGIN_TREE_CORE = "@plugins/plugin-meta/plugins/plugin-tree/core";

/** The uncached builder — every call walks and parses the whole plugin tree. */
const BUILDER_NAME = "buildPluginTree";

/**
 * Check code: a file under a `check/` directory that sits DIRECTLY under a plugin
 * directory (the folder `./equin check` discovers checks from — the same
 * segment-by-segment spelling the thread watch uses, so a plugin NAMED `check`
 * does not match), or the check runner's own `checks/core/`.
 */
const CHECK_CODE = [
  /(?:^|\/)plugins\/(?:[^/]+\/plugins\/)*[^/]+\/check\//,
  /(?:^|\/)plugins\/framework\/plugins\/tooling\/plugins\/checks\/core\//,
];

export default createRule({
  name: "no-uncached-tree-in-checks",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow calling buildPluginTree() from check code — a check reads the " +
        "process-shared tree instead.",
    },
    schema: [],
    messages: {
      uncachedTree:
        "A check pass runs ~100 checks on ONE JS thread, so a check that calls " +
        "buildPluginTree() itself rebuilds a tree the run has already built — six " +
        "checks used to do exactly that, back to back. Read the shared one: " +
        "buildStructureTreeOnce(pluginsRoot) from the same barrel for the structure " +
        "(paths, ids, runtimes, descriptions), or buildBarrelFreeTree(root) / " +
        "buildEnrichedTree(root) from the codegen core barrel when you need facets. " +
        "Type-only imports are allowed.",
    },
  },
  defaultOptions: [],
  create(context) {
    const filename = context.filename.split("\\").join("/");
    if (!CHECK_CODE.some((re) => re.test(filename))) return {};

    // Local names bound to `import * as tree from "…/plugin-tree/core"`.
    const nsLocals = new Set<string>();

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return;
        if (node.source.value !== PLUGIN_TREE_CORE) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportSpecifier") {
            if (spec.importKind === "type") continue;
            if (
              spec.imported.type === "Identifier" &&
              spec.imported.name === BUILDER_NAME
            ) {
              context.report({ node: spec, messageId: "uncachedTree" });
            }
          } else if (spec.type === "ImportNamespaceSpecifier") {
            nsLocals.add(spec.local.name);
          }
        }
      },
      MemberExpression(node: TSESTree.MemberExpression) {
        if (node.object.type !== "Identifier") return;
        if (!nsLocals.has(node.object.name)) return;
        const prop =
          node.property.type === "Identifier"
            ? node.property.name
            : node.property.type === "Literal" &&
                typeof node.property.value === "string"
              ? node.property.value
              : null;
        if (prop === BUILDER_NAME) {
          context.report({ node, messageId: "uncachedTree" });
        }
      },
    };
  },
});
