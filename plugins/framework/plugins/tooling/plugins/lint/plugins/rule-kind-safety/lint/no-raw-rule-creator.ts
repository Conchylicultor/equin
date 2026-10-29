import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

/**
 * Every lint rule is made with lint/core's `lintRuleCreator(import.meta.url)`,
 * which derives the rule's docs URL from its own file on the published
 * repository and types its `meta.docs` as `LintRuleDocs`. A hand-made
 * `ESLintUtils.RuleCreator` writes the docs URL out, where it drifts (they all
 * once pointed at a repository that never existed), and leaves `meta.docs`
 * untyped, so `requiresTypeChecking` stops type-checking.
 */
export default createRule({
  name: "no-raw-rule-creator",
  meta: {
    type: "problem",
    docs: {
      description:
        "Lint rules are made with lintRuleCreator(import.meta.url) from lint/core, never ESLintUtils.RuleCreator.",
    },
    schema: [],
    messages: {
      raw: "Make the rule with `lintRuleCreator(import.meta.url)` from `@plugins/framework/plugins/tooling/plugins/lint/core`, not `ESLintUtils.RuleCreator`: it derives the docs URL from this file on the published repository (a hand-written one drifts) and types `meta.docs` as `LintRuleDocs`.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      MemberExpression(node) {
        if (
          !node.computed &&
          node.property.type === "Identifier" &&
          node.property.name === "RuleCreator"
        ) {
          context.report({ node, messageId: "raw" });
        }
      },
    };
  },
});
