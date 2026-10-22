import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { pageTransport } from "./page-transport";

export default {
  description:
    "pageTransport: the page's own server as a Transport (same-origin SharedWebSocket, the global fetch, plain asset paths, machine, its telemetry reported). The app root mounts it; every other importer is a sanctioned exemption of networking/no-page-transport (page-wide telemetry, boot).",
  contributions: [],
} satisfies PluginDefinition;
