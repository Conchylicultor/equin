import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export { pagePrincipal, recordPagePrincipal } from "./internal/page-principal";
export type { PagePrincipal } from "./internal/page-principal";

export default {
  description:
    "Who a request is: the principal the gateway stamps on every proxied request (X-Equin-Principal), read fail-closed by principalOf; EndpointAccess (owner by default; { public } / { visitor } / { content } opt-ins); gateByPrincipal, the socket hosts' per-route gate. Web half: who the page's own server takes this page for (owner | visitor), recorded once by the page's boot snapshot — pagePrincipal() / recordPagePrincipal().",
  contributions: [],
} satisfies PluginDefinition;
