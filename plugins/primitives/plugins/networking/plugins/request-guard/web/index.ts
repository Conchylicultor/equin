import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  RawApiRequestError,
  requestGuardReportSink,
  installRequestGuard,
  allowAssetRoute,
  nativeFetch,
  nativeWebSocket,
} from "./guard";
export type { GuardedChannel } from "./guard";

export default {
  description:
    "The page request guard: installRequestGuard (once, first thing in the app entry) refuses every same-origin /api, /ws and /gateway request page code issues by a raw channel — fetch, XMLHttpRequest, sendBeacon, EventSource, WebSocket — with a RawApiRequestError (fetch rejects, the rest throw), each also logged and filed through requestGuardReportSink (held until the crash collector registers). The app's own channels hold a capability instead: nativeFetch (the page transport) and nativeWebSocket (the per-tab socket), falling back to the globals at call time when no guard is installed; GET / HEAD of the asset routes allowAssetRoute registers pass. Importing the capability is bounded by networking/no-request-guard-capability.",
  contributions: [],
} satisfies PluginDefinition;
