import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  bodyMessages,
  hasInitialize,
  hasToolsList,
  renderInstructions,
} from "./instructions";
import type { McpTool, McpToolContext } from "./mcp";
import { registry } from "./registry";

export async function handleMcpRequest(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const conversationId = params.conversationId;
  if (!conversationId) {
    return new Response("Missing conversationId", { status: 400 });
  }

  // Server instructions only ride the initialize result, so only initialize
  // pays for rendering them. A throwing contribution fails initialize loudly.
  const messages = await bodyMessages(req);
  const instructions = hasInitialize(messages)
    ? await renderInstructions({ conversationId })
    : undefined;
  // Live description sections likewise render only for the request that lists
  // the tools; a tool call never pays for them.
  const descriptions = hasToolsList(messages)
    ? await renderDescriptions({ conversationId })
    : null;

  const server = new McpServer(
    {
      name: "equin",
      version: "0.0.1",
    },
    { instructions },
  );

  // Per-conversation visibility: a tool whose `when` says no is never
  // registered on this request's server, so it is absent from tools/list and
  // a call to it is an unknown-tool error. The gates run in parallel.
  const ctx = { conversationId };
  const tools = [...registry.values()];
  const visible = await Promise.all(
    tools.map(async (tool) => (tool.when ? tool.when(ctx) : true)),
  );

  for (const [i, tool] of tools.entries()) {
    if (!visible[i]) continue;
    server.registerTool(
      tool.name,
      {
        description: descriptions?.get(tool.name) ?? tool.description,
        inputSchema: tool.inputSchema,
      },
      async (args: Record<string, unknown>) => {
        const result = await tool.handler(args, ctx);
        return result;
      },
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
