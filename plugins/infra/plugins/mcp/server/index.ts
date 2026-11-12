import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { Mcp } from "./internal/mcp";
export type {
  McpScope,
  McpScopeResolver,
  McpTool,
  McpToolCallContext,
  McpToolContext,
  McpToolResult,
} from "./internal/mcp";

export default {
  description:
    "The MCP contribution API, SDK-free: Mcp.tool / Mcp.scope register a tool or THE scope resolver (no server instructions: context about an agent is a conversations/system-prompt section) into the in-process registry the desktop half (machine/) serves over HTTP — so a plugin contributing to the MCP server stays portable.",
} satisfies ServerPluginDefinition;
