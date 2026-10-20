import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import {
  ClaudeCodeActions,
  ClaudeCodeDetail,
  RecheckOnReturn,
} from "./components/claude-code-row";
import { useClaudeCodeHealth } from "./internal/use-claude-code";

export {
  useClaudeCodeStatus,
  useClaudeCodeLaunchBlock,
} from "./internal/use-claude-code";

export default {
  description:
    "Claude Code availability, shown: the health report's Claude Code row (critical while the CLI is missing or signed out, with the install / sign-in commands and Check again), useClaudeCodeLaunchBlock() for launch controls to disable themselves with the fix, and a re-check when the user returns to the window while it is blocked.",
  contributions: [
    Core.Root({ component: RecheckOnReturn }),
    HealthReport.Row({
      kind: "status",
      id: "claude-code",
      title: "Claude Code",
      // Before Connection (10): "can this app run an agent at all" is the
      // first thing a new user needs answered.
      order: 5,
      useStatus: useClaudeCodeHealth,
      actions: ClaudeCodeActions,
      component: ClaudeCodeDetail,
    }),
  ],
} satisfies PluginDefinition;
