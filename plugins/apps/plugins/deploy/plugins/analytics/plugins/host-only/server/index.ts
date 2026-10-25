import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { hostOnly, requestClientIp } from "./internal/forwarded";
export { capBodySize } from "./internal/body-size";
export { isBotUserAgent } from "./internal/bot-user-agent";

export default {
  description:
    "The guards of a deployed site's routes: hostOnly(handler) 404s a /api/host-only/ route unless the request made exactly the gateway's own proxy hop (it came from the box); requestClientIp(req) reads the visitor address Caddy wrote into X-Forwarded-For; capBodySize(maxBytes, handler) refuses a public body over its declared length before it is read; isBotUserAgent(ua) names crawlers and HTTP libraries.",
} satisfies ServerPluginDefinition;
