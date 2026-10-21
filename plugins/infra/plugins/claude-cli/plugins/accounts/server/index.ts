import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  claudeAccountToken,
  deleteClaudeAccountToken,
  saveClaudeAccountToken,
} from "./internal/tokens";

export default {
  description:
    "The Claude accounts' tokens, every host's half: each token account's token in the secrets store — saved, deleted, and read by the agent at its start (claudeAccountToken: null for the computer's own Claude Code login, a loud error when a token account's secret is gone).",
} satisfies ServerPluginDefinition;
