import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import {
  useClaudeCodeHealth,
  useClaudeCodeStatus,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { claudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import { claudeUsage, sdkAgentProcesses, sdkBundledCli } from "../../core";
import { claudeCodeRowVerdict } from "./claude-code-row";

/** The row's inputs: five pushed values, already resident. */
export function useClaudeCodeRowInputs() {
  return combineResources({
    claude: useClaudeCodeStatus(),
    sdk: useLive(sdkBundledCli),
    agents: useLive(sdkAgentProcesses),
    usage: useLive(claudeUsage),
    accounts: useLive(claudeAccounts),
  });
}

/** The health report's Claude Code row. */
export function useClaudeCodeRowHealth(): HealthStatus {
  // A minute's tick: a reached limit's "resets in" counts down, and the row
  // turns ok again once it resets.
  const now = useNow(60_000);
  return claudeCodeRowVerdict(
    useClaudeCodeHealth(),
    useClaudeCodeRowInputs(),
    now,
  );
}
