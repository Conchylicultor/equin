import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import {
  useClaudeCodeHealth,
  useClaudeCodeStatus,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { sdkAgentProcesses, sdkBundledCli } from "../../core";
import { claudeCodeRowVerdict } from "./claude-code-row";

/** The row's inputs: three pushed values, already resident. */
export function useClaudeCodeRowInputs() {
  return combineResources({
    claude: useClaudeCodeStatus(),
    sdk: useLive(sdkBundledCli),
    agents: useLive(sdkAgentProcesses),
  });
}

/** The health report's Claude Code row. */
export function useClaudeCodeRowHealth(): HealthStatus {
  return claudeCodeRowVerdict(useClaudeCodeHealth(), useClaudeCodeRowInputs());
}
