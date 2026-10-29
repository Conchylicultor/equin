import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { McpHealth } from "@plugins/infra/plugins/mcp/core";

/**
 * The MCP server row's verdict, from what its own requests saw (`mcp.health`).
 *
 * - still loading → `unknown`, no summary ("Checking…"), never `ok`;
 * - the latest request failed → `critical`: agents launched from here have
 *   no equin tools (not even `flag_raise` to say so);
 * - a contribution's latest run threw → `attention`: the server answers, with
 *   that tool hidden or that instructions section replaced by a notice;
 * - otherwise `ok` — including before any agent connected, since a server
 *   nothing has asked has nothing wrong to report.
 */
export function mcpVerdict(result: ResourceResult<McpHealth>): HealthStatus {
  if (result.status === "loading") return { state: "unknown" };
  if (result.status === "error") {
    return {
      state: "unknown",
      summary: "Couldn't load the MCP server's status",
    };
  }
  const h = result.data;
  if (h.requests.kind === "failing") {
    return { state: "critical", summary: `Failing: ${h.requests.message}` };
  }
  const failing = h.degraded.length + h.degradedMore;
  if (failing > 0) {
    return {
      state: "attention",
      summary:
        failing === 1
          ? `Degraded: ${h.degraded[0]?.what ?? "a contribution"} fails`
          : `Degraded: ${failing} contributions fail`,
    };
  }
  return h.requests.kind === "none"
    ? { state: "ok", summary: "No agent has connected yet" }
    : { state: "ok", summary: "Answering agents" };
}
