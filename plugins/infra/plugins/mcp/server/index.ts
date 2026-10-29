import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { rawEndpointHandler } from "@plugins/infra/plugins/endpoints/server";
import { mcpCatalogServed } from "./internal/catalog";
import { handleMcpRequest } from "./internal/handle-mcp";
import { mcpHealthServed } from "./internal/health";
import { mcpRequest } from "../core";

export { Mcp } from "./internal/mcp";
export type {
  McpInstructions,
  McpScope,
  McpScopeResolver,
  McpTool,
  McpToolCallContext,
  McpToolContext,
  McpToolResult,
} from "./internal/mcp";

export default {
  description:
    "HTTP MCP server endpoint. Hosts tools contributed by other plugins via Mcp.tool, and serves the mcp.catalog live value: every tool, instructions section and the scope resolver with the plugin that declared each, each tool's input schema as tools/list sends it; and the mcp.health push value: the latest request's outcome (failing on a throw or a 5xx) and every per-connection contribution whose latest run threw.",
  loadBearing: true,
  httpRoutes: {
    [mcpRequest.route]: rawEndpointHandler(mcpRequest, handleMcpRequest),
  },
  contributions: [...mcpCatalogServed.declare, ...mcpHealthServed.declare],
} satisfies ServerPluginDefinition;
