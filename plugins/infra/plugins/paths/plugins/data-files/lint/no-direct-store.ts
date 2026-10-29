import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { type TSESTree } from "@typescript-eslint/utils";

const createRule = lintRuleCreator(import.meta.url);

/**
 * no-direct-store
 *
 * `DataFiles` is the host service behind every declared file root. Reading it
 * directly (`DataFiles.get().root(spec)`) reaches ANY root by its spec — a root
 * another plugin owns, or one nobody declared and no host bound. A consumer
 * holds the `FileRoot` its own plugin declared with `defineFileRoot` instead,
 * which is the only handle on a data dir's files the ownership checks can see.
 *
 * Flags `X.get()` (and `ns.DataFiles.get()`) where `X` is `DataFiles` imported
 * from the data-files server barrel, aliases included. Inside the data-files
 * plugin the service is imported relatively (a root's own delegation), never
 * through the barrel, so the one sanctioned reader needs no exemption — and
 * every other plugin can only reach it through the barrel (import grammar).
 */

const BARREL = "@plugins/infra/plugins/paths/plugins/data-files/server";

export default createRule({
  name: "no-direct-store",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading the DataFiles host service outside the data-files plugin — use the FileRoot your plugin declared.",
    },
    schema: [],
    messages: {
      directStore:
        "Do not read DataFiles directly: it reaches every root by its spec. Use the FileRoot your plugin " +
        "declared with defineFileRoot (from " +
        BARREL +
        ") — its operations go through the host's provider.",
    },
  },
  defaultOptions: [],
  create(context) {
    const direct = new Set<string>();
    const namespaces = new Set<string>();

    const isGetOn = (
      node: TSESTree.CallExpression,
    ): TSESTree.Expression | null => {
      const callee = node.callee;
      if (callee.type !== "MemberExpression" || callee.computed) return null;
      if (callee.property.type !== "Identifier") return null;
      if (callee.property.name !== "get") return null;
      return callee.object;
    };

    return {
      ImportDeclaration(node) {
        if (node.source.value !== BARREL) return;
        for (const spec of node.specifiers) {
          if (
            spec.type === "ImportSpecifier" &&
            spec.imported.type === "Identifier" &&
            spec.imported.name === "DataFiles"
          ) {
            direct.add(spec.local.name);
          } else if (spec.type === "ImportNamespaceSpecifier") {
            namespaces.add(spec.local.name);
          }
        }
      },
      CallExpression(node) {
        const target = isGetOn(node);
        if (target === null) return;
        const hit =
          (target.type === "Identifier" && direct.has(target.name)) ||
          (target.type === "MemberExpression" &&
            !target.computed &&
            target.object.type === "Identifier" &&
            namespaces.has(target.object.name) &&
            target.property.type === "Identifier" &&
            target.property.name === "DataFiles");
        if (hit) context.report({ node, messageId: "directStore" });
      },
    };
  },
});
