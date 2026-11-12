import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { browserServerTransport } from "./browser-server-transport";
export { attachFrameServing } from "./frame-serving";
export type { FrameServing } from "./frame-serving";
export { hostBootReportSink } from "./host-boot-sink";
export type { HostBootInfo } from "./host-boot-sink";
import {
  ExternalHosts as ExternalHostsSlots,
  HostInputs as HostInputsSlots,
} from "./slots";
export { ExternalHosts, HostInputs } from "./slots";
export type { ExternalHostsDeclaration, HostInputSupply } from "./slots";

export default {
  description:
    "A server that runs in the page's realm or across a worker's port — a third host of the unified live API (core: the BrowserServer interface; runtimeBrowserServer over a resource runtime booted in this realm; serveOverPort / portBrowserServer carrying one across a MessageChannel or a Web Worker). Web: browserServerTransport(server, { telemetry, frameBase }), the Transport a <TransportProvider> points a subtree at — in-memory sockets to its runtime, requests through its router, an inert central socket; attachFrameServing(worker, serviceWorkerUrl) serves the server's frame documents by URL through the host's frame-serving Service Worker (frames-sw.ts), giving the transport its frameBase. HostInputs.Supply: a plugin declares a value of the page's own server the page may hand a browser host (a page input). ExternalHosts.Declare: the third-party hosts a plugin's code loads from in the page, read statically into each browser host's externalHosts.",
  slots: { ...HostInputsSlots, ...ExternalHostsSlots },
  contributions: [],
} satisfies PluginDefinition;
