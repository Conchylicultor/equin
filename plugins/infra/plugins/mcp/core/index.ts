// Web-safe: the catalog of what the MCP server hosts (Debug → MCP tools), and
// the MCP endpoint's contract (whoever hands an agent its MCP URL builds it
// from this route). Contributing a tool or the scope is `server/`.
export { mcpRequest } from "./internal/endpoints";
export {
  MCP_SERVER_NAME,
  McpCatalogSchema,
  McpCatalogToolSchema,
  agentToolName,
  mcpCatalog,
} from "./internal/catalog";
export {
  MCP_HEALTH_MAX_DEGRADED,
  McpDegradedSchema,
  McpHealthSchema,
  mcpHealth,
} from "./internal/health";
export type { McpDegraded, McpHealth } from "./internal/health";
export type { McpCatalog, McpCatalogTool } from "./internal/catalog";
