import { useLive } from "@plugins/network/plugins/live/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import { mcpHealth } from "@plugins/infra/plugins/mcp/core";
import { mcpVerdict } from "./mcp-health";

/** The health report's MCP server row. One subscription to a pushed value. */
export function useMcpHealth(): HealthStatus {
  return mcpVerdict(useLive(mcpHealth));
}
