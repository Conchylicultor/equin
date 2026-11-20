import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { BoxSignal, type BoxSignalSpec } from "./internal/signal";

export default {
  description:
    "Ships on the deployed box: the BoxSignal contribution kind ({ source, subscribe(emit) }) — the signal sources a box's link stream relays, collected generically (site-mirror/box contributes the table-mirror one). Its machine half serves the stream. Imported by site-mirror/box, so it ships wherever a mirror set does.",
} satisfies ServerPluginDefinition;
