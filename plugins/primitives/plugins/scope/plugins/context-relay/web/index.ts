import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  RelayCapture,
  RelayProvide,
  createRelayLink,
  relayOf,
  type Relayed,
  type RelayLink,
} from "./internal/context-relay";

export default {
  description:
    "Re-provides React contexts captured in one place of the tree in another: the bridge between state hosted away from its view (a playback instance raised at the page's render origin, outliving the view) and the view that attaches to it. An owner mints a Relayed token for its context (relayOf — the context object itself stays private); <RelayCapture link relays> reads each where the state lives and publishes the values to a RelayLink (createRelayLink); <RelayProvide link fallback> provides them again around the view, following every change, and shows `fallback` until the first capture.",
  contributions: [],
} satisfies PluginDefinition;
