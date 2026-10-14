import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { handleMcpRequest } from "./internal/handle-mcp";
import { mcpRequest } from "../shared/endpoints";

export { Mcp } from "./internal/mcp";
export type {
  McpInstructions,
  McpScope,
  McpScopeResolver,
  McpTool,
  McpToolContext,
  McpToolResult,
} from "./internal/mcp";

export default {
  description:
    "HTTP MCP server endpoint. Hosts tools contributed by other plugins via Mcp.tool.",
  loadBearing: true,
  httpRoutes: {
    [mcpRequest.route]: handleMcpRequest,
  },
} satisfies ServerPluginDefinition;
