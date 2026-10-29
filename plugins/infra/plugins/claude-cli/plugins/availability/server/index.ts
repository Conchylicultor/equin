import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  assertClaudeCodeReady,
  checkClaudeCode,
  ClaudeCodeUnavailableError,
  noteClaudeCodeFailure,
  onClaudeCodeProbed,
  onClaudeCodeReady,
  recheckClaudeCodeNow,
} from "./internal/status";

export default {
  description:
    "Claude Code availability: probes whether the computer is signed in to Claude Code (the build the Agent SDK ships — one session on the computer's own login reading its initialize answer: version and account, no turn; the machine half serves the answer as the claude-code-status push value and POST /api/claude-code/recheck) and gives every launch path assertClaudeCodeReady() — so an agent that cannot run is refused up front, pointing at the in-app sign-in. onClaudeCodeProbed hands every fresh answer to work keyed off the Claude Code version (which moves only with an SDK upgrade).",
} satisfies ServerPluginDefinition;
