import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { mcpCatalogServed } from "./internal/catalog";
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
    "HTTP MCP server endpoint. Hosts tools contributed by other plugins via Mcp.tool, and serves the mcp.catalog live value: every tool, instructions section and the scope resolver with the plugin that declared each, each tool's input schema as tools/list sends it.",
  loadBearing: true,
  httpRoutes: {
    [mcpRequest.route]: handleMcpRequest,
  },
  contributions: [...mcpCatalogServed.declare],
} satisfies ServerPluginDefinition;
