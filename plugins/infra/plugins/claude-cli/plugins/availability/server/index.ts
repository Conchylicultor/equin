import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export {
  assertClaudeCodeReady,
  checkClaudeCode,
  ClaudeCodeUnavailableError,
  noteClaudeCodeFailure,
  onClaudeCodeProbed,
  onClaudeCodeReady,
  requireClaudeBin,
} from "./internal/status";

export default {
  description:
    "Claude Code availability: probes whether the user's Claude Code CLI is installed and signed in (`claude --version` + `claude auth status --json`, under the agent panes' host env; the machine half serves the answer as the claude-code-status push value and POST /api/claude-code/recheck) and gives every launch path assertClaudeCodeReady() and requireClaudeBin() — so an agent that cannot run is refused up front with the fix, never started as `command not found`. onClaudeCodeProbed hands every fresh answer to work keyed off the installed CLI's version.",
} satisfies ServerPluginDefinition;
