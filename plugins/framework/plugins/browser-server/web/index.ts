import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { browserServerTransport } from "./browser-server-transport";

export default {
  description:
    "A server that runs in the page's realm or across a worker's port — a third host of the unified live API (core: the BrowserServer interface; runtimeBrowserServer over a resource runtime booted in this realm; serveOverPort / portBrowserServer carrying one across a MessageChannel or a Web Worker). Web: browserServerTransport(server, { telemetry }), the Transport a <TransportProvider> points a subtree at — in-memory sockets to its runtime, requests through its router, an inert central socket.",
  contributions: [],
} satisfies PluginDefinition;
