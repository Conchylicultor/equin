import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  bodyMessages,
  hasInitialize,
  hasToolsList,
  renderInstructions,
} from "./instructions";
import { MCP_SERVER_NAME } from "../../core";
import type { McpTool, McpToolCallContext, McpToolContext } from "./mcp";
import { registry, scopeRegistry } from "./registry";
import { toolsInScope } from "./scope";

export async function handleMcpRequest(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const conversationId = params.conversationId;
  if (!conversationId) {
    return new Response("Missing conversationId", { status: 400 });
  }

  // The conversation's scope: a scratch profile sees exactly its allowlist;
  // everyone else every tool reserved for no profile.
  const ctx = { conversationId };
  const scope = scopeRegistry.resolver
    ? await scopeRegistry.resolver(ctx)
    : { kind: "default" as const };

  // Server instructions only ride the initialize result, so only initialize
  // pays for rendering them. A throwing contribution fails initialize loudly.
  // A profile-scoped conversation gets none: the sections describe this app
  // to its own agents, and a profile's agent carries only its profile's
  // context.
  const messages = await bodyMessages(req);
  const instructions =
    hasInitialize(messages) && scope.kind === "default"
      ? await renderInstructions(ctx)
      : undefined;
  // Live description sections likewise render only for the request that lists
  // the tools; a tool call never pays for them.
  const descriptions = hasToolsList(messages)
    ? await renderDescriptions({ conversationId })
    : null;

  const server = newMcpServer(instructions);

  // Per-conversation visibility: first the scope, then each tool's own `when`.
  // A tool either says no to is never registered on this request's server, so
  // it is absent from tools/list and a call to it is an unknown-tool error. The
  // gates run in parallel.
  const tools = toolsInScope(registry, scope);
  const visible = await Promise.all(
    tools.map(async (tool) => (tool.when ? tool.when(ctx) : true)),
  );

  for (const [i, tool] of tools.entries()) {
    if (!visible[i]) continue;
    mountTool(
      server,
      tool,
      descriptions?.get(tool.name) ?? tool.description,
      ctx,
    );
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    // eslint-disable-next-line detached-work-safety/no-untracked-detached-work -- trivial fire-and-forget I/O cleanup (closing the MCP server in finally)
    void server.close();
  }
}

/** The server every MCP request (and the catalog's listing) runs on. */
export function newMcpServer(instructions: string | undefined): McpServer {
  return new McpServer(
    { name: MCP_SERVER_NAME, version: "0.0.1" },
    { instructions },
  );
}

/** Registers one tool on a server, the one way both the request path and the
 * catalog's listing do, so the catalog lists exactly what agents receive. */
export function mountTool(
  server: McpServer,
  tool: McpTool,
  description: string,
  ctx: McpToolContext,
): void {
  server.registerTool(
    tool.name,
    { description, inputSchema: tool.inputSchema },
    async (args: Record<string, unknown>, extra: { _meta?: unknown }) => {
      const callCtx: McpToolCallContext = {
        ...ctx,
        toolUseId: toolUseIdOf(extra._meta),
      };
      const result = await tool.handler(args, callCtx);
      return result;
    },
  );
}

/** Where Claude Code names the tool call a `tools/call` request answers. */
const TOOL_USE_ID_META = "claudecode/toolUseId";

/** The request's tool-use id, when its client sent one. */
function toolUseIdOf(meta: unknown): string | null {
  if (typeof meta !== "object" || meta === null) return null;
  const id = (meta as Record<string, unknown>)[TOOL_USE_ID_META];
  return typeof id === "string" && id !== "" ? id : null;
}

/**
 * Every tool's description with its live section appended — keyed by tool
 * name, for the tools that declare one. Rendered in parallel; a throwing
 * render rejects the listing.
 */
async function renderDescriptions(
  ctx: McpToolContext,
): Promise<Map<string, string>> {
  const live = [...registry.values()].filter(
    (t): t is McpTool & Required<Pick<McpTool, "liveDescription">> =>
      t.liveDescription !== undefined,
  );
  const sections = await Promise.all(live.map((t) => t.liveDescription(ctx)));
  const out = new Map<string, string>();
  live.forEach((tool, i) => {
    const section = sections[i];
    if (section !== null && section !== undefined && section.trim() !== "") {
      out.set(tool.name, `${tool.description}\n\n${section}`);
    }
  });
  return out;
}
