// Web-safe: the catalog of what the MCP server hosts (Debug → MCP tools).
// Contributing a tool, instructions or the scope is `server/`.
export {
  MCP_SERVER_NAME,
  McpCatalogInstructionsSchema,
  McpCatalogSchema,
  McpCatalogToolSchema,
  agentToolName,
  mcpCatalog,
} from "./internal/catalog";
export type {
  McpCatalog,
  McpCatalogInstructions,
  McpCatalogTool,
} from "./internal/catalog";
