import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import { ESLintUtils, type TSESTree } from "@typescript-eslint/utils";
import { declaringPlugin } from "./sink-owner";

const createRule = lintRuleCreator(import.meta.url);

function prop(
  obj: TSESTree.ObjectExpression,
  name: string,
): TSESTree.Property | undefined {
  return obj.properties.find(
    (p): p is TSESTree.Property =>
      p.type === "Property" &&
      !p.computed &&
      p.key.type === "Identifier" &&
      p.key.name === name,
  );
}

/**
 * collector-from-matches
 *
 * A `ReportSinks.Collector({ from, collect: drain(sink, …) })` ships only
 * where plugin `from` ships (a companion keyed by it), so `from` must be the
 * plugin that really declares `sink`. Named wrong, the collector would ship
 * with a plugin it does not need and be missing where its producer runs.
 * The closure engine reads `from` as a literal, so it is spelled, and this
 * rule holds the spelling to the sink's declaration.
 *
 * Type-aware: on a `<X>.Collector({ … })` call carrying `from` and `collect`,
 * `collect` must be an inline `drain(<sink>, …)`, `from` a string literal, and
 * the literal the id of the plugin `<sink>`'s declaration lies in.
 */
export default createRule({
  name: "collector-from-matches",
  meta: {
    type: "problem",
    docs: {
      description:
        "ReportSinks.Collector's `from` is the id of the plugin declaring the sink its `collect: drain(sink, …)` drains.",
      requiresTypeChecking: true,
    },
    schema: [],
    messages: {
      shape:
        'Spell a collector as `ReportSinks.Collector({ from: "<plugin id>", collect: drain(<sink>, handler), companion: true })`: `from` a string literal and `collect` an inline `drain(…)` call — the closure engine and this rule read both statically.',
      mismatch:
        '`{{sink}}` is declared by plugin `{{owner}}`, not `{{from}}`: set `from: "{{owner}}"` so this collector ships exactly where its producer does.',
    },
  },
  defaultOptions: [],
  create(context) {
    const services = ESLintUtils.getParserServices(context);
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.computed ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "Collector"
        )
          return;
        const arg = node.arguments[0];
        if (arg?.type !== "ObjectExpression") return;
        const from = prop(arg, "from");
        const collect = prop(arg, "collect");
        if (!from || !collect) return;
        const call = collect.value;
        if (
          from.value.type !== "Literal" ||
          typeof from.value.value !== "string" ||
          call.type !== "CallExpression" ||
          call.callee.type !== "Identifier" ||
          call.callee.name !== "drain" ||
          !call.arguments[0] ||
          call.arguments[0].type === "SpreadElement"
        ) {
          context.report({ node, messageId: "shape" });
          return;
        }
        const sink = call.arguments[0];
        const owner = declaringPlugin(services, sink);
        if (owner === null) {
          context.report({ node: sink, messageId: "shape" });
          return;
        }
        if (owner === from.value.value) return;
        context.report({
          node: from.value,
          messageId: "mismatch",
          data: {
            sink: context.sourceCode.getText(sink),
            owner,
            from: from.value.value,
          },
        });
      },
    };
  },
});
