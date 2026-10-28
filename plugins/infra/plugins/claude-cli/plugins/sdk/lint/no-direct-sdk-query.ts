import { ESLintUtils } from "@typescript-eslint/utils";

const createRule = ESLintUtils.RuleCreator(
  (name) => `https://github.com/anthropics/singularity/lint/${name}`,
);

/**
 * no-direct-sdk-query
 *
 * Every Claude Code session opens through `claudeQuery`
 * (`@plugins/infra/plugins/claude-cli/plugins/sdk/server`), which takes a
 * `ClaudeSessionEnv` — the environment for the account its caller chose. A
 * bare `query()` from the Agent SDK skips that choice: it runs on whatever
 * login the inherited environment happens to name, which is how every one-shot
 * generation once ran on the computer's own (full) account after the user
 * switched to another.
 *
 * Flags a value import of `query` (or the SDK's session constructors) from
 * `@anthropic-ai/claude-agent-sdk`. Type imports are fine.
 */

const SDK_MODULES = new Set([
  "@anthropic-ai/claude-agent-sdk",
  "@anthropic-ai/claude-agent-sdk/core",
]);
const SESSION_OPENERS = new Set([
  "query",
  "unstable_v2_createSession",
  "unstable_v2_resumeSession",
  "unstable_v2_prompt",
]);

export default createRule({
  name: "no-direct-sdk-query",
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow opening an Agent SDK session directly — use claudeQuery, which runs on the account its caller chose.",
    },
    schema: [],
    messages: {
      direct:
        "`{{name}}` opens a Claude Code session on no particular account. Use " +
        "claudeQuery({ env: await claudeSessionEnv(account), bin, prompt, options }) " +
        "from @plugins/infra/plugins/claude-cli/plugins/sdk/server.",
    },
  },
  defaultOptions: [],
  create(context) {
    return {
      ImportDeclaration(node) {
        if (!SDK_MODULES.has(node.source.value)) return;
        if (node.importKind === "type") return;
        for (const spec of node.specifiers) {
          if (spec.type === "ImportNamespaceSpecifier") {
            context.report({
              node: spec,
              messageId: "direct",
              data: { name: "import * as" },
            });
            continue;
          }
          if (spec.type !== "ImportSpecifier") continue;
          if (spec.importKind === "type") continue;
          const name =
            spec.imported.type === "Identifier"
              ? spec.imported.name
              : spec.imported.value;
          if (SESSION_OPENERS.has(name))
            context.report({ node: spec, messageId: "direct", data: { name } });
        }
      },
    };
  },
});
