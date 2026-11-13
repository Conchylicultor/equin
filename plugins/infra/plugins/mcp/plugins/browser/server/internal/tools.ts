import { Mcp, type McpCallerContext } from "@plugins/infra/plugins/mcp/server";
import { MCP_UNATTACHED_ID } from "@plugins/infra/plugins/mcp/core";
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
 *
 * Also served to a session equin did not launch (`unattached`): it browses
 * under one shared session, keyed `MCP_UNATTACHED_ID` (closed when idle like
 * any other), its routes land on main, and nothing is recorded — a recording
 * is shown under a conversation's tool call, and there is none.
 */
function forward(tool: string) {
  return async (args: unknown, ctx: McpCallerContext) => {
    const call = {
      conversationId: ctx.conversationId ?? MCP_UNATTACHED_ID,
      target: await resolveTarget(ctx.conversationId),
      tool,
      args,
    };
    return ctx.conversationId !== null &&
      ctx.toolUseId !== null &&
      RECORDED_BROWSER_TOOLS.has(tool)
      ? recordedCall(call, ctx.toolUseId)
      : callHostTool(call);
  };
}

export const browserTools = Object.entries(browserToolSpecs).map(
  ([name, spec]) =>
    Mcp.tool({
      name,
      unattached: true,
      description: spec.description,
      inputSchema: spec.inputSchema,
      handler: forward(name),
    }),
);
