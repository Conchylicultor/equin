import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serveValue } from "@plugins/network/plugins/live/server";
import { mcpCatalog, type McpCatalog } from "../../core";
import { mountTool, newMcpServer } from "./handle-mcp";
import {
  instructionsDeclaredIn,
  instructionsRegistry,
  registry,
  scopeRegistry,
  toolDeclaredIn,
} from "./registry";

/** Nothing reaches a handler from the catalog's listing; this only fills the
 * context argument `mountTool` binds. */
const CATALOG_CTX = { conversationId: "(catalog)" };

/**
 * Every registered tool's input schema as `tools/list` sends it, keyed by
 * name. Read off a real listing — every tool mounted on a server the way a
 * request mounts it, listed over an in-memory client — so the schema shown is
 * the SDK's own conversion, never a second one that could drift from it.
 */
async function listedInputSchemas(): Promise<
  Map<string, Record<string, unknown>>
> {
  const server = newMcpServer(undefined);
  for (const tool of registry.values()) {
    mountTool(server, tool, tool.description, CATALOG_CTX);
  }
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-catalog", version: "0.0.1" });
  await server.connect(serverSide);
  try {
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    return new Map(tools.map((t) => [t.name, t.inputSchema]));
  } finally {
    await client.close();
    await server.close();
  }
}

async function loadCatalog(): Promise<McpCatalog> {
  const schemas = await listedInputSchemas();
  return {
    tools: [...registry.values()]
      .map((tool) => {
        const inputSchema = schemas.get(tool.name);
        if (inputSchema === undefined) {
          throw new Error(
            `MCP tool "${tool.name}" is registered but missing from tools/list`,
          );
        }
        return {
          name: tool.name,
          declaredIn: toolDeclaredIn.get(tool.name) ?? null,
          description: tool.description,
          hasLiveDescription: tool.liveDescription !== undefined,
          gated: tool.when !== undefined,
          profiles: tool.profiles ? [...tool.profiles] : null,
          inputSchema,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name)),
    instructions: [...instructionsRegistry.keys()].sort().map((id) => ({
      id,
      declaredIn: instructionsDeclaredIn.get(id) ?? null,
    })),
    scope: scopeRegistry.resolver
      ? { declaredIn: scopeRegistry.declaredIn }
      : null,
  };
}

/** The catalog, served. Contributions only register at boot, so it is fixed
 * for the process. */
export const mcpCatalogServed = serveValue(mcpCatalog, {
  source: "external",
  changes: { fixed: { reason: "MCP contributions register only at boot" } },
  loader: loadCatalog,
});
