import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  claudeAccountCredential,
  deleteClaudeAccountCredential,
  saveClaudeAccountCredential,
} from "./internal/tokens";
export { ActiveClaudeAccount, activeClaudeAccountId } from "./internal/active";
export type { ActiveClaudeAccountImpl } from "./internal/active";

export default {
  description:
    "The Claude accounts' credentials, every host's half: each added account's API key in the secrets store — saved, deleted, and read by the agent at its start (claudeAccountCredential: null for the computer's own Claude Code login, a loud error when an added account's secret is gone).",
} satisfies ServerPluginDefinition;
