import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { combineResources } from "@plugins/primitives/plugins/live-state/web";
import { useClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/web";
import { sdkBundledCli } from "../../core";
import { cliDriftVerdict } from "./cli-drift";

/** The health report's Agent SDK row: two pushed scalars, already resident. */
export function useCliDriftHealth(): HealthStatus {
  return cliDriftVerdict(
    combineResources({
      claude: useClaudeCodeStatus(),
      sdk: useLive(sdkBundledCli),
    }),
  );
}
