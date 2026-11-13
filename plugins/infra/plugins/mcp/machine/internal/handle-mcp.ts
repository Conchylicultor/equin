import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { bodyMessages, hasToolsList } from "./messages";
import { MCP_SERVER_NAME, MCP_UNATTACHED_ID } from "../../core";
import { runContribution } from "./isolate";
import type {
  McpConversationTool,
  McpTool,
  McpToolContext,
  McpToolResult,
} from "../../server";
import { recordMcpRequest } from "./health";
import { registry, scopeRegistry } from "../../server/internal/registry";
import { toolsInScope } from "./scope";
import { mcpSdk, type McpSdk } from "./sdk";

/**
 * The MCP route: answers one request, and records its outcome for the health
 * value (`mcp.health`) — a throw or a 5xx is the server failing its agents.
 * The throw is rethrown: recording it never absorbs it.
 */
export async function handleMcpRequest(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  let res: Response;
  try {
    res = await answerMcpRequest(req, params);
  } catch (err) {
    recordMcpRequest({
      ok: false,
      message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  recordMcpRequest(
    res.status >= 500
      ? { ok: false, message: `Answered HTTP ${res.status}` }
      : { ok: true },
  );
  return res;
}

async function answerMcpRequest(
  req: Request,
  params: Record<string, string>,
): Promise<Response> {
  const conversationId = params.conversationId;
  if (!conversationId) {
    return new Response("Missing conversationId", { status: 400 });
  }
  const caller: McpCaller =
    conversationId === MCP_UNATTACHED_ID
      ? { kind: "unattached" }
      : { kind: "conversation", conversationId };

  const messages = await bodyMessages(req);
  const sdk = await mcpSdk();
  const server = newMcpServer(sdk);

  const mounted =
    caller.kind === "unattached"
      ? unattachedTools()
      : await conversationTools(caller.conversationId, messages);
  for (const { tool, description } of mounted) {
    mountTool(server, tool, description, caller);
  }

  const transport = new sdk.WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  await server.connect(transport);
  try {
    return await transport.handleRequest(req);
  } finally {
    void server.close();
  }
}

/**
 * Who a request is for: a conversation equin launched, or a session it did not
 * (`MCP_UNATTACHED_ID` — a `claude` started in a terminal).
 */
export type McpCaller =
  { kind: "conversation"; conversationId: string } | { kind: "unattached" };

interface MountedTool {
  tool: McpTool;
  description: string;
}

/**
 * An unattached session's tools: exactly those declared `unattached: true`.
 * No scope resolver, gate or live description runs — each is a function of a
 * conversation, and an unattached tool may declare none of them.
 */
function unattachedTools(): MountedTool[] {
  return [...registry.values()]
    .filter((tool) => tool.unattached === true)
    .map((tool) => ({ tool, description: tool.description }));
}

/** A conversation's tools: its scope, then each tool's own `when`. */
async function conversationTools(
  conversationId: string,
  messages: readonly unknown[],
): Promise<MountedTool[]> {
  // The conversation's scope: a scratch profile sees exactly its allowlist;
  // everyone else every tool reserved for no profile.
  const ctx = { conversationId };
  const scope = scopeRegistry.resolver
    ? await scopeRegistry.resolver(ctx)
    : { kind: "default" as const };

  // Live description sections likewise render only for the request that lists
  // the tools; a tool call never pays for them.
  const descriptions = hasToolsList(messages)
    ? await renderDescriptions(ctx)
    : null;

  // Per-conversation visibility: first the scope, then each tool's own `when`.
  // A tool either says no to is never registered on this request's server, so
  // it is absent from tools/list and a call to it is an unknown-tool error. The
  // gates run in parallel. A gate that throws hides only its own tool (fail
  // closed) and is reported; every other tool is unaffected.
  const tools = toolsInScope(registry, scope);
  const visible = await Promise.all(
    tools.map(async (tool) => {
      const when = tool.when;
      if (!when) return true;
      const outcome = await runContribution(`tool "${tool.name}" when`, () =>
        when(ctx),
      );
      return outcome.ok && outcome.value;
    }),
  );
  return tools
    .filter((_, i) => visible[i])
    .map((tool) => ({
      tool,
      description: descriptions?.get(tool.name) ?? tool.description,
    }));
}

/**
 * The server every MCP request (and the catalog's listing) runs on. It sends
 * no server instructions: Claude Code cuts them at 4,096 characters, silently.
 * How to use a tool belongs in its description; context about the agent and
 * its task is a `SystemPrompt.Section` (conversations/system-prompt).
 */
export function newMcpServer(sdk: McpSdk): McpServer {
  return new sdk.McpServer({ name: MCP_SERVER_NAME, version: "0.0.1" });
}

/** Registers one tool on a server, the one way both the request path and the
 * catalog's listing do, so the catalog lists exactly what agents receive. */
export function mountTool(
  server: McpServer,
  tool: McpTool,
  description: string,
  caller: McpCaller,
): void {
  // The request path mounts only `unattached: true` tools for an unattached
  // caller; reaching this is a bug in it, never an agent's doing.
  if (caller.kind === "unattached" && tool.unattached !== true) {
    throw new Error(
      `MCP tool "${tool.name}" needs a conversation, but was mounted for an unattached session`,
    );
  }
  server.registerTool(
    tool.name,
    { description, inputSchema: tool.inputSchema },
    (args: Record<string, unknown>, extra: { _meta?: unknown }) =>
      callTool(tool, args, caller, toolUseIdOf(extra._meta)),
  );
}

/** Runs one tool's handler with the context its kind declares. */
async function callTool(
  tool: McpTool,
  args: Record<string, unknown>,
  caller: McpCaller,
  toolUseId: string | null,
): Promise<McpToolResult> {
  if (tool.unattached === true) {
    const conversationId =
      caller.kind === "conversation" ? caller.conversationId : null;
    return await tool.handler(args, { conversationId, toolUseId });
  }
  if (caller.kind === "unattached") {
    throw new Error(
      `MCP tool "${tool.name}" needs a conversation, but was called by an unattached session`,
    );
  }
  return await tool.handler(args, {
    conversationId: caller.conversationId,
    toolUseId,
  });
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
 * render fails only its own tool's section — reported, and the tool listed
 * with a notice that its live section is missing.
 */
async function renderDescriptions(
  ctx: McpToolContext,
): Promise<Map<string, string>> {
  const live = [...registry.values()].filter(
    (
      t,
    ): t is McpConversationTool &
      Required<Pick<McpConversationTool, "liveDescription">> =>
      t.liveDescription !== undefined,
  );
  const sections = await Promise.all(
    live.map(async (t) => {
      const outcome = await runContribution(
        `tool "${t.name}" live description`,
        () => t.liveDescription(ctx),
      );
      return outcome.ok
        ? outcome.value
        : `(This tool's live section failed to render (${outcome.message}) and has been reported.)`;
    }),
  );
  const out = new Map<string, string>();
  live.forEach((tool, i) => {
    const section = sections[i];
    if (section !== null && section !== undefined && section.trim() !== "") {
      out.set(tool.name, `${tool.description}\n\n${section}`);
    }
  });
  return out;
}
