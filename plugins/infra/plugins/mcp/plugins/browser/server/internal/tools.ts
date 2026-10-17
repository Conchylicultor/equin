import { Mcp, type McpToolContext } from "@plugins/infra/plugins/mcp/server";
import { browserToolSpecs } from "../../shared/tools";
import { callHostTool } from "./host-client";
import { resolveTarget } from "./target";

/**
 * The agent browser's MCP tools, as this backend registers them: each one of
 * `shared/tools.ts`, forwarded to the machine's host process. The target is
 * resolved here — it is a database read, and the host has no database.
 */
function forward(tool: string) {
  return async (args: unknown, ctx: McpToolContext) =>
    callHostTool({
      conversationId: ctx.conversationId,
      target: await resolveTarget(ctx.conversationId),
      tool,
      args,
    });
}

export const browserTools = Object.entries(browserToolSpecs).map(
  ([name, spec]) =>
    Mcp.tool({
      name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      handler: forward(name),
    }),
);
