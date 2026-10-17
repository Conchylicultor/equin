import type { McpInstructions, McpScopeResolver, McpTool } from "./mcp";

export const registry = new Map<string, McpTool>();

/**
 * Where each contribution was declared — the plugin whose `register` array
 * held its token (`registeringPlugin()`), `null` for one registered by hand
 * outside the register phase (a test). Keyed like the registry it annotates;
 * read only by the catalog (Debug → MCP tools).
 */
export const toolDeclaredIn = new Map<string, string | null>();
export const instructionsDeclaredIn = new Map<string, string | null>();

/** `Mcp.instructions` contributions, keyed by id. */
export const instructionsRegistry = new Map<string, McpInstructions>();

/** The one `Mcp.scope` resolver, when a plugin registered it. */
export const scopeRegistry: {
  resolver: McpScopeResolver | null;
  declaredIn: string | null;
} = {
  resolver: null,
  declaredIn: null,
};
