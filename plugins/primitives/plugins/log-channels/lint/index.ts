import { lintRuleCreator } from "@plugins/framework/plugins/tooling/plugins/lint/core";
import type { LintContribution } from "@plugins/framework/plugins/tooling/plugins/lint/core";

const createRule = lintRuleCreator(import.meta.url);

const noConsoleLog = createRule({
  name: "no-console-log",
  meta: {
    type: "problem",
    docs: { description: "Disallow console.log; use Log.channel() instead." },
    schema: [],
    messages: {
      noConsole: "Use a structured logger instead of console.log.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      "CallExpression[callee.object.name='console'][callee.property.name='log']"(
        node,
      ) {
        context.report({ node, messageId: "noConsole" });
      },
    };
  },
});

export default {
  name: "log-channels",
  rules: { "no-console-log": noConsoleLog },
  /**
   * Globs where `no-console-log` is not enforced, keyed by rule id. The root
   * eslint.config.ts reads this generically and flips the rule off for these
   * paths — it never names this rule or these files itself.
   */
  outOfScope: {
    "no-console-log": ["script", "bin", "central", "provision", "cli"],
  },
} satisfies LintContribution;
