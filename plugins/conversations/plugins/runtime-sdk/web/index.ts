import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { HealthReport } from "@plugins/shell/plugins/health-report/web";
import { ClaudeCodeActions } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { ClaudeCodeSignInRemedy } from "@plugins/infra/plugins/claude-cli/plugins/sign-in/web";
import { autoResumeConfig } from "../core";
import { ClaudeCodeRowDetail } from "./components/claude-code-row";
import { ClaudeUsageGlance } from "./components/claude-usage-glance";
import { useClaudeCodeRowHealth } from "./internal/use-claude-code-row";

export default {
  description:
    "The health report's Claude Code row: Claude Code itself (critical while the computer is signed out, with the in-app Sign in — claude-cli/sign-in, 'Signing in…' while it runs — and Check again), the agent processes running — here, and in every other worktree (each as its task's chip) — the active Claude account's usage limits as meters (the week collapsed, the session too expanded; attention while its limit is reached), and the Claude account picker (each account's weekly room, add — signing in to another account in the app, or an API key — / remove / switch, auto-switch, auto-resume when a limit resets, Continue on another account when the active one is limited).",
  contributions: [
    HealthReport.Row({
      kind: "status",
      id: "claude-code",
      title: "Claude Code",
      useStatus: useClaudeCodeRowHealth,
      actions: ClaudeCodeActions,
      remedy: ClaudeCodeSignInRemedy,
      glance: ClaudeUsageGlance,
      component: ClaudeCodeRowDetail,
    }),
    ConfigV2.WebRegister({ descriptor: autoResumeConfig }),
  ],
} satisfies PluginDefinition;
