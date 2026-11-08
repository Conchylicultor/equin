import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { gatewayPanicKind } from "./internal/gateway-panic-kind";

export default {
  description:
    "The gateway-panic report kind — filed by the gateway through the report outbox when one of its request handlers panics (recovered: the request gets a 500), coalesced per panic site, drained by main: where it panicked, the value, the stack, the request it was serving and how many times.",
  contributions: [gatewayPanicKind],
} satisfies ServerPluginDefinition;
