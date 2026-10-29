import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import {
  useClaudeCodeHealth,
  useClaudeCodeStatus,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { useClaudeCodeSignInHealth } from "@plugins/infra/plugins/claude-cli/plugins/sign-in/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { claudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import {
  claudeUsage,
  errorStoppedConversations,
  sdkAgentProcesses,
} from "../../core";
import { claudeCodeRowVerdict } from "./claude-code-row";

/** The row's inputs: four pushed values, already resident, and the stopped conversations. */
export function useClaudeCodeRowInputs() {
  return combineResources({
    claude: useClaudeCodeStatus(),
    agents: useLive(sdkAgentProcesses),
    usage: useLive(claudeUsage),
    accounts: useLive(claudeAccounts),
    stopped: useLive(errorStoppedConversations),
  });
}

/** The health report's Claude Code row. */
export function useClaudeCodeRowHealth(): HealthStatus {
  // A minute's tick: a reached limit's "resets in" counts down, and the row
  // turns ok again once it resets.
  const now = useNow(60_000);
  // While the computer signs in from the row, its verdict says so.
  return claudeCodeRowVerdict(
    useClaudeCodeSignInHealth(useClaudeCodeHealth()),
    useClaudeCodeRowInputs(),
    now,
  );
}
