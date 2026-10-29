import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { TSESTree } from "@typescript-eslint/utils";

/**
 * no-endpoint-effect-internals
 *
 * A predicted endpoint (`defineEndpoint({ …, effect })`) has exactly one
 * browser client, `network/live`'s `useLiveMutation`: `useEndpointMutation`
 * and `FetchEndpoint` refuse it (tsc), so no surface can await it behind a
 * spinner. Three endpoints-core exports are that client's plumbing and would
 * undo the split anywhere else:
 *
 * - `endpointContractOf(def)` — the def with its effect stripped, i.e. back
 *   to an awaitable contract;
 * - `brandEndpointEffect(payload)` — mints an effect whose payload
 *   `network/live` did not build (its builders are `patchRow` & co.);
 * - `endpointEffectPayload(effect)` — reads a payload whose shape only
 *   `network/live` owns.
 *
 * This rule flags any import of them from the endpoints core barrel (named,
 * aliased or re-exported) and any member read of them off a namespace import.
 * The one sanctioned importer is `network/live`, declared in its own
 * `exempt/index.ts`.
 */

const createRule = lintRuleCreator(import.meta.url);

const BARREL = "@plugins/infra/plugins/endpoints/core";
const INTERNALS = new Set([
  "endpointContractOf",
  "brandEndpointEffect",
  "endpointEffectPayload",
]);

function nameOf(node: TSESTree.Identifier | TSESTree.StringLiteral): string {
  return node.type === "Identifier" ? node.name : node.value;
}

export default createRule({
  name: "no-endpoint-effect-internals",
  meta: {
    type: "problem",
    docs: {
      description:
        "Restrict the predicted-endpoint plumbing (endpointContractOf, brandEndpointEffect, endpointEffectPayload) to network/live, the one client of a predicted endpoint.",
    },
    schema: [],
    messages: {
      internal:
        "`{{name}}` is the predicted-write client's plumbing (network/live): " +
        "a predicted endpoint is sent only through `useLiveMutation`, its " +
        "effect built only by live's `patchRow` / `removeRow` / `applyRows` / " +
        "`effects`. Use those instead.",
    },
  },
  defaultOptions: [],
  create(context) {
    const namespaces = new Set<string>();
    const report = (node: TSESTree.Node, name: string) =>
      context.report({ node, messageId: "internal", data: { name } });
    return {
      ImportDeclaration(node) {
        if (node.source.value !== BARREL) return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") {
            namespaces.add(spec.local.name);
          } else if (spec.type === "ImportSpecifier") {
            const name = nameOf(spec.imported);
            if (INTERNALS.has(name)) report(spec, name);
          }
        }
      },
      ExportNamedDeclaration(node) {
        if (node.source?.value !== BARREL) return;
        for (const spec of node.specifiers) {
          const name = nameOf(spec.local);
          if (INTERNALS.has(name)) report(spec, name);
        }
      },
      MemberExpression(node) {
        if (
          node.object.type === "Identifier" &&
          namespaces.has(node.object.name) &&
          !node.computed &&
          node.property.type === "Identifier" &&
          INTERNALS.has(node.property.name)
        ) {
          report(node, node.property.name);
        }
      },
    };
  },
});
