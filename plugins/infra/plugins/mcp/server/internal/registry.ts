import type { McpInstructions, McpScopeResolver, McpTool } from "./mcp";

export const registry = new Map<string, McpTool>();

/** `Mcp.instructions` contributions, keyed by id. */
export const instructionsRegistry = new Map<string, McpInstructions>();

/** The one `Mcp.scope` resolver, when a plugin registered it. */
export const scopeRegistry: { resolver: McpScopeResolver | null } = {
  resolver: null,
};
