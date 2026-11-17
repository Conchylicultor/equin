import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { usePagePort } from "./internal/use-page-port";

export default {
  description:
    "This account's gateway port — the first free one of 8700…8709, chosen once and kept (8700 by default; 9000 before), recorded in state/gateway-port/port.json once a gateway answers on it. Web half: usePagePort() — the page's own port (it is always served by the gateway it talks to), read while rendering through render-mode. Every runtime reads its own authority: servedGatewayPort (core, a process a gateway started), gatewayPortSync (data-dirs, the CLI), resolveGatewayPort (machine), `./equin url` (shell).",
  contributions: [],
} satisfies PluginDefinition;
