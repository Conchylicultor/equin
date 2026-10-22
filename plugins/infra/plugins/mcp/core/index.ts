// Web-safe: the catalog of what the MCP server hosts (Debug → MCP tools), and
// the MCP endpoint's contract (whoever hands an agent its MCP URL builds it
// from this route). Contributing a tool, instructions or the scope is `server/`.
export { mcpRequest } from "./internal/endpoints";
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
