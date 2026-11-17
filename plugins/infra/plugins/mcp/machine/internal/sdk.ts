// The MCP SDK, loaded once per process rather than with the plugin.
//
// The SDK's server and client modules import its ajv validator statically
// (`validation/ajv-provider.js` → ajv + ajv-formats), and evaluating them is
// one synchronous block of the JS thread: ~0.28 s of CPU warm, 1–3 s from a
// checkout whose files are cold (a fresh main slot). An `exec` child and a
// worktree backend never answer an agent (agents' MCP points at main), so for
// them it loads the first time a request or the catalog does. Main's serving
// backend is asked by every running agent within seconds of a restart — right
// inside the window where every tab replays its subs — so it loads it before
// readiness instead (the machine barrel's `onReadyBlocking`), while
// the old backend still serves. Later callers share the same promise. The
// specifiers are literal, so a source digest still follows them.

let loaded: Promise<McpSdk> | null = null;

export interface McpSdk {
  McpServer: typeof import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
  WebStandardStreamableHTTPServerTransport: typeof import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js").WebStandardStreamableHTTPServerTransport;
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  InMemoryTransport: typeof import("@modelcontextprotocol/sdk/inMemory.js").InMemoryTransport;
}

export function mcpSdk(): Promise<McpSdk> {
  loaded ??= Promise.all([
    import("@modelcontextprotocol/sdk/server/mcp.js"),
    import("@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js"),
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/inMemory.js"),
  ]).then(([mcp, http, client, inMemory]) => ({
    McpServer: mcp.McpServer,
    WebStandardStreamableHTTPServerTransport:
      http.WebStandardStreamableHTTPServerTransport,
    Client: client.Client,
    InMemoryTransport: inMemory.InMemoryTransport,
  }));
  return loaded;
}
