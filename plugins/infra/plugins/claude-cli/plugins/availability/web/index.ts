import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { RecheckOnReturn } from "./components/claude-code-row";

export {
  ClaudeCodeActions,
  ClaudeCodeDetail,
} from "./components/claude-code-row";
export {
  useClaudeCodeHealth,
  useClaudeCodeStatus,
  useClaudeCodeLaunchBlock,
} from "./internal/use-claude-code";

export default {
  description:
    "Claude Code availability, shown: the pieces of the health report's Claude Code row (useClaudeCodeHealth — critical while the CLI is missing or signed out — ClaudeCodeDetail with the install / sign-in commands, ClaudeCodeActions' Check again; the row itself is the sdk runtime's, which adds the Agent SDK and the running agents), useClaudeCodeLaunchBlock() for launch controls to disable themselves with the fix, and a re-check when the user returns to the window while it is blocked.",
  contributions: [Core.Root({ component: RecheckOnReturn })],
} satisfies PluginDefinition;
