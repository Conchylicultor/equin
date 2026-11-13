import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { machineHandler } from "@plugins/infra/plugins/endpoints/machine";
import { mcpCatalogServed } from "./internal/catalog";
import { handleMcpRequest } from "./internal/handle-mcp";
import { mcpHealthServed } from "./internal/health";
import { mcpRequest } from "../core";

export default {
  description:
    "The MCP server, desktop half: the POST /api/mcp/:conversationId route (a fresh stateless @modelcontextprotocol/sdk server per request, mounting every Mcp.tool in the conversation's scope, each per-connection contribution isolated — or, for the reserved id `unattached` (a session equin did not launch), only the tools declared unattached), the mcp.catalog live value (every tool with its input schema as tools/list sends it, and the scope resolver, with the plugin that declared each) and the mcp.health push value (the latest request's outcome and every contribution whose latest run threw). Desktop-only: agents run on the computer, and the SDK stays out of a browser host.",
  loadBearing: true,
  httpRoutes: {
    [mcpRequest.route]: machineHandler(mcpRequest, handleMcpRequest),
  },
  contributions: [...mcpCatalogServed.declare, ...mcpHealthServed.declare],
} satisfies MachinePluginDefinition;
