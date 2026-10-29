import {
  MCP_SERVER_NAME,
  type McpHealth,
} from "@plugins/infra/plugins/mcp/core";

/**
 * The first turn of the agent the MCP server row's Investigate launches: what
 * the server's own requests saw, and where to look. Its own `equin` tools
 * ride the server under investigation, so it is told they may be missing.
 */
export function buildMcpInvestigatePrompt(
  health: McpHealth,
  host: string,
  extra: string,
): string {
  const parts = [
    `The health report's MCP server row says the \`${MCP_SERVER_NAME}\` MCP server (\`POST /api/mcp/:conversationId\`, plugins/infra/plugins/mcp) of the backend behind http://${host} is not healthy:`,
    "",
  ];
  if (health.requests.kind === "failing") {
    parts.push(
      `- Its latest request failed at ${new Date(health.requests.at).toISOString()}: ${health.requests.message}`,
    );
  }
  for (const d of health.degraded) {
    parts.push(
      `- ${d.what} threw at ${new Date(d.at).toISOString()}: ${d.message}`,
    );
  }
  if (health.degradedMore > 0) {
    parts.push(`- … and ${health.degradedMore} more contributions failing`);
  }
  parts.push(
    "",
    `Find the root cause and fix it structurally. Your own \`${MCP_SERVER_NAME}\` MCP tools go through this server, so they may be missing or fail — work from the backend's server log and Debug → Reports (the \`debug\` skill says where each is), and reproduce with \`./equin test plugins/infra/plugins/mcp\`. Then confirm the row reads healthy again.`,
  );
  const context = extra.trim();
  if (context) parts.push("", "## Context", "", context);
  return parts.join("\n");
}
