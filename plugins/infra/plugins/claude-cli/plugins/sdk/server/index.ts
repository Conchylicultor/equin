import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { claudeQuery, claudeSessionEnv } from "./internal/session";
export type { ClaudeQueryInput, ClaudeSessionEnv } from "./internal/session";
export { ClaudeTurnError, runClaudeTurn } from "./internal/turn";
export type { ClaudeTurnResult } from "./internal/turn";
export {
  ClaudeInitializeTimeoutError,
  readClaudeInitialize,
} from "./internal/initialize";

export default {
  description:
    "The one way a backend opens a Claude Code session: through the Agent SDK, on an account its caller chose. claudeSessionEnv(account) is the environment (the host facts plus an added account's credential, through claudeCredentialEnv; branded, so no session skips the choice), claudeQuery opens the session, runClaudeTurn runs one prompt to its result under a real deadline, readClaudeInitialize reads the version, the signed-in account and the model menu without a turn. Its lint rules reject a direct query() and a spawn of the resolved claude binary anywhere else.",
} satisfies ServerPluginDefinition;
