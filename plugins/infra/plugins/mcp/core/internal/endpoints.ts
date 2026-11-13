import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";

export const mcpRequest = defineEndpoint({
  route: "POST /api/mcp/:conversationId",
  internal: { why: "MCP transport used by agent sessions, never the browser" },
  needsMachine: { feature: "The MCP server" },
});

/**
 * The `:conversationId` of a session equin did not launch — a `claude` started
 * in a terminal, say, to recover a broken main. `.mcp.json` falls back to it
 * when `EQUIN_CONVERSATION_ID` is unset (pinned by the `mcp:mcp-json-in-sync`
 * check). Such a request is served only the tools declared `unattached: true`.
 * It cannot name a conversation: their ids are `conv-…` (legacy `claude-…`).
 */
export const MCP_UNATTACHED_ID = "unattached";
