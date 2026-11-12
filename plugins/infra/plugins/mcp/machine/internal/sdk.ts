// The MCP SDK, loaded on first use rather than with the plugin.
//
// The SDK's server and client modules import its ajv validator statically
// (`validation/ajv-provider.js` → ajv + ajv-formats), and evaluating them cost
// ~0.28 s of CPU on the main thread before a backend could serve — every boot,
// for a route only an agent calls and a catalog only the MCP settings pane
// reads. Nothing a tab waits on at boot needs it, so it loads the first time a
// request or the catalog does, once per process; later callers share the same
// promise. The specifiers are literal, so a source digest still follows them.

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
