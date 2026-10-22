import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { implement, rawEndpointHandler, HttpError } from "../core/implement";
export { callEndpoint } from "./internal/call-endpoint";

export default {
  portable: true,
  description:
    "Typed endpoint contract primitive. defineEndpoint declares the contract; implement() creates the server handler; callEndpoint() calls one from off the page (a backend, the CLI) through its contract; useFetchEndpoint/useEndpoint consume on the client.",
  loadBearing: true,
} satisfies ServerPluginDefinition;
