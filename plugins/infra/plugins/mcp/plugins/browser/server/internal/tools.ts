import {
  Mcp,
  type McpToolCallContext,
} from "@plugins/infra/plugins/mcp/server";
import { RECORDED_BROWSER_TOOLS } from "@plugins/debug/plugins/browser-recordings/core";
import { browserToolSpecs } from "../../shared/tools";
import { callHostTool } from "./host-client";
import { recordedCall } from "./record-call";
import { resolveTarget } from "./target";

for (const name of RECORDED_BROWSER_TOOLS)
  if (!(name in browserToolSpecs))
    throw new Error(
      `browser-recordings records "${name}", which is not a browser tool`,
    );

/**
 * The agent browser's MCP tools, as this backend registers them: each one of
 * `shared/tools.ts`, forwarded to the machine's host process. The target is
 * resolved here — it is a database read, and the host has no database. A
 * page-changing call is recorded under the agent's tool call (when the client
 * named it), so the conversation shows its frame under the call.
 */
function forward(tool: string) {
  return async (args: unknown, ctx: McpToolCallContext) => {
    const call = {
      conversationId: ctx.conversationId,
      target: await resolveTarget(ctx.conversationId),
      tool,
      args,
    };
    return ctx.toolUseId !== null && RECORDED_BROWSER_TOOLS.has(tool)
      ? recordedCall(call, ctx.toolUseId)
      : callHostTool(call);
  };
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
