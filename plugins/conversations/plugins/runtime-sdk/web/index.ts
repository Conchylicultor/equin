import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { ClaudeCodeActions } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { ClaudeCodeRowDetail } from "./components/claude-code-row";
import { ClaudeUsageGlance } from "./components/claude-usage-glance";
import { useClaudeCodeRowHealth } from "./internal/use-claude-code-row";

export default {
  description:
    "The health report's Claude Code row: Claude Code itself (critical while missing or signed out, with the install / sign-in commands and Check again), attention when it differs in major.minor from the CLI version the pinned Agent SDK was built for, the agent processes running — here, and in every other worktree (each as its task's chip) — and the subscription's usage limits as meters (the week collapsed, the session too expanded; attention while a limit is reached).",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "claude-code",
      title: "Claude Code",
      // Before Connection (10): "can this app run an agent at all" is the
      // first thing a new user needs answered.
      order: 5,
      useStatus: useClaudeCodeRowHealth,
      actions: ClaudeCodeActions,
      glance: ClaudeUsageGlance,
      component: ClaudeCodeRowDetail,
    }),
  ],
} satisfies PluginDefinition;
