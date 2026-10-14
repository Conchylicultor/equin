import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { browserServerTransport } from "./browser-server-transport";

export default {
  description:
    "A server that runs in the page — a third host of the unified live API (core: createBrowserServer serves liveValue / liveCollection declarations on a real resource runtime through serveValueOn / serveCollectionOn, routes requests through the shared http-router, and fails every other known resource key as loader-failed). Web: browserServerTransport(server), the Transport a <TransportProvider> points a subtree at — in-memory sockets to its runtime, requests through its router, an inert central socket.",
  contributions: [],
} satisfies PluginDefinition;
