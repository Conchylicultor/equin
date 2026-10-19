import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { implement, HttpError } from "../core/implement";

export default {
  portable: true,
  description:
    "Typed endpoint contract primitive. defineEndpoint declares the contract; implement() creates the server handler; fetchEndpoint/useEndpoint consume on the client.",
  loadBearing: true,
} satisfies ServerPluginDefinition;
